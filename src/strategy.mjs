// Portfolio insurance strategy engine — 3-leg collar (put spread + covered call)

// ── Terminal table renderer ────────────────────────────────────────────
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const WHITE = "\x1b[97m";
const MAGENTA = "\x1b[35m";

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderTable(headers, rows, { title, color = CYAN } = {}) {
  const widths = headers.map((h, i) =>
    Math.max(
      stripAnsi(h).length,
      ...rows.map((r) => stripAnsi(String(r[i] ?? "")).length)
    )
  );

  const TOP_L = "┌", TOP_R = "┐", BOT_L = "└", BOT_R = "┘";
  const MID_L = "├", MID_R = "┤", H = "─", V = "│";
  const T_DOWN = "┬", T_UP = "┴", CROSS = "┼";

  const line = (l, m, r) =>
    l + widths.map((w) => H.repeat(w + 2)).join(m) + r;

  const row = (cells, style = "") =>
    V +
    cells
      .map((c, i) => {
        const s = String(c ?? "");
        const pad = widths[i] - stripAnsi(s).length;
        return ` ${style}${s}${style ? RESET : ""}${" ".repeat(Math.max(0, pad))} `;
      })
      .join(V) +
    V;

  let out = "";
  if (title) out += `\n${color}${BOLD}${title}${RESET}\n`;
  out += `${DIM}${line(TOP_L, T_DOWN, TOP_R)}${RESET}\n`;
  out += `${row(headers, BOLD)}\n`;
  out += `${DIM}${line(MID_L, CROSS, MID_R)}${RESET}\n`;
  for (const r of rows) {
    out += `${row(r)}\n`;
  }
  out += `${DIM}${line(BOT_L, T_UP, BOT_R)}${RESET}\n`;
  return out;
}

// ── 3-Leg Collar Strategy ─────────────────────────────────────────────
//
//  Leg 1: BUY put  (floor)       — e.g. 92% of spot
//  Leg 2: SELL put (cap floor)   — e.g. 80% of spot
//  Leg 3: SELL call (cap upside) — e.g. 108% of spot
//
//  Net debit = (long put ask) - (short put bid) - (short call bid)
//  Target: net debit ≈ 0 (zero-cost collar)

export function computeCollarStrategy(positions, chainByAsset, config = {}) {
  const {
    hedgeRatio = 1.0,
    preferredDte = 30,
    dteRange = [7, 90],
    // Target strikes as % of spot
    longPutRange = [0.88, 0.98],   // floor
    shortPutRange = [0.75, 0.88],  // lower bound of protection
    shortCallRange = [1.03, 1.20], // upside cap
  } = config;

  const recommendations = [];

  for (const pos of positions) {
    if (pos.side !== "LONG") continue;

    const chain = chainByAsset[pos.asset];
    if (!chain || !chain.puts.length || !chain.calls.length) {
      recommendations.push({
        position: pos,
        collar: null,
        reason: chain
          ? `Not enough options on Derive for ${pos.asset} (${chain.puts.length}P / ${chain.calls.length}C)`
          : `No options available on Derive for ${pos.asset}`,
      });
      continue;
    }

    const { puts, calls } = chain;
    const spot = pos.price;

    // Filter by DTE
    const validPuts = puts.filter((p) => p.dte >= dteRange[0] && p.dte <= dteRange[1]);
    const validCalls = calls.filter((c) => c.dte >= dteRange[0] && c.dte <= dteRange[1]);

    // Candidate legs
    const longPutCands = validPuts.filter((p) => {
      const r = p.strike / spot;
      return r >= longPutRange[0] && r <= longPutRange[1];
    });
    const shortPutCands = validPuts.filter((p) => {
      const r = p.strike / spot;
      return r >= shortPutRange[0] && r <= shortPutRange[1];
    });
    const shortCallCands = validCalls.filter((c) => {
      const r = c.strike / spot;
      return r >= shortCallRange[0] && r <= shortCallRange[1];
    });

    if (longPutCands.length === 0) {
      recommendations.push({
        position: pos,
        collar: null,
        reason: `No suitable long puts for ${pos.asset} (need ${(longPutRange[0]*100).toFixed(0)}-${(longPutRange[1]*100).toFixed(0)}% strike)`,
      });
      continue;
    }

    // Score all valid 3-leg combos (same expiry required)
    const combos = [];

    for (const lp of longPutCands) {
      // Short put: same expiry, lower strike
      const spCands = shortPutCands.filter(
        (sp) => sp.expiry === lp.expiry && sp.strike < lp.strike
      );
      // Short call: same expiry
      const scCands = shortCallCands.filter((sc) => sc.expiry === lp.expiry);

      for (const sp of spCands) {
        for (const sc of scCands) {
          // Price to pay for long put
          const lpCost = lp.askPrice > 0 ? lp.askPrice : lp.markPrice;
          // Credit from short put (use bid if available, else mark * discount)
          const spCredit = sp.bidPrice > 0 ? sp.bidPrice : sp.markPrice * 0.85;
          // Credit from short call
          const scCredit = sc.bidPrice > 0 ? sc.bidPrice : sc.markPrice * 0.85;

          const netDebit = lpCost - spCredit - scCredit;
          const netDebitPct = netDebit / spot;

          // Protection range
          const floor = lp.strike;       // protected down to here (full)
          const maxLoss = sp.strike;     // below this, no more protection
          const ceiling = sc.strike;     // upside capped here

          // Score: prefer zero-cost, good DTE match, wide protection, high ceiling
          const costScore = Math.abs(netDebitPct) * 15; // prefer near zero
          const costPenalty = netDebit > 0 ? netDebitPct * 5 : 0; // small penalty for debit
          const dteScore = Math.abs(lp.dte - preferredDte) / preferredDte;
          const floorScore = (1 - floor / spot) * 2; // prefer higher floor
          const ceilingScore = (1 - ceiling / spot) * -1; // prefer higher ceiling
          const widthScore = (floor - maxLoss) / spot; // wider = more protection = good (small bonus)
          const liquidityScore =
            (lp.askAmount > 0 ? 0 : 0.3) +
            (sp.bidAmount > 0 ? 0 : 0.2) +
            (sc.bidAmount > 0 ? 0 : 0.2);

          const score =
            costScore + costPenalty + dteScore + floorScore + ceilingScore - widthScore * 0.5 + liquidityScore;

          combos.push({
            longPut: lp,
            shortPut: sp,
            shortCall: sc,
            lpCost,
            spCredit,
            scCredit,
            netDebit,
            netDebitPct,
            floor,
            maxLoss,
            ceiling,
            dte: lp.dte,
            expiry: lp.expiryFormatted,
            score,
          });
        }
      }
    }

    if (combos.length === 0) {
      recommendations.push({
        position: pos,
        collar: null,
        reason: `No valid 3-leg combos for ${pos.asset} (need matching expiries across puts + calls)`,
      });
      continue;
    }

    combos.sort((a, b) => a.score - b.score);
    const best = combos[0];
    const alts = combos.slice(1, 4); // next 3 alternatives

    const contracts = pos.size * hedgeRatio;

    recommendations.push({
      position: pos,
      collar: {
        primary: {
          ...best,
          contracts: parseFloat(contracts.toFixed(4)),
          totalDebit: best.netDebit * contracts,
          totalDebitPct: (best.netDebit * contracts) / pos.valueUsd * 100,
        },
        alternatives: alts.map((a) => ({
          ...a,
          contracts: parseFloat(contracts.toFixed(4)),
          totalDebit: a.netDebit * contracts,
        })),
      },
    });
  }

  return recommendations;
}

// ── Formatted output ──────────────────────────────────────────────────

export function formatPortfolioTable(positions, stablecoinBalance) {
  const totalValue =
    positions.reduce((s, p) => s + p.valueUsd, 0) + stablecoinBalance;

  const sorted = [...positions].sort((a, b) => b.valueUsd - a.valueUsd);

  const headers = ["#", "Source", "Asset", "Side", "Size", "Price", "Value", "Weight"];
  const rows = sorted.map((p, i) => {
    const pct = ((p.valueUsd / totalValue) * 100).toFixed(1);
    const extra = p.originalToken && p.originalToken !== p.asset ? ` (${p.originalToken})` : "";
    const lev = p.leverage ? ` ${p.leverage}x` : "";
    return [
      i + 1,
      p.source,
      `${p.asset}${extra}`,
      `${p.side}${lev}`,
      fmtNum(p.size),
      `$${fmtNum(p.price, 2)}`,
      `${GREEN}$${fmtNum(p.valueUsd, 2)}${RESET}`,
      `${pct}%`,
    ];
  });

  if (stablecoinBalance > 0) {
    const pct = ((stablecoinBalance / totalValue) * 100).toFixed(1);
    rows.push([
      `${DIM}-${RESET}`,
      `${DIM}-${RESET}`,
      "Stablecoins",
      `${DIM}-${RESET}`,
      `${DIM}-${RESET}`,
      `${DIM}-${RESET}`,
      `${GREEN}$${fmtNum(stablecoinBalance, 2)}${RESET}`,
      `${pct}%`,
    ]);
  }

  let out = renderTable(headers, rows, { title: "PORTFOLIO POSITIONS" });
  out += `\n  ${BOLD}Total Portfolio Value: ${GREEN}$${fmtNum(totalValue, 2)}${RESET}\n`;
  return out;
}

export function formatCollarTable(recommendations) {
  let out = "";

  const hedgeable = recommendations.filter((r) => r.collar);
  const unhedgeable = recommendations.filter((r) => !r.collar);

  if (hedgeable.length === 0) {
    out += `\n${YELLOW}No collar structures available on Derive.${RESET}\n`;
    if (unhedgeable.length > 0) {
      out += formatUnhedgeable(unhedgeable);
    }
    return out;
  }

  // ── Structure overview per asset ───────────────────────────────────
  for (const rec of hedgeable) {
    const c = rec.collar.primary;
    const spot = rec.position.price;
    const asset = rec.position.asset;

    out += `\n${MAGENTA}${BOLD}${asset} COLLAR — ${c.expiry} (${c.dte}d DTE)${RESET}\n`;

    // Payoff diagram
    out += formatPayoffAscii(c, spot);

    // 3-leg table
    const legHeaders = ["Leg", "Action", "Instrument", "Strike", "% Spot", "Price", "Credit/Debit", "IV", "Delta", "Liq"];
    const legRows = [
      [
        `${GREEN}1${RESET}`,
        `${RED}BUY PUT${RESET}`,
        `${CYAN}${c.longPut.instrument}${RESET}`,
        `$${fmtNum(c.longPut.strike, 0)}`,
        `${((c.longPut.strike / spot) * 100).toFixed(1)}%`,
        `$${fmtNum(c.lpCost, 2)}`,
        `${RED}-$${fmtNum(c.lpCost, 2)}${RESET}`,
        `${(c.longPut.iv * 100).toFixed(1)}%`,
        c.longPut.delta.toFixed(3),
        c.longPut.askAmount > 0 ? `${GREEN}Yes${RESET}` : `${DIM}Mark${RESET}`,
      ],
      [
        `${GREEN}2${RESET}`,
        `${GREEN}SELL PUT${RESET}`,
        `${CYAN}${c.shortPut.instrument}${RESET}`,
        `$${fmtNum(c.shortPut.strike, 0)}`,
        `${((c.shortPut.strike / spot) * 100).toFixed(1)}%`,
        `$${fmtNum(c.spCredit, 2)}`,
        `${GREEN}+$${fmtNum(c.spCredit, 2)}${RESET}`,
        `${(c.shortPut.iv * 100).toFixed(1)}%`,
        c.shortPut.delta.toFixed(3),
        c.shortPut.bidAmount > 0 ? `${GREEN}Yes${RESET}` : `${DIM}Mark${RESET}`,
      ],
      [
        `${GREEN}3${RESET}`,
        `${GREEN}SELL CALL${RESET}`,
        `${CYAN}${c.shortCall.instrument}${RESET}`,
        `$${fmtNum(c.shortCall.strike, 0)}`,
        `${((c.shortCall.strike / spot) * 100).toFixed(1)}%`,
        `$${fmtNum(c.scCredit, 2)}`,
        `${GREEN}+$${fmtNum(c.scCredit, 2)}${RESET}`,
        `${(c.shortCall.iv * 100).toFixed(1)}%`,
        c.shortCall.delta.toFixed(3),
        c.shortCall.bidAmount > 0 ? `${GREEN}Yes${RESET}` : `${DIM}Mark${RESET}`,
      ],
    ];

    out += renderTable(legHeaders, legRows, { title: "LEGS", color: CYAN });

    // Net cost
    const netColor = c.netDebit <= 0 ? GREEN : YELLOW;
    const netLabel = c.netDebit <= 0 ? "NET CREDIT" : "NET DEBIT";
    const netPerUnit = Math.abs(c.netDebit);
    const netTotal = Math.abs(c.totalDebit);

    out += `\n  ${BOLD}${netColor}${netLabel}: $${fmtNum(netPerUnit, 2)}/contract × ${c.contracts} = $${fmtNum(netTotal, 2)}${RESET}`;
    out += ` ${DIM}(${Math.abs(c.totalDebitPct).toFixed(2)}% of position)${RESET}\n`;

    // Risk profile
    const profileHeaders = ["Metric", "Value", "Note"];
    const profileRows = [
      [
        "Spot Price",
        `$${fmtNum(spot, 2)}`,
        "Current index price",
      ],
      [
        `${GREEN}Floor (long put)${RESET}`,
        `$${fmtNum(c.floor, 0)}`,
        `${((c.floor / spot) * 100).toFixed(1)}% of spot — full protection above this`,
      ],
      [
        `${YELLOW}Max Loss Below${RESET}`,
        `$${fmtNum(c.maxLoss, 0)}`,
        `${((c.maxLoss / spot) * 100).toFixed(1)}% of spot — protection stops here`,
      ],
      [
        "Protection Band",
        `$${fmtNum(c.maxLoss, 0)} → $${fmtNum(c.floor, 0)}`,
        `Hedged zone: ${((c.floor - c.maxLoss) / spot * 100).toFixed(1)}% wide`,
      ],
      [
        `${RED}Ceiling (short call)${RESET}`,
        `$${fmtNum(c.ceiling, 0)}`,
        `${((c.ceiling / spot) * 100).toFixed(1)}% of spot — upside capped here`,
      ],
      [
        "Max Gain",
        `${GREEN}+${(((c.ceiling - spot) / spot) * 100).toFixed(1)}%${RESET}`,
        `$${fmtNum(c.ceiling - spot, 2)} per unit before cap`,
      ],
      [
        "Max Loss (in band)",
        `${RED}-${(((spot - c.floor) / spot) * 100).toFixed(1)}%${RESET}`,
        `$${fmtNum(spot - c.floor, 2)} per unit + net premium`,
      ],
      [
        "Net Delta",
        (c.longPut.delta - c.shortPut.delta - c.shortCall.delta).toFixed(3),
        "Combined position greeks",
      ],
    ];

    out += renderTable(profileHeaders, profileRows, { title: "RISK PROFILE", color: WHITE });
  }

  // ── Alternatives ───────────────────────────────────────────────────
  const withAlts = hedgeable.filter((r) => r.collar.alternatives.length > 0);
  if (withAlts.length > 0) {
    const altHeaders = ["Asset", "Floor", "Max Loss", "Ceiling", "Expiry", "DTE", "Net $/unit", "Net Total", "Type"];
    const altRows = [];

    for (const rec of withAlts) {
      for (const alt of rec.collar.alternatives) {
        const netColor = alt.netDebit <= 0 ? GREEN : YELLOW;
        const netLabel = alt.netDebit <= 0 ? "credit" : "debit";
        altRows.push([
          rec.position.asset,
          `$${fmtNum(alt.floor, 0)}`,
          `$${fmtNum(alt.maxLoss, 0)}`,
          `$${fmtNum(alt.ceiling, 0)}`,
          alt.expiry,
          `${alt.dte}d`,
          `${netColor}$${fmtNum(Math.abs(alt.netDebit), 2)}${RESET}`,
          `${netColor}$${fmtNum(Math.abs(alt.totalDebit), 2)}${RESET}`,
          `${DIM}${netLabel}${RESET}`,
        ]);
      }
    }
    out += renderTable(altHeaders, altRows, { title: "ALTERNATIVE COLLARS", color: DIM });
  }

  // ── Unhedgeable ────────────────────────────────────────────────────
  if (unhedgeable.length > 0) {
    out += formatUnhedgeable(unhedgeable);
  }

  return out;
}

function formatUnhedgeable(unhedgeable) {
  const uhHeaders = ["Asset", "Value", "Reason"];
  const uhRows = unhedgeable.map((rec) => [
    rec.position.asset,
    `$${fmtNum(rec.position.valueUsd, 2)}`,
    `${DIM}${rec.reason}${RESET}`,
  ]);
  return renderTable(uhHeaders, uhRows, { title: "NO HEDGE AVAILABLE", color: RED });
}

function formatPayoffAscii(collar, spot) {
  const { floor, maxLoss, ceiling } = collar;
  const W = 60;

  // Scale: show from maxLoss * 0.9 to ceiling * 1.05
  const lo = maxLoss * 0.92;
  const hi = ceiling * 1.05;
  const scale = (v) => Math.round(((v - lo) / (hi - lo)) * W);

  const sp = scale(spot);
  const fl = scale(floor);
  const ml = scale(maxLoss);
  const cl = scale(ceiling);

  let line1 = " ".repeat(W + 1);
  let line2 = "";

  // Build the payoff shape
  for (let i = 0; i <= W; i++) {
    if (i < ml) line2 += `${RED}╲${RESET}`;
    else if (i < fl) line2 += `${GREEN}━${RESET}`;
    else if (i < cl) line2 += `${WHITE}╱${RESET}`;
    else line2 += `${YELLOW}━${RESET}`;
  }

  // Markers
  const markers = [
    { pos: ml, label: `${fmtNum(maxLoss, 0)}`, color: YELLOW },
    { pos: fl, label: `${fmtNum(floor, 0)}`, color: GREEN },
    { pos: sp, label: `SPOT`, color: WHITE },
    { pos: cl, label: `${fmtNum(ceiling, 0)}`, color: YELLOW },
  ].sort((a, b) => a.pos - b.pos);

  let markerLine = " ".repeat(W + 1);
  for (const m of markers) {
    const p = Math.max(0, Math.min(W, m.pos));
    const label = `${m.color}↑${stripAnsi(m.label)}${RESET}`;
    const rawLabel = `↑${stripAnsi(m.label)}`;
    // Place label at position
    const before = markerLine.slice(0, p);
    const after = markerLine.slice(p + rawLabel.length);
    markerLine = before + label + after;
  }

  let out = `\n  ${DIM}P&L${RESET}\n`;
  out += `  ${DIM}↑${RESET}\n`;
  out += `  ${line2}\n`;
  out += `  ${markerLine}\n`;
  out += `  ${DIM}${RED}unhedged${RESET}  ${GREEN}━ protected${RESET}  ${WHITE}╱ participates${RESET}  ${YELLOW}━ capped${RESET}\n\n`;

  return out;
}

export function formatExecutionPlan(recommendations) {
  const hedgeable = recommendations.filter((r) => r.collar);
  if (hedgeable.length === 0) return "";

  let out = `\n${CYAN}${BOLD}EXECUTION PLAN${RESET}\n`;

  for (const rec of hedgeable) {
    const c = rec.collar.primary;
    const asset = rec.position.asset;

    // Check which legs have on-screen liquidity
    const lpLiq = c.longPut.askAmount > 0;
    const spLiq = c.shortPut.bidAmount > 0;
    const scLiq = c.shortCall.bidAmount > 0;
    const allLiq = lpLiq && spLiq && scLiq;

    out += `\n  ${BOLD}${asset}${RESET} — ${c.contracts} contracts × 3 legs\n`;

    if (allLiq) {
      out += `  ${GREEN}All legs have on-screen liquidity → execute as 3 limit orders${RESET}\n`;
    } else {
      out += `  ${YELLOW}Some legs are mark-only → use RFQ for best fills${RESET}\n`;
    }

    out += `  ${WHITE}→${RESET} BUY  ${c.longPut.instrument} @ $${fmtNum(c.lpCost, 2)} ${lpLiq ? `${GREEN}(ask)${RESET}` : `${DIM}(mark)${RESET}`}\n`;
    out += `  ${WHITE}→${RESET} SELL ${c.shortPut.instrument} @ $${fmtNum(c.spCredit, 2)} ${spLiq ? `${GREEN}(bid)${RESET}` : `${DIM}(mark)${RESET}`}\n`;
    out += `  ${WHITE}→${RESET} SELL ${c.shortCall.instrument} @ $${fmtNum(c.scCredit, 2)} ${scLiq ? `${GREEN}(bid)${RESET}` : `${DIM}(mark)${RESET}`}\n`;
  }

  // Method table
  const methHeaders = ["Method", "Best For", "How"];
  const methRows = [
    ["derive.xyz", "Manual / visual", "Trade each leg separately on the UI"],
    ["API (3 orders)", "Programmatic", "3 × POST /private/order + EIP-712 sig"],
    ["API (RFQ)", "Best price / block", "send_rfq with all 3 legs → execute_quote"],
    ["derive-client", "Python scripts", "pip install derive-client"],
  ];
  out += renderTable(methHeaders, methRows, { title: "EXECUTION METHODS", color: DIM });

  // Python snippet
  out += `\n  ${DIM}pip install derive-client${RESET}\n\n`;

  for (const rec of hedgeable) {
    const c = rec.collar.primary;
    const asset = rec.position.asset;

    out += `  ${CYAN}# ${asset} collar — ${c.expiry}${RESET}\n`;
    out += `  ${WHITE}# Leg 1: Buy put (floor)${RESET}\n`;
    out += `  ${WHITE}client.orders.create(instrument_name="${c.longPut.instrument}",${RESET}\n`;
    out += `  ${WHITE}    amount=D("${c.contracts}"), limit_price=D("${c.lpCost.toFixed(2)}"),${RESET}\n`;
    out += `  ${WHITE}    direction=Direction.buy, order_type=OrderType.limit)${RESET}\n\n`;

    out += `  ${WHITE}# Leg 2: Sell put (reduce cost)${RESET}\n`;
    out += `  ${WHITE}client.orders.create(instrument_name="${c.shortPut.instrument}",${RESET}\n`;
    out += `  ${WHITE}    amount=D("${c.contracts}"), limit_price=D("${c.spCredit.toFixed(2)}"),${RESET}\n`;
    out += `  ${WHITE}    direction=Direction.sell, order_type=OrderType.limit)${RESET}\n\n`;

    out += `  ${WHITE}# Leg 3: Sell call (fund protection)${RESET}\n`;
    out += `  ${WHITE}client.orders.create(instrument_name="${c.shortCall.instrument}",${RESET}\n`;
    out += `  ${WHITE}    amount=D("${c.contracts}"), limit_price=D("${c.scCredit.toFixed(2)}"),${RESET}\n`;
    out += `  ${WHITE}    direction=Direction.sell, order_type=OrderType.limit)${RESET}\n\n`;
  }

  return out;
}

export function formatSummary(recommendations, totalPortfolio) {
  const hedged = recommendations.filter((r) => r.collar);
  const nonHedgeable = recommendations.filter((r) => !r.collar);
  const hedgedValue = hedged.reduce((s, r) => s + r.position.valueUsd, 0);
  const totalDebit = hedged.reduce((s, r) => s + (r.collar?.primary?.totalDebit || 0), 0);

  const netLabel = totalDebit <= 0 ? `${GREEN}NET CREDIT${RESET}` : `${YELLOW}NET DEBIT${RESET}`;

  const headers = ["Metric", "Value"];
  const rows = [
    ["Total Portfolio", `${GREEN}$${fmtNum(totalPortfolio, 2)}${RESET}`],
    ["Hedgeable (ETH/BTC)", `$${fmtNum(hedgedValue, 2)} (${((hedgedValue / totalPortfolio) * 100).toFixed(1)}%)`],
    ["Collar Cost", `${netLabel} $${fmtNum(Math.abs(totalDebit), 2)}`],
    ["Cost % of Portfolio", `${(Math.abs(totalDebit) / totalPortfolio * 100).toFixed(2)}%`],
    ["Strategy", "Put Spread + Covered Call (3-leg collar)"],
    ["Unhedgeable", `${nonHedgeable.length} (${nonHedgeable.map((p) => p.position.asset).join(", ") || "none"})`],
  ];

  let out = renderTable(headers, rows, { title: "SUMMARY", color: WHITE });

  // Parachute CTA
  out += `\n  ${CYAN}${BOLD}Execute this strategy in one click:${RESET}\n`;
  out += `  ${WHITE}${BOLD}https://app.getparachute.xyz/${RESET}\n`;
  out += `  ${DIM}Parachute lets you protect your ETH & BTC with the same collar structures — no manual leg management.${RESET}\n`;

  return out;
}

function fmtNum(n, decimals) {
  if (decimals === undefined) {
    if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
    if (n >= 1) return n.toFixed(4);
    if (n >= 0.0001) return n.toFixed(6);
    return n.toExponential(4);
  }
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
