import { Router } from "express";
import { prisma } from "../lib/db";
import { authenticate, AuthRequest } from "../middleware/auth";
import { runCliJson, getMyPositions } from "../core/dex";
import { calcApr, calcScore } from "../core/position";
import { encrypt, decrypt } from "../lib/crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import bs58 from "bs58";
import {
  TOKEN_PROGRAM_ID,
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
  getMint,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";

const router = Router();

// ==========================================
// 0. Helper for User Key Decryption (Clean Code)
// ==========================================
async function getDecryptedKeyForUser(userId: number) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
  });
  if (!user) return { decryptedKey: undefined, targetAddress: undefined };

  let decryptedKey: string | undefined = undefined;
  const targetAddress = user.hotWalletAddress || user.walletAddress;

  if (user.isManaged && user.hotPrivateKey && user.hotIv && user.hotAuthTag) {
    try {
      decryptedKey = decrypt(user.hotPrivateKey, user.hotIv, user.hotAuthTag);
    } catch (e) {}
  } else if (user.encryptedPrivateKey && user.iv && user.authTag) {
    try {
      decryptedKey = decrypt(user.encryptedPrivateKey, user.iv, user.authTag);
    } catch (e) {}
  } else {
    decryptedKey = process.env.SOLANA_WALLET_PRIVATE_KEY;
  }

  return { decryptedKey, targetAddress };
}

// ==========================================
// 0. Cache Config (To speed up slow CLI queries)
// ==========================================
const cache: Record<string, { time: number; data: any }> = {};
const CACHE_TTL_MS = 5 * 60 * 1000; // 5분 캐시

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
    isManaged: user?.isManaged,
    hotWalletAddress: user?.hotWalletAddress,
  });
});

// 핫월렛 수동 생성 (명시적 발급)
router.post(
  "/hot-wallet/create",
  authenticate,
  async (req: AuthRequest, res) => {
    try {
      const user = await prisma.user.findUnique({ where: { id: req.userId } });
      if (!user) return res.status(404).json({ error: "User not found" });

      if (user.hotWalletAddress && user.hotPrivateKey) {
        return res.json({
          success: true,
          message: "Hot wallet already exists.",
          address: user.hotWalletAddress,
        });
      }

      const kp = Keypair.generate();
      const privKey = bs58.encode(kp.secretKey);
      const { encrypted, iv, authTag } = encrypt(privKey);

      const updated = await prisma.user.update({
        where: { id: req.userId },
        data: {
          hotWalletAddress: kp.publicKey.toBase58(),
          hotPrivateKey: encrypted,
          hotIv: iv,
          hotAuthTag: authTag,
          isManaged: true,
        },
      });

      res.json({
        success: true,
        message: "Hot wallet generated successfully.",
        address: updated.hotWalletAddress,
      });
    } catch (e: any) {
      console.error("[POST /hot-wallet/create]", e);
      res.status(500).json({ success: false, error: e.message });
    }
  },
);

// 핫월렛 부분/전액 출금 (isMax 지원)
router.post("/withdraw", authenticate, async (req: AuthRequest, res) => {
  const { mint, amount, amountSol, isMax } = req.body;
  const user = await prisma.user.findUnique({ where: { id: req.userId } });

  if (!user || !user.hotWalletAddress || !user.hotPrivateKey) {
    return res.status(400).json({ error: "No managed hot wallet found." });
  }

  try {
    const privKeyStr = decrypt(
      user.hotPrivateKey,
      user.hotIv!,
      user.hotAuthTag!,
    );
    const kp = Keypair.fromSecretKey(bs58.decode(privKeyStr));
    const connection = new Connection(
      "https://api.mainnet-beta.solana.com",
      "confirmed",
    );
    const toPubkey = new PublicKey(user.walletAddress);
    const transaction = new Transaction();

    // 1. SPL 토큰 출금 (mint 주소 제공 시)
    if (mint) {
      const tokenMint = new PublicKey(mint);
      const fromAta = await getAssociatedTokenAddress(tokenMint, kp.publicKey);
      const toAta = await getAssociatedTokenAddress(tokenMint, toPubkey);
      const mintInfo = await getMint(connection, tokenMint);

      let finalAmount: bigint;
      if (isMax) {
        const balanceObj = await connection.getTokenAccountBalance(fromAta);
        finalAmount = BigInt(balanceObj.value.amount);
      } else if (amount && amount > 0) {
        finalAmount = BigInt(Math.floor(amount * 10 ** mintInfo.decimals));
      } else {
        finalAmount = 0n;
      }

      if (finalAmount > 0n) {
        const toAtaInfo = await connection.getAccountInfo(toAta);
        if (!toAtaInfo) {
          transaction.add(
            createAssociatedTokenAccountInstruction(
              kp.publicKey,
              toAta,
              toPubkey,
              tokenMint,
            ),
          );
        }

        transaction.add(
          createTransferCheckedInstruction(
            fromAta,
            tokenMint,
            toAta,
            kp.publicKey,
            finalAmount,
            mintInfo.decimals,
          ),
        );
      }
    }

    // 2. SOL 출금
    if (isMax && !mint) {
      const balance = await connection.getBalance(kp.publicKey);
      const fee = 5000; // 0.000005 SOL
      const rentExempt = await connection.getMinimumBalanceForRentExemption(0);
      const toTransfer = balance - fee; // 렌트비까지 다 뺀다 (지갑 폐쇄급 전액 인출)

      if (toTransfer > 0) {
        transaction.add(
          SystemProgram.transfer({
            fromPubkey: kp.publicKey,
            toPubkey: toPubkey,
            lamports: toTransfer,
          }),
        );
      }
    } else if (amountSol && amountSol > 0) {
      const rawSolAmount = Math.floor(amountSol * LAMPORTS_PER_SOL);
      transaction.add(
        SystemProgram.transfer({
          fromPubkey: kp.publicKey,
          toPubkey: toPubkey,
          lamports: rawSolAmount,
        }),
      );
    }

    if (transaction.instructions.length === 0) {
      return res
        .status(400)
        .json({ error: "No withdrawal amounts or valid mint specified." });
    }

    const txHash = await connection.sendTransaction(transaction, [kp]);
    res.json({ success: true, message: "Withdrawal successful.", txHash });
  } catch (e: any) {
    console.error("[POST /api/withdraw]", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 핫월렛 출금 (SOL & USDC 전용 고도화)
router.post("/withdraw-all", authenticate, async (req: AuthRequest, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user || !user.hotWalletAddress || !user.hotPrivateKey) {
    return res.status(400).json({ error: "No managed hot wallet found." });
  }

  try {
    const privKeyStr = decrypt(
      user.hotPrivateKey,
      user.hotIv!,
      user.hotAuthTag!,
    );
    const kp = Keypair.fromSecretKey(bs58.decode(privKeyStr));
    const connection = new Connection(
      "https://api.mainnet-beta.solana.com",
      "confirmed",
    );
    const toPubkey = new PublicKey(user.walletAddress);
    const USDC_MINT = new PublicKey(
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    );

    const transaction = new Transaction();

    // 1. USDC 잔액 확인 및 출금
    const fromAta = await getAssociatedTokenAddress(USDC_MINT, kp.publicKey);
    const toAta = await getAssociatedTokenAddress(USDC_MINT, toPubkey);

    const fromAtaInfo = await connection.getAccountInfo(fromAta);
    if (fromAtaInfo) {
      const balanceObj = await connection.getTokenAccountBalance(fromAta);
      const amount = BigInt(balanceObj.value.amount);
      if (amount > 0n) {
        const toAtaInfo = await connection.getAccountInfo(toAta);
        if (!toAtaInfo) {
          transaction.add(
            createAssociatedTokenAccountInstruction(
              kp.publicKey,
              toAta,
              toPubkey,
              USDC_MINT,
            ),
          );
        }

        transaction.add(
          createTransferCheckedInstruction(
            fromAta,
            USDC_MINT,
            toAta,
            kp.publicKey,
            amount,
            6,
          ),
        );
      }
    }

    // 2. SOL 잔액 확인 및 전액 출금 (수수료 제외)
    const balance = await connection.getBalance(kp.publicKey);
    const rentExempt = await connection.getMinimumBalanceForRentExemption(0);
    const fee = 10000; // 0.00001 SOL
    const amountToTransfer = balance - rentExempt - fee;

    if (amountToTransfer > 0) {
      transaction.add(
        SystemProgram.transfer({
          fromPubkey: kp.publicKey,
          toPubkey: toPubkey,
          lamports: amountToTransfer,
        }),
      );
    }

    if (transaction.instructions.length === 0) {
      return res.json({ success: true, message: "No funds to withdraw." });
    }

    const txHash = await connection.sendTransaction(transaction, [kp]);
    res.json({
      success: true,
      message: "SOL & USDC withdrawal successful.",
      txHash,
    });
  } catch (e: any) {
    console.error("[POST /api/withdraw-all]", e);
    res.status(500).json({ success: false, error: e.message });
  }
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
    isAutoRebalance,
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
    ...(isAutoRebalance !== undefined && { isAutoRebalance }),
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

// 핫월렛 전체 잔고 조회 (SOL + SPL 토큰)
router.get("/balances", authenticate, async (req: AuthRequest, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user || (!user.walletAddress && !user.hotWalletAddress)) {
      return res.status(400).json({ error: "No wallet address found." });
    }

    const targetAddress = user.hotWalletAddress || user.walletAddress;
    const connection = new Connection(
      "https://api.mainnet-beta.solana.com",
      "confirmed",
    );

    // 1. SOL 잔액 조회
    const solBalance = await connection.getBalance(
      new PublicKey(targetAddress),
    );

    // 2. 모든 SPL 토큰 잔액 조회
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      new PublicKey(targetAddress),
      { programId: TOKEN_PROGRAM_ID },
    );

    const tokens = tokenAccounts.value
      .map((ta: any) => {
        const info = ta.account.data.parsed.info;
        return {
          mint: info.mint,
          amount: info.tokenAmount.uiAmount,
          decimals: info.tokenAmount.decimals,
        };
      })
      .filter((t) => t.amount > 0);

    res.json({
      success: true,
      address: targetAddress,
      sol: solBalance / LAMPORTS_PER_SOL,
      tokens,
    });
  } catch (e: any) {
    console.error("[GET /api/balances]", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ==========================================
// 2. 데이터 조회
// ==========================================

// 내 포지션 조회
router.get("/positions", authenticate, async (req: AuthRequest, res) => {
  try {
    const { decryptedKey, targetAddress } = await getDecryptedKeyForUser(req.userId!);
    if (!targetAddress) {
      return res.status(400).json({ error: "No wallet address found for user." });
    }

    const myList = getMyPositions(decryptedKey, targetAddress);
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

// 포지션 수수료/보너스 수확 (수동)
router.post("/positions/claim", authenticate, async (req: AuthRequest, res) => {
  const { nftMints } = req.body;
  if (!nftMints || !Array.isArray(nftMints) || nftMints.length === 0) {
    return res.status(400).json({ error: "nftMints array is required." });
  }

  try {
    const { decryptedKey, targetAddress } = await getDecryptedKeyForUser(req.userId!);
    const mintsStr = nftMints.join(",");
    
    const result = runCliJson(
      `positions claim --nft-mints ${mintsStr} --confirm`,
      decryptedKey,
      targetAddress
    );

    res.json({ success: true, message: "Claim successful.", data: result });
  } catch (e: any) {
    console.error("[POST /api/positions/claim]", e);
    res.status(500).json({ success: false, error: e.message || "Claim failed." });
  }
});

// 개별 포지션 닫기 (수동)
router.post("/positions/close", authenticate, async (req: AuthRequest, res) => {
  const { nftMint } = req.body;
  if (!nftMint) {
    return res.status(400).json({ error: "nftMint is required." });
  }

  try {
    const { decryptedKey, targetAddress } = await getDecryptedKeyForUser(req.userId!);
    
    const result = runCliJson(
      `positions close --nft-mint ${nftMint} --confirm`,
      decryptedKey,
      targetAddress
    );

    res.json({ success: true, message: "Position closed successfully.", data: result });
  } catch (e: any) {
    console.error("[POST /api/positions/close]", e);
    res.status(500).json({ success: false, error: e.message || "Failed to close position." });
  }
});

// DEX 전체 풀 목록 조회 (검색용, 인증 없음)
router.get("/pools/all", async (req, res) => {
  try {
    const cacheKey = "pools list -o json";
    let data;
    if (cache[cacheKey] && Date.now() - cache[cacheKey].time < CACHE_TTL_MS) {
      data = cache[cacheKey].data;
    } else {
      data = runCliJson(cacheKey);
      cache[cacheKey] = { time: Date.now(), data };
    }
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
    const cacheKey = "tokens list -o json";
    let data;
    if (cache[cacheKey] && Date.now() - cache[cacheKey].time < CACHE_TTL_MS) {
      data = cache[cacheKey].data;
    } else {
      data = runCliJson(cacheKey);
      cache[cacheKey] = { time: Date.now(), data };
    }
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
    const { decryptedKey, targetAddress } = await getDecryptedKeyForUser(req.userId!);
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      include: { config: true },
    });

    const poolsArr = (user?.config?.pools as string[]) || [];

    const pools = poolsArr.map((addr) => {
      const cacheKey = `pools info ${addr}`;
      let data;
      if (cache[cacheKey] && Date.now() - cache[cacheKey].time < CACHE_TTL_MS) {
        data = cache[cacheKey].data;
      } else {
        data = runCliJson(cacheKey, decryptedKey, targetAddress);
        cache[cacheKey] = { time: Date.now(), data };
      }

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
