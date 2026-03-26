export function formatAge(ageMs: number | null): string {
  if (!ageMs) return "-";
  const createdAt = new Date(Date.now() - ageMs);
  const d = Math.floor(ageMs / (24 * 60 * 60 * 1000));
  const h = Math.floor((ageMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  const dateStr = createdAt
    .toLocaleDateString("ko-KR", {
      timeZone: "Asia/Seoul",
      month: "2-digit",
      day: "2-digit",
    })
    .replace(/\. /g, "-")
    .replace(".", "");
  return `${d}d ${h}h ago (${dateStr})`;
}

export function calcApr(pos: any): number {
  const earned = parseFloat(pos.earnedUsd || 0);
  const liq = parseFloat(pos.liquidityUsd || 1);
  const ageYears = (pos.positionAgeMs || 1) / (365 * 24 * 60 * 60 * 1000);
  if (ageYears === 0 || liq === 0) return 0;
  return (earned / liq / ageYears) * 100;
}

export function calcScore(pos: any): number {
  const tvl = Math.max(parseFloat(pos.liquidityUsd || 0), 0);
  const apr = Math.max(calcApr(pos), 0);
  if (tvl < 10) return 0;

  // 1. 연령 가중치: 오래 안착된 포지션에 신뢰도 가산점 (로그 보정)
  const ageDays = (pos.positionAgeMs || 0) / (24 * 60 * 60 * 1000);
  const ageWeight = Math.log1p(ageDays + 1); 

  // 2. 중심 가중치: 현재 가격이 정중앙에 위치할수록 고득점 (안정성 확보)
  let centralityWeight = 1; 

  if (pos._currentPrice && pos.priceLower && pos.priceUpper) {
    const lower = parseFloat(pos.priceLower);
    const upper = parseFloat(pos.priceUpper);
    const mid = (lower + upper) / 2;
    const current = parseFloat(pos._currentPrice);

    if (current >= lower && current <= upper) {
      const radius = (upper - lower) / 2;
      const offsetRatio = radius > 0 ? Math.abs(mid - current) / radius : 1;
      centralityWeight = 1 - offsetRatio; 
    } else {
      centralityWeight = 0.01; 
    }
  }

  const finalWeight = Math.max(centralityWeight, 0.1);
  return tvl * Math.pow(apr, 1.5) * finalWeight;
}

export const SORT_FN: Record<string, (a: any, b: any) => number> = {
  score: (a, b) => calcScore(b) - calcScore(a),
  tvl: (a, b) => parseFloat(b.liquidityUsd) - parseFloat(a.liquidityUsd),
  fee: (a, b) => parseFloat(b.earnedUsd) - parseFloat(a.earnedUsd),
  apr: (a, b) => calcApr(b) - calcApr(a),
};
