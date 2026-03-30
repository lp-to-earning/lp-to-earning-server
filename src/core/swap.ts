import { runCliJson, runCliText } from "./dex";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/**
 * 지갑 내 모든 토큰(xStock)들과 USDC의 가치를 1:1 (50:50) 비율로 맞춥니다.
 */
/**
 * 지갑 내 모든 유의미한 토큰들과 USDC의 가치를 1:1 (50:50) 비율로 정밀하게 맞춥니다. (양방향 스왑)
 */
export async function balanceWallet(config: any, privateKey?: string, walletAddress?: string) {
  try {
    const balanceData = runCliJson("wallet balance", privateKey, walletAddress);
    const walletTokens = (balanceData?.data?.balance?.tokens || []).filter((t: any) => t.mint !== USDC_MINT);
    const usdcToken = (balanceData?.data?.balance?.tokens || []).find((t: any) => t.mint === USDC_MINT);
    let usdcAmount = parseFloat(usdcToken?.amount_ui || 0);

    const tokenListFull = runCliJson("tokens list", privateKey, walletAddress);
    const tokenMap: Record<string, any> = {};
    (tokenListFull?.data?.tokens || []).forEach((t: any) => {
      tokenMap[t.mint] = t;
    });

    let totalVolatileUsd = 0;
    const targets: any[] = [];

    // 1. 지갑 내 $0.5 이상의 가치를 지닌 모든 토큰 조사 (설정 목록에 없어도 자동 감지)
    for (const t of walletTokens) {
      const amountUi = parseFloat(t.amount_ui || 0);
      const priceUsd = parseFloat(tokenMap[t.mint]?.price_usd || 0);
      const valUsd = amountUi * priceUsd;

      if (valUsd > 0.5) {
        targets.push({ mint: t.mint, amountUi, priceUsd, valUsd });
        totalVolatileUsd += valUsd;
      }
    }

    // 설정된 토큰 중 지갑에 없지만 가미해야 할 토큰 체크
    const configTokens = config.autoRechargeTokens || [];
    for (const confMint of configTokens) {
        if (confMint === USDC_MINT) continue;
        if (!targets.find(t => t.mint === confMint)) {
            const priceUsd = parseFloat(tokenMap[confMint]?.price_usd || 0);
            if (priceUsd > 0) {
                 targets.push({ mint: confMint, amountUi: 0, priceUsd, valUsd: 0 });
            }
        }
    }

    const totalNetWorth = totalVolatileUsd + usdcAmount;
    if (totalNetWorth < 2) return; // 총 자산이 너무 적으면 무시

    const targetVolatileValue = totalNetWorth / 2;
    const dryRunFlag = config.dryRun ? "--dry-run" : "--confirm";

    console.log(`│     - Total NetWorth: $${totalNetWorth.toFixed(2)} (Target: $${targetVolatileValue.toFixed(2)} each)`);

    // 2. 케이스 A: 토큰이 너무 많을 때 (Sell tokens for USDC)
    if (totalVolatileUsd > targetVolatileValue + 1) {
      const excessUsd = totalVolatileUsd - targetVolatileValue;
      console.log(`│     - Excess assets found ($${excessUsd.toFixed(2)}). Selling to USDC...`);
      for (const t of targets) {
        if (t.valUsd <= 0) continue;
        const sellUsd = (t.valUsd / totalVolatileUsd) * excessUsd;
        const sellAmount = sellUsd / t.priceUsd;
        if (sellUsd < 0.5) continue;
        try {
          runCliJson(`swap execute --input-mint ${t.mint} --output-mint ${USDC_MINT} --amount ${sellAmount} ${dryRunFlag}`, privateKey, walletAddress);
        } catch (e) {}
      }
    } 
    // 3. 케이스 B: USDC가 너무 많을 때 (Buy tokens with USDC)
    else if (usdcAmount > targetVolatileValue + 1 && targets.length > 0) {
      const spendUsdc = usdcAmount - targetVolatileValue;
      console.log(`│     - Excess USDC found ($${spendUsdc.toFixed(2)}). Buying assets...`);
      // 타겟 토큰들에게 골고루 분배하여 매수
      const perTokenUsdc = spendUsdc / targets.length;
      if (perTokenUsdc >= 0.5) {
          for (const t of targets) {
            try {
              runCliJson(`swap execute --input-mint ${USDC_MINT} --output-mint ${t.mint} --amount ${perTokenUsdc} ${dryRunFlag}`, privateKey, walletAddress);
            } catch (e) {}
          }
      }
    }
  } catch (e: any) {
    console.error(`│     - Balance Error:`, e.message || e);
  }
}

/**
 * 부족한 토큰을 USDC로 충전 (자동 충전)
 */
export async function rechargeTokens(config: any, privateKey?: string, walletAddress?: string) {
  // 기존 rechargeTokens 로직을 TS 버전으로 간소화
  const configTokens = config.autoRechargeTokens;
  if (!configTokens || !Array.isArray(configTokens)) return;

  try {
    const balanceData = runCliJson("wallet balance", privateKey, walletAddress);
    const walletTokens = balanceData?.data?.balance?.tokens || [];
    const solBalance = parseFloat(balanceData?.data?.balance?.sol?.amount_sol || 0);

    // 1. SOL 가스비 체크 및 자동 충전 (0.02 SOL 미만일 때 $5치 충전)
    if (solBalance < 0.02) {
      console.log(`│     * Gas low: ${solBalance.toFixed(4)} SOL. Recharging from USDC...`);
      const dryRunFlag = config.dryRun ? "--dry-run" : "--confirm";
      try {
        runCliJson(`swap execute --input-mint ${USDC_MINT} --output-mint So11111111111111111111111111111111111111112 --amount 5 ${dryRunFlag}`, privateKey, walletAddress);
      } catch (e: any) {
        console.error(`│     * Gas recharge failed:`, e.message || e);
      }
    }

    const tokenListFull = runCliJson("tokens list", privateKey, walletAddress);
    const tokenMap: Record<string, any> = {};
    (tokenListFull?.data?.tokens || []).forEach((t: any) => {
      tokenMap[t.mint] = t;
    });

    // 2. 다른 설정된 토큰들 충전
    for (const confMint of configTokens) {
      if (confMint === USDC_MINT) continue; // USDC는 충전 대상에서 제외
      const myToken = walletTokens.find((t: any) => t.mint === confMint);
      const balanceUi = parseFloat(myToken?.amount_ui || 0);
      const priceUsd = parseFloat(tokenMap[confMint]?.price_usd || 0);
      const valueUsd = balanceUi * priceUsd;

      if (valueUsd < 2) {
        console.log(`│     * Asset low: ${confMint.substring(0, 8)}... ($${valueUsd.toFixed(2)}). Recharging...`);
        const dryRunFlag = config.dryRun ? "--dry-run" : "--confirm";
        runCliJson(`swap execute --input-mint ${USDC_MINT} --output-mint ${confMint} --amount 5 ${dryRunFlag}`, privateKey, walletAddress);
      }
    }
  } catch (e: any) {
    console.error(`│     * Recharge error:`, e.message || e);
  }
}
