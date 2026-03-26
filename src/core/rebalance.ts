import { runCliJson, runCliText } from "./dex";
import { calcApr, calcScore } from "./position";
import { balanceWallet } from "./swap";

/**
 * Out-of-Range 자동 클로즈
 */
export async function cleanOutOfRange(myList: any[], config: any) {
  let outOfRange: any[] = [];

  for (const p of myList) {
    const nftMint = p.nftMintAddress ?? p.positionAddress;
    
    // 단순화: 최소 유지 시간(config.rebalanceMinAgeHours)은 DB 설정값 기반
    const ageHours = (p.positionAgeMs || 0) / (60 * 60 * 1000);
    if (ageHours < config.rebalanceMinAgeHours) continue;

    if (p.inRange === false) {
      outOfRange.push(p);
    } 
  }

  if (outOfRange.length === 0) return;

  const flag = config.dryRun ? "--dry-run" : "--confirm";

  for (const pos of outOfRange) {
    const nftMint = pos.nftMintAddress ?? pos.positionAddress;
    try {
      runCliText(`positions close --nft-mint ${nftMint} ${flag}`);
    } catch (e) {}
  }

  // 1:1 자산 밸런싱 실행
  await balanceWallet(config);
}

/**
 * 리밸런싱 (더 좋은 포지션 복사)
 */
export async function rebalance(myList: any[], allCandidates: any[], config: any) {
  const myByPair: Record<string, any[]> = {};
  
  myList.filter((p) => p.inRange !== false).forEach((p) => {
    const pair = p.pair || p.poolAddress;
    if (!myByPair[pair]) myByPair[pair] = [];
    p._apr = calcApr(p);
    p._ageHours = (p.positionAgeMs || 0) / (60 * 60 * 1000);
    myByPair[pair].push(p);
  });

  const candidatesByPair: Record<string, any[]> = {};
  allCandidates.forEach((p) => {
    const pair = p.pair || p.poolAddress;
    if (!candidatesByPair[pair]) candidatesByPair[pair] = [];
    candidatesByPair[pair].push(p);
  });

  const flag = config.dryRun ? "--dry-run" : "--confirm";

  for (const [pair, candidates] of Object.entries(candidatesByPair)) {
    if (!myByPair[pair] || myByPair[pair].length === 0) continue;

    const best = candidates[0];
    const bestScore = calcScore(best);
    const myBest = myByPair[pair].sort((a, b) => b._apr - a._apr)[0];

    if (myBest._ageHours < config.rebalanceMinAgeHours) continue;

    const bestApr = calcApr(best);
    const myApr = myBest._apr;
    const improvement = myApr > 0 ? (bestApr - myApr) / myApr : 1;

    if (improvement < config.rebalanceThreshold || bestScore <= 0 || bestApr <= 0) continue;

    try {
      const result = runCliText(`positions copy --position ${best.positionAddress} --amount-usd ${config.copyAmountUsd} ${flag}`);
      const nft = result.match(/NFT Address\s+([1-9A-HJ-NP-Za-km-z]{32,44})/)?.[1] ?? "";
      
      if (nft && !config.dryRun) {
        const oldNft = myBest.nftMintAddress ?? myBest.positionAddress;
        try {
          runCliText(`positions close --nft-mint ${oldNft} ${flag}`);
        } catch (closeErr) {}
      }
    } catch (e) {}
  }
}
