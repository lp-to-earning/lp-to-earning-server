import { runCliJson, runCliText } from "./dex";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/**
 * 지갑 내 모든 토큰(xStock)들과 USDC의 가치를 1:1 (50:50) 비율로 맞춥니다.
 */
export async function balanceWallet(config: any) {
  // autoRechargeTokens 설정을 사용함
  const configTokens = config.autoRechargeTokens;
  if (!configTokens || !Array.isArray(configTokens) || configTokens.length === 0) return;

  try {
    const balanceData = runCliJson("wallet balance");
    const walletTokens = balanceData?.data?.balance?.tokens || [];
    const usdcToken = walletTokens.find((t: any) => t.mint === USDC_MINT);
    let usdcAmount = parseFloat(usdcToken?.amount_ui || 0);

    const tokenListFull = runCliJson("tokens list");
    const tokenMap: Record<string, any> = {};
    (tokenListFull?.data?.tokens || []).forEach((t: any) => {
      tokenMap[t.mint] = t;
    });

    let totalVolatileUsd = 0;
    const targets: any[] = [];

    for (const confMint of configTokens) {
      const myToken = walletTokens.find((t: any) => t.mint === confMint);
      const amountUi = parseFloat(myToken?.amount_ui || 0);
      const priceUsd = parseFloat(tokenMap[confMint]?.price_usd || 0);
      const valUsd = amountUi * priceUsd;

      if (valUsd > 0.1) {
        targets.push({ mint: confMint, amountUi, priceUsd, valUsd });
        totalVolatileUsd += valUsd;
      }
    }

    const totalNetWorth = totalVolatileUsd + usdcAmount;
    const targetValue = totalNetWorth / 2;
    const dryRunFlag = config.dryRun ? "--dry-run" : "--confirm";

    if (totalVolatileUsd > usdcAmount + 1) {
      const excessUsd = totalVolatileUsd - targetValue;
      for (const t of targets) {
        const sellUsd = (t.valUsd / totalVolatileUsd) * excessUsd;
        const sellAmount = sellUsd / t.priceUsd;
        if (sellUsd < 0.5) continue;
        try {
          runCliJson(`swap execute --input-mint ${t.mint} --output-mint ${USDC_MINT} --amount ${sellAmount} ${dryRunFlag}`);
        } catch (e) {}
      }
    }
  } catch (e) {}
}

/**
 * 부족한 토큰을 USDC로 충전 (자동 충전)
 */
export async function rechargeTokens(config: any) {
  // 기존 rechargeTokens 로직을 TS 버전으로 간소화
  const configTokens = config.autoRechargeTokens;
  if (!configTokens || !Array.isArray(configTokens)) return;

  try {
    const balanceData = runCliJson("wallet balance");
    const walletTokens = balanceData?.data?.balance?.tokens || [];
    const tokenListFull = runCliJson("tokens list");
    const tokenMap: Record<string, any> = {};
    (tokenListFull?.data?.tokens || []).forEach((t: any) => {
      tokenMap[t.mint] = t;
    });

    for (const confMint of configTokens) {
      const myToken = walletTokens.find((t: any) => t.mint === confMint);
      const balanceUi = parseFloat(myToken?.amount_ui || 0);
      const priceUsd = parseFloat(tokenMap[confMint]?.price_usd || 0);
      const valueUsd = balanceUi * priceUsd;

      if (valueUsd < 2) { // 임계치 $2 고정 (config에 따라 다를 수 있음)
        console.log(`│     * Asset low: ${confMint.substring(0, 8)}... ($${valueUsd.toFixed(2)}). Recharging...`);
        const dryRunFlag = config.dryRun ? "--dry-run" : "--confirm";
        runCliJson(`swap execute --input-mint ${USDC_MINT} --output-mint ${confMint} --amount 5 ${dryRunFlag}`);
      }
    }
  } catch (e: any) {
    console.error(`│     * Recharge error:`, e.message || e);
  }
}
