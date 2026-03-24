import crypto from "crypto";

const SPOT_BASE = "https://api.binance.com";
const FUTURES_BASE = "https://fapi.binance.com";

function sign(queryString, secret) {
  return crypto.createHmac("sha256", secret).update(queryString).digest("hex");
}

async function signedRequest(baseUrl, path, apiKey, secret, params = {}) {
  params.timestamp = Date.now();
  params.recvWindow = 5000;
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const signature = sign(qs, secret);
  const url = `${baseUrl}${path}?${qs}&signature=${signature}`;
  const res = await fetch(url, { headers: { "X-MBX-APIKEY": apiKey } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Binance ${path} failed (${res.status}): ${body}`);
  }
  return res.json();
}

export async function getSpotBalances(apiKey, secret) {
  const data = await signedRequest(SPOT_BASE, "/api/v3/account", apiKey, secret, {
    omitZeroBalances: true,
  });
  return data.balances
    .map((b) => ({
      asset: b.asset,
      free: parseFloat(b.free),
      locked: parseFloat(b.locked),
      total: parseFloat(b.free) + parseFloat(b.locked),
    }))
    .filter((b) => b.total > 0);
}

export async function getFuturesPositions(apiKey, secret) {
  const data = await signedRequest(FUTURES_BASE, "/fapi/v2/positionRisk", apiKey, secret);
  return data
    .filter((p) => parseFloat(p.positionAmt) !== 0)
    .map((p) => ({
      symbol: p.symbol,
      side: parseFloat(p.positionAmt) > 0 ? "LONG" : "SHORT",
      size: Math.abs(parseFloat(p.positionAmt)),
      entryPrice: parseFloat(p.entryPrice),
      markPrice: parseFloat(p.markPrice),
      unrealizedPnl: parseFloat(p.unRealizedProfit),
      leverage: parseInt(p.leverage),
      marginType: p.marginType,
      notional: Math.abs(parseFloat(p.notional)),
    }));
}

export async function getSpotPrices(symbols) {
  const symbolsParam = JSON.stringify(symbols.map((s) => s.endsWith("USDT") ? s : s + "USDT"));
  const url = `${SPOT_BASE}/api/v3/ticker/price?symbols=${encodeURIComponent(symbolsParam)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Price fetch failed: ${res.status}`);
  const data = await res.json();
  const prices = {};
  for (const d of data) {
    prices[d.symbol.replace("USDT", "")] = parseFloat(d.price);
  }
  return prices;
}

export async function fetchBinancePortfolio(apiKey, secret) {
  const [spotBalances, futuresPositions] = await Promise.all([
    getSpotBalances(apiKey, secret).catch((e) => {
      console.error(`Spot fetch error: ${e.message}`);
      return [];
    }),
    getFuturesPositions(apiKey, secret).catch((e) => {
      console.error(`Futures fetch error: ${e.message}`);
      return [];
    }),
  ]);

  // Get prices for spot assets
  const stablecoins = new Set(["USDT", "USDC", "BUSD", "DAI", "TUSD", "FDUSD"]);
  const spotAssets = spotBalances
    .filter((b) => !stablecoins.has(b.asset))
    .filter((b) => b.total > 0);

  const priceSymbols = [...new Set(spotAssets.map((a) => a.asset + "USDT"))];

  let prices = {};
  if (priceSymbols.length > 0) {
    try {
      const url = `${SPOT_BASE}/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(priceSymbols))}`;
      const res = await fetch(url);
      const data = await res.json();
      for (const d of data) {
        prices[d.symbol.replace("USDT", "")] = parseFloat(d.price);
      }
    } catch (e) {
      console.error(`Price fetch error: ${e.message}`);
    }
  }

  // Build portfolio positions
  const positions = [];

  for (const bal of spotAssets) {
    const price = prices[bal.asset] || 0;
    if (price === 0) continue;
    positions.push({
      source: "binance-spot",
      asset: bal.asset,
      side: "LONG",
      size: bal.total,
      price,
      valueUsd: bal.total * price,
    });
  }

  // Add stablecoin balances
  const stableBal = spotBalances
    .filter((b) => stablecoins.has(b.asset))
    .reduce((sum, b) => sum + b.total, 0);

  for (const pos of futuresPositions) {
    const asset = pos.symbol.replace("USDT", "").replace("BUSD", "");
    positions.push({
      source: "binance-futures",
      asset,
      side: pos.side,
      size: pos.size,
      price: pos.markPrice,
      valueUsd: pos.notional,
      leverage: pos.leverage,
      unrealizedPnl: pos.unrealizedPnl,
    });
  }

  return { positions, stablecoinBalance: stableBal };
}
