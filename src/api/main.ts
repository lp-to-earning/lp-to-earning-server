import { Router } from "express";
import { prisma } from "../lib/db";
import { authenticate, AuthRequest } from "../middleware/auth";
import { runCliJson, getMyPositions } from "../core/dex";
import { calcApr, calcScore } from "../core/position";
import { encrypt } from "../lib/crypto";

const router = Router();

// ==========================================
// 1. 개인키 보안 등록
// ==========================================
router.post("/private-key", authenticate, async (req: AuthRequest, res) => {
  const { privateKey } = req.body;
  if (!privateKey) return res.status(400).json({ error: "Private key is required" });

  try {
    // 즉시 암호화
    const { encrypted, iv, authTag } = encrypt(privateKey);

    await prisma.user.update({
      where: { id: req.userId },
      data: {
        encryptedPrivateKey: encrypted,
        iv,
        authTag,
      },
    });

    res.json({ success: true, message: "Private key encrypted and saved securely." });
  } catch (e: any) {
    res.status(500).json({ success: false, error: "Encryption failed." });
  }
});

// ==========================================
// 1. Config 관리
// ==========================================

// 봇 설정 조회
router.get("/config", authenticate, async (req: AuthRequest, res) => {
  const config = await prisma.userConfig.findUnique({
    where: { userId: req.userId },
  });
  res.json({ config });
});

// 봇 설정 변경
router.post("/config", authenticate, async (req: AuthRequest, res) => {
  const { topN, copyAmountUsd, minAprPercent, intervalMs, pools, autoRechargeTokens } = req.body;

  const sanitizeArr = (val: any) => {
    let arr = [];
    if (typeof val === "string") {
      try { arr = JSON.parse(val); } catch { arr = []; }
    } else if (Array.isArray(val)) {
      arr = val;
    }
    return arr.filter((x: any) => typeof x === "string" && x !== "[" && x !== "]");
  };

  const updated = await prisma.userConfig.update({
    where: { userId: req.userId },
    data: {
      ...(topN !== undefined && { topN }),
      ...(copyAmountUsd !== undefined && { copyAmountUsd }),
      ...(minAprPercent !== undefined && { minAprPercent }),
      ...(intervalMs !== undefined && { intervalMs }),
      ...(pools !== undefined && { pools: sanitizeArr(pools) }),
      ...(autoRechargeTokens !== undefined && {
        autoRechargeTokens: sanitizeArr(autoRechargeTokens),
      }),
    },
  });

  res.json({ success: true, config: updated });
});

// ==========================================
// 2. 데이터 조회
// ==========================================

// 내 포지션 조회
router.get("/positions", authenticate, async (req: AuthRequest, res) => {
  try {
    const myList = getMyPositions();
    const positions = (myList || []).map((p: any) => ({
      nftMintAddress: p.nftMintAddress ?? p.positionAddress,
      positionAddress: p.positionAddress,
      pair: p.pair || p.poolAddress,
      liquidityUsd: parseFloat(p.liquidityUsd || 0),
      earnedUsd: parseFloat(p.earnedUsd || 0),
      pnlUsd: parseFloat(p.pnlUsd || 0),
      pnlUsdPercent: parseFloat(p.pnlUsdPercent || 0),
      bonusUsd: parseFloat(p.bonusUsd || 0),
      inRange: p.inRange,
      apr: calcApr(p),
      score: calcScore(p),
      status: p.status || 0,
    }));

    const totalLiq = positions.reduce((s, p) => s + p.liquidityUsd, 0);
    const totalEarned = positions.reduce((s, p) => s + p.earnedUsd, 0);
    const totalPnl = positions.reduce((s, p) => s + p.pnlUsd, 0);
    const totalBonus = positions.reduce((s, p) => s + p.bonusUsd, 0);

    res.json({
      success: true,
      data: {
        summary: {
          count: positions.length,
          totalLiquidityUsd: totalLiq,
          totalEarnedUsd: totalEarned,
          totalPnlUsd: totalPnl,
          totalBonusUsd: totalBonus,
        },
        positions,
      },
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 풀 및 토큰 조회
router.get("/pools", authenticate, async (req: AuthRequest, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      include: { config: true },
    });
    const poolsArr = (user?.config?.pools as string[]) || [];

    const pools = poolsArr.map((addr) => {
      const data = runCliJson(`pools info ${addr}`);
      const p = data?.data?.pool ?? {};
      return {
        name: p.name || "Unknown",
        address: addr,
        tvlUsd: parseFloat(p.tvl_usd || 0),
        apr: parseFloat(p.apr || 0),
      };
    });

    res.json({ success: true, data: { pools } });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

export default router;
