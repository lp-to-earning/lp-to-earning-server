import express from 'express';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

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
  const { topN, copyAmountUsd, minAprPercent, intervalMs } = req.body;
  
  const updated = await prisma.userConfig.update({
    where: { userId: req.userId },
    data: {
      ...(topN !== undefined && { topN }),
      ...(copyAmountUsd !== undefined && { copyAmountUsd }),
      ...(minAprPercent !== undefined && { minAprPercent }),
      ...(intervalMs !== undefined && { intervalMs }),
    }
  });
  
  res.json({ success: true, config: updated });
});


// ==========================================
// 2. Bot Background Engine (멀티 유저)
// ==========================================
async function runBotTask() {
  console.log('[BOT Engine] Running background check...');
  try {
    const users = await prisma.user.findMany({
      include: { config: true }
    });

    for (const user of users) {
      if (!user.config) continue;
      
      const config = user.config;
      console.log(`[BOT Engine] Processing user: ${user.walletAddress}`);
      // TODO: config를 바탕으로 실제 Copy Trade 등 로직 실행
      // e.g. checkTargetPools(config) -> if conditions met -> executeTrade(wallet, config)
    }
  } catch (error) {
    console.error('[BOT Engine] Error:', error);
  }
}

// 1분(60000ms)마다 백그라운드 스케줄러 실행 (예시)
setInterval(runBotTask, 60 * 1000);


app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  runBotTask(); // 서버 켜질 때 즉시 1회 실행
});
