#!/usr/bin/env node

import { fetchBinancePortfolio } from "./binance.mjs";
import { fetchOnchainPortfolio } from "./onchain.mjs";
import { fetchSolanaPortfolio } from "./solana.mjs";
import { fetchOptionsChain } from "./derive.mjs";
import {
  computeCollarStrategy,
  formatPortfolioTable,
  formatCollarTable,
  formatExecutionPlan,
  formatSummary,
} from "./strategy.mjs";

// Solana addresses are base58, 32-44 chars, no 0/O/I/l
function isSolanaAddress(str) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(str);
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0];

  if (!mode) {
    console.error("Usage:");
    console.error("  node src/index.mjs binance              # Binance (needs BINANCE_API_KEY + BINANCE_API_SECRET)");
    console.error("  node src/index.mjs 0x1234...abcd        # EVM on-chain (ETH/Arb/OP/Base)");
    console.error("  node src/index.mjs <solana_address>     # Solana wallet");
    console.error("");
    console.error("Options:");
    console.error("  --hedge-ratio 0.5    Hedge 50% of positions (default: 1.0)");
    console.error("  --dte 30             Target days to expiry (default: 30)");
    console.error("");
    console.error("Strategy: 3-leg collar (buy put + sell lower put + sell call)");
    process.exit(1);
  }

  // Parse optional flags
  const config = {};
  for (let i = 1; i < args.length; i += 2) {
    if (args[i] === "--hedge-ratio") config.hedgeRatio = parseFloat(args[i + 1]);
    if (args[i] === "--dte") config.preferredDte = parseInt(args[i + 1]);
  }

  let portfolio;

  if (mode === "binance") {
    const apiKey = process.env.BINANCE_API_KEY;
    const secret = process.env.BINANCE_API_SECRET;
    if (!apiKey || !secret) {
      console.error("Error: BINANCE_API_KEY and BINANCE_API_SECRET environment variables required");
      process.exit(1);
    }
    console.error("Fetching Binance portfolio...");
    portfolio = await fetchBinancePortfolio(apiKey, secret);
  } else if (mode.startsWith("0x") && mode.length === 42) {
    console.error(`Fetching EVM on-chain portfolio for ${mode}...`);
    portfolio = await fetchOnchainPortfolio(mode);
  } else if (isSolanaAddress(mode)) {
    console.error(`Fetching Solana portfolio for ${mode}...`);
    portfolio = await fetchSolanaPortfolio(mode);
  } else {
    console.error(`Invalid mode: ${mode}. Use 'binance', an EVM address (0x...), or a Solana address`);
    process.exit(1);
  }

  if (portfolio.positions.length === 0) {
    console.error("No positions found.");
    process.exit(0);
  }

  // Display portfolio
  console.log(formatPortfolioTable(portfolio.positions, portfolio.stablecoinBalance));

  // Group + aggregate positions by base asset
  const assetGroups = {};
  for (const pos of portfolio.positions) {
    if (!assetGroups[pos.asset]) assetGroups[pos.asset] = [];
    assetGroups[pos.asset].push(pos);
  }

  const aggregated = [];
  for (const [asset, positions] of Object.entries(assetGroups)) {
    const longs = positions.filter((p) => p.side === "LONG");
    if (longs.length === 0) continue;
    const totalSize = longs.reduce((s, p) => s + p.size, 0);
    const totalValue = longs.reduce((s, p) => s + p.valueUsd, 0);
    aggregated.push({
      source: "aggregated",
      asset,
      side: "LONG",
      size: totalSize,
      price: totalValue / totalSize,
      valueUsd: totalValue,
    });
  }

  // Derive supports ETH and BTC options
  const deriveAssets = ["ETH", "BTC"];
  const hedgeableAssets = aggregated.filter((p) => deriveAssets.includes(p.asset));
  const nonHedgeable = aggregated.filter((p) => !deriveAssets.includes(p.asset));

  console.error("\nFetching Derive options chain (puts + calls)...");

  // Fetch full options chain for each hedgeable asset
  const chainByAsset = {};
  for (const pos of hedgeableAssets) {
    console.error(`  ${pos.asset}:`);
    try {
      chainByAsset[pos.asset] = await fetchOptionsChain(pos.asset, pos.price);
      const { puts, calls } = chainByAsset[pos.asset];
      console.error(`    ${puts.length} puts, ${calls.length} calls`);
    } catch (e) {
      console.error(`    Error: ${e.message}`);
      chainByAsset[pos.asset] = { puts: [], calls: [] };
    }
  }

  // Compute 3-leg collar strategy
  const allPositions = [...hedgeableAssets, ...nonHedgeable];
  const recommendations = computeCollarStrategy(allPositions, chainByAsset, config);

  // Output
  console.log(formatCollarTable(recommendations));
  console.log(formatExecutionPlan(recommendations));

  const totalPortfolio = portfolio.positions.reduce((s, p) => s + p.valueUsd, 0) + portfolio.stablecoinBalance;
  console.log(formatSummary(recommendations, totalPortfolio));
}

main().catch((e) => {
  console.error(`Fatal error: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
