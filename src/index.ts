import express from 'express';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { runCliJson, runCliText, getMyPositions } from './core/dex';
import { calcApr, calcScore, SORT_FN } from './core/position';
import { cleanOutOfRange, rebalance } from './core/rebalance';
import { rechargeTokens } from './core/swap';

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-jwt-key';

app.use(cors());
app.use(express.json());

// ==========================================
// 1. Auth & Config API (웹/앱 개입)
// ==========================================

// 지갑 인증용 Nonce 발급
app.post('/api/auth/nonce', async (req, res) => {
  const { walletAddress } = req.body;
  if (!walletAddress) {
    return res.status(400).json({ error: 'walletAddress is required' });
  }

  const nonce = crypto.randomUUID();
  let user = await prisma.user.findUnique({ where: { walletAddress } });

  if (user) {
    user = await prisma.user.update({
      where: { walletAddress },
      data: { nonce }
    });
  } else {
    user = await prisma.user.create({
      data: {
        walletAddress,
        nonce,
        config: {
          create: {} // Default config
        }
      }
    });
  }

  res.json({ nonce: user.nonce });
});

// 서명 검증 및 JWT 발급
app.post('/api/auth/login', async (req, res) => {
  const { walletAddress, signature } = req.body;
  
  const user = await prisma.user.findUnique({ where: { walletAddress } });
  if (!user) return res.status(404).json({ error: 'User not found' });

  try {
    const messageBytes = new TextEncoder().encode(`Sign this message to authenticate dashboard: ${user.nonce}`);
    const signatureBytes = bs58.decode(signature);
    const publicKeyBytes = bs58.decode(walletAddress);

    const isValid = nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
  } catch (err) {
    return res.status(400).json({ error: 'Signature format is invalid' });
  }

  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token });
});

// 미들웨어: JWT 검증
function authenticate(req: any, res: any, next: any) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  jwt.verify(token, JWT_SECRET, (err: any, decoded: any) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.userId = decoded.userId;
    next();
  });
}

// 봇 설정 조회
app.get('/api/config', authenticate, async (req: any, res: any) => {
  const config = await prisma.userConfig.findUnique({
    where: { userId: req.userId }
  });
  res.json({ config });
});

// 봇 설정 변경
app.post('/api/config', authenticate, async (req: any, res: any) => {
  const { topN, copyAmountUsd, minAprPercent, intervalMs, pools, autoRechargeTokens } = req.body;
  
  const sanitizeArr = (val: any) => {
    let arr = [];
    if (typeof val === "string") {
      try { arr = JSON.parse(val); } catch { arr = []; }
    } else if (Array.isArray(val)) {
      arr = val;
    }
    return arr.filter((x: any) => typeof x === 'string' && x !== "[" && x !== "]");
  };

  const updated = await prisma.userConfig.update({
    where: { userId: req.userId },
    data: {
      ...(topN !== undefined && { topN }),
      ...(copyAmountUsd !== undefined && { copyAmountUsd }),
      ...(minAprPercent !== undefined && { minAprPercent }),
      ...(intervalMs !== undefined && { intervalMs }),
      ...(pools !== undefined && { pools: sanitizeArr(pools) }),
      ...(autoRechargeTokens !== undefined && { autoRechargeTokens: sanitizeArr(autoRechargeTokens) }),
    }
  });
  
  res.json({ success: true, config: updated });
});


// ==========================================
// 2. Bot Background Engine (멀티 유저)
// ==========================================
async function runBotTask() {
  console.log('── 🤖 [BOT Engine] Cycle Started ──');
  try {
    const users = await prisma.user.findMany({
      include: { config: true }
    });

    for (const user of users) {
      if (!user.config) continue;
      const config = user.config;
      console.log(`│ [User] Processing ${user.walletAddress}...`);

      try {
        // 1. 사전 자산 체크 및 충전
        await rechargeTokens(config);

        // 2. 가용한 모든 타겟 풀의 포지션 수집
        const poolsArr = config.pools as string[];
        const allCandidates: any[] = [];

        for (const poolAddr of poolsArr) {
          try {
            // 풀 가격 및 상위 포지션 조회
            const poolInfo = runCliJson(`pools info ${poolAddr}`);
            const currentPrice = parseFloat(poolInfo?.data?.pool?.current_price || 0);
            
            const data = runCliJson(`positions top-positions --pool ${poolAddr}`);
            const positions = (data?.data?.positions ?? []).filter((p: any) => {
              if (config.requireInRange && !p.inRange) return false;
              return calcApr(p) >= config.minAprPercent;
            });

            positions.forEach((p: any) => {
              p._currentPrice = currentPrice;
              p._apr = calcApr(p);
            });
            allCandidates.push(...positions);
          } catch (e) {}
        }

        // 3. 점수 기반 정렬
        const sortMode = config.sortBy as string;
        allCandidates.sort(SORT_FN[sortMode] || SORT_FN.score);

        // 4. 신규 포지션 복사 시도
        const flag = config.dryRun ? "--dry-run" : "--confirm";
        const targetNumber = config.topN;
        const toCopy = allCandidates.slice(0, targetNumber);

        for (const pos of toCopy) {
          try {
            runCliText(`positions copy --position ${pos.positionAddress} --amount-usd ${config.copyAmountUsd} ${flag}`);
          } catch (e) {}
        }

        // 5. 내 포지션 관리 (Out-of-range & Rebalance)
        const myList = getMyPositions();
        await cleanOutOfRange(myList, config);
        await rebalance(myList, allCandidates, config);

      } catch (userErr) {
        console.error(`│ ❌ [User] ${user.walletAddress} failed:`, userErr);
      }
    }
  } catch (error) {
    console.error('── ❌ [BOT Engine] Global Error:', error);
  }
  console.log('── 🤖 [BOT Engine] Cycle Finished ──');
}

// 1분(60000ms)마다 백그라운드 스케줄러 실행 (예시)
setInterval(runBotTask, 60 * 1000);


app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  runBotTask(); // 서버 켜질 때 즉시 1회 실행
});
