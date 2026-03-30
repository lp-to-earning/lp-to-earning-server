import { prisma } from "../lib/db";
import { runCliJson, runCliText, getMyPositions } from "../core/dex";
import { calcApr, calcScore, SORT_FN } from "../core/position";
import { cleanOutOfRange, rebalance } from "../core/rebalance";
import { rechargeTokens, balanceWallet } from "../core/swap";

import { decrypt } from "../lib/crypto";

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

      // === [Wallet Switching] 유저별 지갑 키 적용 (Hybrid: User Key or Hot Wallet) ===
      let hasValidKey = false;
      let activePrivateKey = "";
      let activeWalletAddress = user.walletAddress;

      try {
        if (user.isManaged && user.hotPrivateKey && user.hotIv && user.hotAuthTag) {
          // 1. 서버 관리형 핫월렛 사용
          activePrivateKey = decrypt(user.hotPrivateKey, user.hotIv, user.hotAuthTag);
          activeWalletAddress = user.hotWalletAddress || user.walletAddress;
          hasValidKey = true;
          console.log(`│ [User] Using Managed Hot Wallet: ${activeWalletAddress}...`);
        } else if (user.encryptedPrivateKey && user.iv && user.authTag) {
          // 2. 유저 입력형 개별 키 사용
          activePrivateKey = decrypt(user.encryptedPrivateKey, user.iv, user.authTag);
          hasValidKey = true;
          console.log(`│ [User] Using Shared/Personal Wallet: ${activeWalletAddress}...`);
        } else if (originalKey) {
          // 3. (Fallback) 서버 마스터 공유 지갑 사용
          activePrivateKey = originalKey;
          hasValidKey = true;
          console.log(`│ [User] Using Server Root Wallet for: ${activeWalletAddress}...`);
        }

        if (hasValidKey) {
          process.env.SOLANA_WALLET_PRIVATE_KEY = activePrivateKey;
        } else {
          console.warn(`│ ⚠️ [User] No private key found for ${user.walletAddress}. Skipping...`);
          continue;
        }
      } catch (decErr) {
        console.error(`│ ❌ [User] Decryption failed for ${user.walletAddress}:`, decErr);
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
                process.env.SOLANA_WALLET_PRIVATE_KEY,
                user.walletAddress,
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
