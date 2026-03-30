import { prisma } from "../lib/db";
import { runCliJson, runCliText, getMyPositions } from "../core/dex";
import { calcApr, calcScore, SORT_FN } from "../core/position";
import { cleanOutOfRange, rebalance } from "../core/rebalance";
import { rechargeTokens, balanceWallet } from "../core/swap";

import { decrypt, encrypt } from "../lib/crypto";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

export async function runBotTask() {
  console.log("── 🤖 [BOT Engine] Cycle Started ──");

  // 기존 환경변수 백업
  const originalKey = process.env.SOLANA_WALLET_PRIVATE_KEY;

  try {
    const users = await prisma.user.findMany({
      include: { config: true },
    });

    for (const user of users) {
      if (!user.config || !user.config.isActive) {
        if (!user.config) {
          console.warn(
            `│ ⚠️ [User] No config found for ${user.walletAddress}. Skipping...`,
          );
        }
        continue;
      }

      // === [Wallet Switching] 무조건 핫월렛 (Hot Wallet ONLY) ===
      let activePrivateKey = "";
      let activeWalletAddress = "";

      try {
        // [Provisioning] 핫월렛이 없으면 즉석 발급
        if (!user.hotWalletAddress || !user.hotPrivateKey) {
          console.log(`│ [User] No hot wallet found for ${user.walletAddress}. Generating...`);
          const kp = Keypair.generate();
          const privKey = bs58.encode(kp.secretKey);
          const encrypted = encrypt(privKey);

          // DB에 핫월렛 정보 즉시 기록 (isManaged 강제 활성화)
          await prisma.user.update({
            where: { id: user.id },
            data: {
              hotWalletAddress: kp.publicKey.toBase58(),
              hotPrivateKey: encrypted.encrypted,
              hotIv: encrypted.iv,
              hotAuthTag: encrypted.authTag,
              isManaged: true,
            },
          });

          activePrivateKey = privKey;
          activeWalletAddress = kp.publicKey.toBase58();
          console.log(`│ [User] Hot wallet generated: ${activeWalletAddress}`);
        } else {
          // 이미 핫월렛이 있으면 복호화해서 사용
          activePrivateKey = decrypt(user.hotPrivateKey, user.hotIv!, user.hotAuthTag!);
          activeWalletAddress = user.hotWalletAddress;
          console.log(`│ [User] Using Hot Wallet: ${activeWalletAddress}`);
        }

        process.env.SOLANA_WALLET_PRIVATE_KEY = activePrivateKey;
      } catch (err) {
        console.error(`│ ❌ [User] Wallet initialization failed for ${user.walletAddress}:`, err);
        continue;
      }
      // ===========================================

      const config = user.config;

      try {
        // 1. 사전 자산 체크 및 충전
        console.log(`│ [Step 1] Checking assets and balancing 5:5...`);
        await balanceWallet(
          config,
          process.env.SOLANA_WALLET_PRIVATE_KEY,
          user.walletAddress,
        );
        await rechargeTokens(
          config,
          process.env.SOLANA_WALLET_PRIVATE_KEY,
          user.walletAddress,
        );

        // 2. 가용한 모든 타겟 풀의 포지션 수집
        const poolsArr = config.pools as string[];
        const allCandidates: any[] = [];
        console.log(
          `│ [Step 2] Collecting candidates from ${poolsArr.length} pools...`,
        );

        for (const poolAddr of poolsArr) {
          try {
            // 풀 가격 및 상위 포지션 조회
            const poolInfo = runCliJson(
              `pools info ${poolAddr}`,
              process.env.SOLANA_WALLET_PRIVATE_KEY,
              user.walletAddress,
            );
            const currentPrice = parseFloat(
              poolInfo?.data?.pool?.current_price || 0,
            );

            const data = runCliJson(
              `positions top-positions --pool ${poolAddr}`,
              process.env.SOLANA_WALLET_PRIVATE_KEY,
              user.walletAddress,
            );
            const positions = (data?.data?.positions ?? []).filter((p: any) => {
              if (config.requireInRange && !p.inRange) return false;
              return calcApr(p) >= (config.minAprPercent || 0);
            });

            console.log(
              `│   - Pool ${poolAddr}: Found ${positions.length} valid positions.`,
            );

            positions.forEach((p: any) => {
              p._currentPrice = currentPrice;
              p._apr = calcApr(p);
            });
            allCandidates.push(...positions);
          } catch (e: any) {
            console.error(`│   - Pool ${poolAddr} error:`, e.message || e);
          }
        }

        // 3. 점수 기반 정렬
        const sortMode = (config.sortBy as string) || "score";
        allCandidates.sort(SORT_FN[sortMode] || SORT_FN.score);
        console.log(
          `│ [Step 3] Total candidates: ${allCandidates.length} (Sorted by ${sortMode})`,
        );

        // 4. 신규 포지션 복사 시도
        const flag = config.dryRun ? "--dry-run" : "--confirm";
        const targetNumber = config.topN || 0;
        const toCopy = allCandidates.slice(0, targetNumber);

        if (toCopy.length > 0) {
          console.log(
            `│ [Step 4] Attempting to copy ${toCopy.length} new positions...`,
          );
          for (const pos of toCopy) {
            try {
              console.log(
                `│   - Copying: ${pos.positionAddress} (APR: ${pos._apr.toFixed(2)}%)`,
              );
              runCliText(
                `positions copy --position ${pos.positionAddress} --amount-usd ${config.copyAmountUsd} ${flag}`,
                activePrivateKey,
                activeWalletAddress,
              );
            } catch (e: any) {
              console.error(
                `│   - Copying failed: ${pos.positionAddress}`,
                e.message || e,
              );
            }
          }
        } else {
          console.log(`│ [Step 4] No new positions to copy.`);
        }

        // 5. 내 포지션 관리 (Out-of-range & Rebalance)
        console.log(`│ [Step 5] Managing existing positions...`);
        const myList = getMyPositions(
          process.env.SOLANA_WALLET_PRIVATE_KEY,
          user.walletAddress,
        );
        console.log(`│   - Current positions: ${myList.length}`);
        if (config.isAutoRebalance) {
          await cleanOutOfRange(
            myList,
            config,
            process.env.SOLANA_WALLET_PRIVATE_KEY,
            user.walletAddress,
          );
          await rebalance(
            myList,
            allCandidates,
            config,
            process.env.SOLANA_WALLET_PRIVATE_KEY,
            user.walletAddress,
          );
        } else {
          console.log(`│   - isAutoRebalance is OFF. Skipping management.`);
        }
      } catch (userErr) {
        console.error(`│ ❌ [User] ${user.walletAddress} failed:`, userErr);
      }
    }
  } catch (error) {
    console.error("── ❌ [BOT Engine] Global Error:", error);
  }
  console.log("── 🤖 [BOT Engine] Cycle Finished ──");
}
