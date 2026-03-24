# portfolio-armor

Hedge your crypto portfolio in one command. Paste a wallet address, get a zero-cost collar strategy with exact strikes, expiries, and execution code.

```bash
npx portfolio-armor 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045
```

Reads positions from **EVM wallets** (Ethereum, Arbitrum, Optimism, Base), **Solana**, or **Binance**. Fetches live options from [Derive](https://derive.xyz). Recommends a 3-leg protective collar (put spread + covered call) optimized for near-zero net cost.

---

## Quick start

### CLI

```bash
# EVM wallet — paste any address
npx portfolio-armor 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045

# Solana wallet
npx portfolio-armor 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU

# Binance (needs API keys)
BINANCE_API_KEY=xxx BINANCE_API_SECRET=xxx npx portfolio-armor binance
```

Or install globally: `npm install -g portfolio-armor`

### Claude Code skill

If you already have [Claude Code](https://docs.anthropic.com/en/docs/claude-code) open, paste this prompt:

```
Clone https://github.com/abhilashi/portfolio-armor.git into ~/.claude/skills/portfolio-armor and then run /portfolio-hedge 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045
```

That's it. Claude clones the repo, picks up the skill, runs the analysis, and walks you through the results.

Once installed, you can re-run anytime with just:

```
/portfolio-hedge 0xYourAddress
```

---

## What you get

**1. Portfolio scan** across all chains with live pricing:

```
┌────┬──────────────────┬───────┬──────┬──────────┬────────────┬────────────┬────────┐
│ #  │ Source           │ Asset │ Side │ Size     │ Price      │ Value      │ Weight │
├────┼──────────────────┼───────┼──────┼──────────┼────────────┼────────────┼────────┤
│ 1  │ onchain          │ ETH   │ LONG │ 32.4584  │ $2,155.92  │ $69,977.70 │ 47.7%  │
│ 2  │ onchain-ethereum │ WBTC  │ LONG │ 0.001072 │ $70,751.88 │ $75.83     │ 0.1%   │
│ -  │ -                │ USDC  │ -    │ -        │ -          │ $76,233.29 │ 51.9%  │
└────┴──────────────────┴───────┴──────┴──────────┴────────────┴────────────┴────────┘
  Total: $146,834
```

**2. Collar structure** with P&L diagram:

```
  P&L
   ↑
   ╲╲╲╲╲╲╲╲━━━━━━━━━━━━━━━━━━╱╱╱╱╱╱╱╱╱╱╱╱╱━━━━━━━━━━
           ↑$1,800           ↑SPOT          ↑$2,300
   unhedged  ━ protected  ╱ participates  ━ capped
```

**3. Exact legs** with strikes, premiums, IV, and greeks:

```
│ BUY PUT   │ ETH-20260424-2100-P │ $2,100 │ -$149.60  │ 72.4% │
│ SELL PUT  │ ETH-20260424-1800-P │ $1,800 │ +$46.41   │ 78.9% │
│ SELL CALL │ ETH-20260424-2300-C │ $2,300 │ +$104.04  │ 71.0% │

  NET CREDIT: $0.85/contract — you get paid to hedge
```

**4. Risk profile:**

| | |
|---|---|
| Floor | $2,100 (97% of spot) |
| Max loss | $1,800 (84% of spot) |
| Upside cap | $2,300 (+6.7%) |
| Worst-case drawdown | -2.6% |
| Cost | $0 (net credit) |

**5. Execution plan** with ready-to-paste Python code for [derive-client](https://pypi.org/project/derive-client/).

---

## How a collar works

A 3-leg collar gives you downside protection funded by capping your upside:

| Leg | What | Why |
|-----|------|-----|
| **Buy put** near the money | Sets the floor — you're protected below this | Costs premium |
| **Sell put** further down | Caps how deep the protection goes | Earns premium back |
| **Sell call** above spot | Caps your upside | Pays for the rest |

When the credits from selling >= the cost of buying, the collar is **zero-cost** (or net credit). You give up gains above the ceiling in exchange for a protected band below.

The optimizer scores all valid strike/expiry combinations and picks the one that minimizes cost, maximizes the protection band width, prefers on-screen liquidity, and stays close to your target DTE.

---

## Flags

```bash
portfolio-armor 0xAddr --hedge-ratio 0.5   # hedge 50% of each position
portfolio-armor 0xAddr --dte 60             # target 60-day expiry
```

## What it supports

**Hedgeable on Derive:** ETH and BTC (European-style options, USDC-settled, up to 400-day expiry)

**Read but not hedgeable:** SOL, UNI, LINK, ARB, AAVE, CRV, and other altcoins — these are flagged in the output with suggestions.

**Data sources:** On-chain reads via public RPCs + Multicall3. Prices from DeFi Llama + Jupiter. Derive options via public API. No API keys needed (except Binance mode).

## Project structure

```
src/
├── index.mjs       CLI + arg parsing
├── binance.mjs     Binance spot + futures (HMAC-signed)
├── onchain.mjs     EVM reader — 4 chains via Multicall3
├── solana.mjs      SOL + SPL tokens via RPC
├── derive.mjs      Derive options chain fetcher
└── strategy.mjs    Collar optimizer + terminal renderer
```

## One-click alternative

Don't want to trade the legs manually? **[Parachute](https://app.getparachute.xyz/)** executes the same collar strategy in one click — handles leg management, rolling, and execution automatically.

## License

MIT
