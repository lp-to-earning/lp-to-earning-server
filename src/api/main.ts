import { Router } from "express";
import { prisma } from "../lib/db";
import { authenticate, AuthRequest } from "../middleware/auth";
import { runCliJson, getMyPositions } from "../core/dex";
import { calcApr, calcScore } from "../core/position";
import { encrypt, decrypt } from "../lib/crypto";

const router = Router();

// ==========================================
// 1. 개인키 보안 등록
// ==========================================
router.post("/private-key", authenticate, async (req: AuthRequest, res) => {
  const { privateKey } = req.body;
  if (!privateKey)
    return res.status(400).json({ error: "Private key is required" });

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

    res.json({
      success: true,
      message: "Private key encrypted and saved securely.",
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: "Encryption failed." });
  }
});

// ==========================================
// 1. Config 관리
// ==========================================

// 봇 설정 조회
router.get("/config", authenticate, async (req: AuthRequest, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    include: { config: true },
  });
  res.json({
    config: user?.config,
    hasPrivateKey: !!user?.encryptedPrivateKey,
  });
});

// 봇 설정 변경
router.post("/config", authenticate, async (req: AuthRequest, res) => {
  const {
    isActive,
    topN,
    copyAmountUsd,
    minAprPercent,
    intervalMs,
    dryRun,
    pools,
    autoRechargeTokens,
  } = req.body;

  const sanitizeArr = (val: any) => {
    let arr = [];
    if (typeof val === "string") {
      try {
        arr = JSON.parse(val);
      } catch {
        arr = [];
      }
    } else if (Array.isArray(val)) {
      arr = val;
    }
    return arr.filter(
      (x: any) => typeof x === "string" && x !== "[" && x !== "]",
    );
  };

  const configData = {
    ...(isActive !== undefined && { isActive }),
    ...(topN !== undefined && { topN }),
    ...(copyAmountUsd !== undefined && { copyAmountUsd }),
    ...(minAprPercent !== undefined && { minAprPercent }),
    ...(intervalMs !== undefined && { intervalMs }),
    ...(dryRun !== undefined && { dryRun }),
    ...(pools !== undefined && { pools: sanitizeArr(pools) }),
    ...(autoRechargeTokens !== undefined && {
      autoRechargeTokens: sanitizeArr(autoRechargeTokens),
    }),
  };

  const userId = req.userId!;

  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res
        .status(401)
        .json({ error: "User no longer exists; sign in again." });
    }

    const existing = await prisma.userConfig.findUnique({
      where: { userId },
    });

    if (Object.keys(configData).length === 0) {
      if (existing) {
        return res.json({ success: true, config: existing });
      }
      const created = await prisma.userConfig.create({ data: { userId } });
      return res.json({ success: true, config: created });
    }

    const updated = existing
      ? await prisma.userConfig.update({
          where: { userId },
          data: configData,
        })
      : await prisma.userConfig.create({
          data: { userId, ...configData },
        });

    res.json({ success: true, config: updated });
  } catch (e) {
    console.error("[POST /api/config]", e);
    res.status(500).json({ success: false, error: "Failed to save config." });
  }
});

// ==========================================
// 2. 데이터 조회
// ==========================================

// 내 포지션 조회
router.get("/positions", authenticate, async (req: AuthRequest, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
    });

    let decryptedKey: string | undefined = undefined;
    if (user?.encryptedPrivateKey && user.iv && user.authTag) {
      try {
        decryptedKey = decrypt(user.encryptedPrivateKey, user.iv, user.authTag);
      } catch (e) {}
    } else {
      decryptedKey = process.env.SOLANA_WALLET_PRIVATE_KEY;
    }

    const myList = getMyPositions(decryptedKey, user?.walletAddress);
    const positions = (myList || []).map((p: any) => ({
      nftMintAddress: p.nftMintAddress ?? p.positionAddress,
      positionAddress: p.positionAddress,
      poolAddress: p.poolAddress ?? p.pool_address ?? "",
      pair: p.pair || p.poolAddress || p.pool_address || "",
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

// DEX 전체 풀 목록 조회 (검색용, 인증 없음)
router.get("/pools/all", async (req, res) => {
  try {
    const data = runCliJson("pools list -o json");
    const pools = (data?.data?.pools || []).map((p: any) => ({
      name: p.pair || "Unknown",
      address: p.id,
      symbolA: p.token_a?.symbol || "",
      symbolB: p.token_b?.symbol || "",
      logoA: p.token_a?.logo_uri || "",
      logoB: p.token_b?.logo_uri || "",
      price: parseFloat(p.current_price || 0),
      apr: parseFloat(p.apr || 0),
      tvl: parseFloat(p.tvl_usd || 0),
      volume24h: parseFloat(p.volume_24h_usd || 0),
    }));
    res.json({ success: true, data: pools });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// DEX 전체 토큰 목록 조회 (검색용, 인증 없음)
router.get("/tokens/all", async (req, res) => {
  try {
    const data = runCliJson("tokens list -o json");
    const tokens = (data?.data?.tokens || []).map((t: any) => ({
      name: t.name || t.symbol || "Unknown",
      symbol: t.symbol || "UNKNOWN",
      mint: t.mint,
      price: parseFloat(t.price_usd || 0),
      decimals: t.decimals || 0,
      logo: t.logo_uri || "",
    }));
    res.json({ success: true, data: tokens });
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

    let decryptedKey: string | undefined = undefined;
    if (user?.encryptedPrivateKey && user.iv && user.authTag) {
      try {
        decryptedKey = decrypt(user.encryptedPrivateKey, user.iv, user.authTag);
      } catch (e) {}
    } else {
      decryptedKey = process.env.SOLANA_WALLET_PRIVATE_KEY;
    }

    const poolsArr = (user?.config?.pools as string[]) || [];

    const pools = poolsArr.map((addr) => {
      const data = runCliJson(
        `pools info ${addr}`,
        decryptedKey,
        user?.walletAddress,
      );
      const p = data?.data?.pool ?? {};
      return {
        name: p.pair || "Unknown",
        address: addr,
        symbolA: p.token_a?.symbol || "",
        symbolB: p.token_b?.symbol || "",
        logoA: p.token_a?.logo_uri || "",
        logoB: p.token_b?.logo_uri || "",
        tvlUsd: parseFloat(p.tvl_usd || 0),
        apr: parseFloat(p.apr || 0),
        volume24h: parseFloat(p.volume_24h_usd || 0),
      };
    });

    res.json({ success: true, data: { pools } });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

export default router;
