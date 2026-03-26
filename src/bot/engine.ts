import { prisma } from "../lib/db";
import { runCliJson, runCliText, getMyPositions } from "../core/dex";
import { calcApr, calcScore, SORT_FN } from "../core/position";
import { cleanOutOfRange, rebalance } from "../core/rebalance";
import { rechargeTokens } from "../core/swap";

export async function runBotTask() {
  console.log("── 🤖 [BOT Engine] Cycle Started ──");
  try {
    const users = await prisma.user.findMany({
      include: { config: true },
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
              return calcApr(p) >= (config.minAprPercent || 0);
            });

            positions.forEach((p: any) => {
              p._currentPrice = currentPrice;
              p._apr = calcApr(p);
            });
            allCandidates.push(...positions);
          } catch (e) {}
        }

        // 3. 점수 기반 정렬
        const sortMode = (config.sortBy as string) || "score";
        allCandidates.sort(SORT_FN[sortMode] || SORT_FN.score);

        // 4. 신규 포지션 복사 시도
        const flag = config.dryRun ? "--dry-run" : "--confirm";
        const targetNumber = config.topN || 0;
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
    console.error("── ❌ [BOT Engine] Global Error:", error);
  }
  console.log("── 🤖 [BOT Engine] Cycle Finished ──");
}
