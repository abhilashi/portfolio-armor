# portfolio-armor

**Hedge your crypto portfolio in one command.** Reads your positions from Binance, any EVM wallet, or Solana — then recommends zero-cost protective collars using options on [Derive](https://derive.xyz).

```
npx portfolio-armor 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045
```

## What it does

```
                              ┌─────────────────────────┐
  Binance ─────┐              │  3-Leg Collar Strategy   │
  EVM wallet ──┼──→ positions │  ● Buy put   (floor)     │
  Solana ──────┘     + prices │  ● Sell put  (cap loss)  │
                              │  ● Sell call (fund it)   │
                              └────────────┬────────────┘
                                           │
                              Derive options chain API
                              (ETH + BTC, live pricing)
```

1. **Fetches your portfolio** — spot, futures, on-chain tokens across 4 EVM chains + Solana
2. **Scans Derive options** — finds puts and calls with matching expiries, real-time IV + greeks
3. **Optimizes a collar** — minimizes net cost while maximizing protection band width
4. **Shows the trade** — legs, P&L diagram, risk profile, execution plan with code snippets

## Demo output

```
PORTFOLIO POSITIONS
┌────┬──────────────────┬─────────────┬──────┬───────────┬────────────┬────────────┬────────┐
│ #  │ Source           │ Asset       │ Side │ Size      │ Price      │ Value      │ Weight │
├────┼──────────────────┼─────────────┼──────┼───────────┼────────────┼────────────┼────────┤
│ 1  │ onchain          │ ETH         │ LONG │ 32.4584   │ $2,155.92  │ $69,977.70 │ 47.7%  │
│ 2  │ onchain-ethereum │ BTC (WBTC)  │ LONG │ 0.001072  │ $70,751.88 │ $75.83     │ 0.1%   │
│ -  │ -                │ Stablecoins │ -    │ -         │ -          │ $76,233.29 │ 51.9%  │
└────┴──────────────────┴─────────────┴──────┴───────────┴────────────┴────────────┴────────┘

  Total Portfolio Value: $146,834.06

ETH COLLAR — 2026-04-23 (31d DTE)

  P&L
  ↑
  ╲╲╲╲╲╲╲╲╲╲╲━━━━━━━━━━━━━━━━━━━━━━━━╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱━━━━━━━━━━
             ↑1,800         ↑SPOT       ↑2,300
  unhedged  ━ protected  ╱ participates  ━ capped

LEGS
┌─────┬───────────┬─────────────────────┬────────┬─────────┬──────────────┬───────┐
│ Leg │ Action    │ Instrument          │ Strike │ Price   │ Credit/Debit │ IV    │
├─────┼───────────┼─────────────────────┼────────┼─────────┼──────────────┼───────┤
│ 1   │ BUY PUT   │ ETH-20260424-2100-P │ $2,100 │ $149.60 │ -$149.60     │ 72.4% │
│ 2   │ SELL PUT  │ ETH-20260424-1800-P │ $1,800 │ $46.41  │ +$46.41      │ 78.9% │
│ 3   │ SELL CALL │ ETH-20260424-2300-C │ $2,300 │ $104.04 │ +$104.04     │ 71.0% │
└─────┴───────────┴─────────────────────┴────────┴─────────┴──────────────┴───────┘

  NET CREDIT: $0.85/contract × 32.57 = $27.69 (0.04% of position)

RISK PROFILE
┌──────────────────────┬─────────────────┬────────────────────────────────────────────┐
│ Metric               │ Value           │ Note                                       │
├──────────────────────┼─────────────────┼────────────────────────────────────────────┤
│ Floor (long put)     │ $2,100          │ 97.4% of spot — full protection above this │
│ Max Loss Below       │ $1,800          │ 83.5% of spot — protection stops here      │
│ Ceiling (short call) │ $2,300          │ 106.7% of spot — upside capped here        │
│ Max Gain             │ +6.7%           │ $144.08 per unit before cap                │
│ Max Loss (in band)   │ -2.6%           │ $55.92 per unit + net premium              │
└──────────────────────┴─────────────────┴────────────────────────────────────────────┘
```

## Install

```bash
# Run directly (no install)
npx portfolio-armor 0xYourAddress

# Or install globally
npm install -g portfolio-armor
portfolio-armor 0xYourAddress
```

Only dependency: `ethers` (for EVM multicall reads).

## Usage

### EVM wallet (Ethereum + Arbitrum + Optimism + Base)

```bash
portfolio-armor 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045
```

Reads native ETH + all major ERC-20 tokens via Multicall3. Prices from DeFi Llama.

### Solana wallet

```bash
portfolio-armor 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU
```

Reads SOL + all SPL tokens. Prices from DeFi Llama + Jupiter fallback.

### Binance

```bash
export BINANCE_API_KEY=your_key
export BINANCE_API_SECRET=your_secret
portfolio-armor binance
```

Reads spot balances + futures positions.

### Options

```bash
# Hedge only 50% of each position
portfolio-armor 0xYourAddress --hedge-ratio 0.5

# Target 60-day expiry instead of 30
portfolio-armor 0xYourAddress --dte 60
```

| Flag | Default | Description |
|------|---------|-------------|
| `--hedge-ratio` | `1.0` | Fraction of each position to hedge |
| `--dte` | `30` | Preferred days to expiry |

## How the collar works

A 3-leg collar gives you **downside protection funded by capping your upside**:

```
  P&L
   ↑
   ╲╲╲╲╲╲━━━━━━━━━━━━━╱╱╱╱╱╱╱╱╱━━━━━━━━
         ↑sell put    ↑buy put  ↑sell call
         (max loss)   (floor)   (ceiling)

   Loss zone │ Protected │ Participate │ Capped
```

| Leg | Action | Purpose |
|-----|--------|---------|
| 1 | **Buy put** (ATM/slightly OTM) | Sets the protection floor |
| 2 | **Sell put** (deeper OTM) | Reduces cost; caps max protection |
| 3 | **Sell call** (OTM) | Funds the protection; caps upside |

The optimizer scores every valid combination across all available expiries and strikes, preferring:
- **Near-zero net cost** (credit > debit)
- **Wide protection band** (floor − max loss)
- **High ceiling** (more upside room)
- **DTE close to target**
- **On-screen liquidity** (real bids/asks vs mark-only)

## Supported assets

| Asset | Hedge available | Source |
|-------|----------------|--------|
| ETH | Yes — options on Derive | Put spread + covered call |
| BTC | Yes — options on Derive | Put spread + covered call |
| SOL, UNI, LINK, ARB, AAVE, etc. | No | Flagged as unhedgeable |

Derive supports European-style, USDC-settled options on ETH and BTC with up to 400-day expiry.

## Execution

The tool outputs ready-to-use execution plans:

- **Manual**: Trade each leg on [derive.xyz](https://derive.xyz)
- **API**: 3 × `POST /private/order` with EIP-712 signed orders
- **RFQ**: `send_rfq` all 3 legs as a block trade for best fills
- **Python SDK**: Copy-paste `derive-client` code snippets

Or skip the manual work entirely:

> **[Parachute](https://app.getparachute.xyz/)** executes the same collar strategy in one click — handles leg management, rolling, and execution automatically.

## Architecture

```
src/
├── index.mjs       # CLI entry point + arg parsing
├── binance.mjs     # Binance spot + futures reader (HMAC-signed)
├── onchain.mjs     # EVM multicall reader (4 chains)
├── solana.mjs      # Solana RPC + SPL token reader
├── derive.mjs      # Derive options chain fetcher
└── strategy.mjs    # Collar optimizer + terminal renderer
```

Zero external APIs require authentication (except Binance mode). All on-chain reads use public RPCs. Derive's public API is unauthenticated.

## License

MIT
