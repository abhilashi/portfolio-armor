const RPCS = [
  "https://solana-rpc.publicnode.com",
  "https://api.mainnet-beta.solana.com",
];
const SOL_MINT = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const STABLECOINS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

async function rpcCall(method, params) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  for (const rpc of RPCS) {
    try {
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (res.status === 429) {
        console.error(`  Rate limited by ${new URL(rpc).hostname}, trying next...`);
        continue;
      }
      if (!res.ok) continue;
      const json = await res.json();
      if (json.error) {
        console.error(`  RPC error from ${new URL(rpc).hostname}: ${json.error.message}`);
        continue;
      }
      return json.result;
    } catch (e) {
      console.error(`  RPC ${new URL(rpc).hostname} failed: ${e.message}`);
      continue;
    }
  }
  throw new Error(`Solana RPC ${method} failed on all endpoints`);
}

async function getTokenAccountsByProgram(wallet, programId) {
  const result = await rpcCall("getTokenAccountsByOwner", [
    wallet,
    { programId },
    { encoding: "jsonParsed" },
  ]);
  return result.value.map((acct) => {
    const info = acct.account.data.parsed.info;
    return {
      mint: info.mint,
      amount: info.tokenAmount.uiAmount || 0,
      decimals: info.tokenAmount.decimals,
    };
  });
}

export async function fetchSolanaPortfolio(walletAddress) {
  // Fetch SOL balance and SPL tokens in parallel
  const [solResult, splTokens, spl2022Tokens] = await Promise.all([
    rpcCall("getBalance", [walletAddress]),
    getTokenAccountsByProgram(walletAddress, TOKEN_PROGRAM),
    getTokenAccountsByProgram(walletAddress, TOKEN_2022_PROGRAM).catch(() => []),
  ]);

  const solBalance = solResult.value / 1e9;

  // Merge token lists, filter zero balances, dedupe wrapped SOL
  const allTokens = [...splTokens, ...spl2022Tokens].filter(
    (t) => t.amount > 0 && t.mint !== SOL_MINT
  );

  // Fetch prices from DeFi Llama
  const allMints = [SOL_MINT, ...allTokens.map((t) => t.mint)];
  const coins = allMints.map((m) => `solana:${m}`).join(",");

  let priceData = {};
  try {
    const priceRes = await fetch(`https://coins.llama.fi/prices/current/${coins}`);
    const priceJson = await priceRes.json();
    priceData = priceJson.coins || {};
  } catch (e) {
    console.error(`Solana price fetch error: ${e.message}`);
  }

  // For tokens DeFi Llama doesn't have, try Jupiter
  const missingMints = allMints.filter((m) => !priceData[`solana:${m}`]);
  if (missingMints.length > 0) {
    try {
      const jupRes = await fetch(
        `https://api.jup.ag/price/v2?ids=${missingMints.join(",")}`
      );
      const jupJson = await jupRes.json();
      if (jupJson.data) {
        for (const [mint, info] of Object.entries(jupJson.data)) {
          if (info && info.price && !priceData[`solana:${mint}`]) {
            priceData[`solana:${mint}`] = {
              price: parseFloat(info.price),
              symbol: info.mintSymbol || "UNKNOWN",
            };
          }
        }
      }
    } catch {
      // Jupiter fallback failed, skip
    }
  }

  const positions = [];
  let stablecoinBalance = 0;

  // Native SOL
  const solPrice = priceData[`solana:${SOL_MINT}`]?.price || 0;
  if (solBalance > 0.001) {
    positions.push({
      source: "solana",
      asset: "SOL",
      side: "LONG",
      size: solBalance,
      price: solPrice,
      valueUsd: solBalance * solPrice,
    });
  }

  // SPL tokens
  for (const token of allTokens) {
    const key = `solana:${token.mint}`;
    const data = priceData[key];
    const price = data?.price || 0;
    const symbol = data?.symbol || "UNKNOWN";
    const value = token.amount * price;

    if (STABLECOINS.has(token.mint)) {
      stablecoinBalance += value || token.amount; // fallback to amount for stables
      continue;
    }

    if (value < 1 && price === 0) continue; // Skip unpriced dust

    positions.push({
      source: "solana",
      asset: symbol,
      originalToken: symbol,
      side: "LONG",
      size: token.amount,
      price,
      valueUsd: value,
      mint: token.mint,
    });
  }

  return { positions, stablecoinBalance };
}
