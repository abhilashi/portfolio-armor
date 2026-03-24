const DERIVE_API = "https://api.lyra.finance";

export async function getInstruments(currency, type = "option") {
  const res = await fetch(`${DERIVE_API}/public/get_instruments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ currency, instrument_type: type, expired: false }),
  });
  if (!res.ok) throw new Error(`get_instruments failed: ${res.status}`);
  const data = await res.json();
  return data.result;
}

export async function getTicker(instrumentName) {
  const res = await fetch(`${DERIVE_API}/public/get_ticker`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instrument_name: instrumentName }),
  });
  if (!res.ok) throw new Error(`get_ticker failed: ${res.status}`);
  const data = await res.json();
  return data.result;
}

function parseInstrumentName(name) {
  const parts = name.split("-");
  return {
    currency: parts[0],
    expiry: parts[1],
    strike: parseFloat(parts[2]),
    type: parts[3], // C or P
  };
}

function parseTickerData(instrument, ticker) {
  const parsed = parseInstrumentName(instrument.instrument_name);
  const expiryDate = new Date(
    parseInt(parsed.expiry.slice(0, 4)),
    parseInt(parsed.expiry.slice(4, 6)) - 1,
    parseInt(parsed.expiry.slice(6, 8))
  );
  const dte = Math.max(1, Math.ceil((expiryDate - Date.now()) / 86400000));
  const op = ticker.option_pricing || {};

  return {
    instrument: instrument.instrument_name,
    strike: parsed.strike,
    type: parsed.type,
    expiry: parsed.expiry,
    expiryFormatted: expiryDate.toISOString().split("T")[0],
    dte,
    bidPrice: parseFloat(ticker.best_bid_price) || 0,
    askPrice: parseFloat(ticker.best_ask_price) || 0,
    markPrice: parseFloat(ticker.mark_price) || 0,
    bidAmount: parseFloat(ticker.best_bid_amount) || 0,
    askAmount: parseFloat(ticker.best_ask_amount) || 0,
    iv: parseFloat(op.iv) || 0,
    delta: parseFloat(op.delta) || 0,
    gamma: parseFloat(op.gamma) || 0,
    theta: parseFloat(op.theta) || 0,
    vega: parseFloat(op.vega) || 0,
    indexPrice: parseFloat(ticker.index_price) || 0,
  };
}

async function fetchTickersBatched(instruments) {
  const results = [];
  const batchSize = 8;

  for (let i = 0; i < instruments.length; i += batchSize) {
    const batch = instruments.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async (inst) => {
        try {
          const ticker = await getTicker(inst.instrument_name);
          return parseTickerData(inst, ticker);
        } catch {
          return null;
        }
      })
    );
    results.push(...batchResults.filter(Boolean));
  }

  return results;
}

// Fetch puts + calls for collar strategy
export async function fetchOptionsChain(currency, spotPrice) {
  const instruments = await getInstruments(currency);
  const active = instruments.filter((i) => i.option_details && i.is_active);

  // Puts: 70%-100% of spot  |  Calls: 100%-130% of spot
  const relevant = active.filter((i) => {
    const strike = parseFloat(i.option_details.strike);
    const type = i.option_details.option_type;
    if (type === "P") return strike >= spotPrice * 0.7 && strike <= spotPrice * 1.02;
    if (type === "C") return strike >= spotPrice * 0.98 && strike <= spotPrice * 1.35;
    return false;
  });

  console.error(`    ${relevant.length} relevant options (puts + calls)...`);

  const tickerData = await fetchTickersBatched(relevant);

  const puts = tickerData
    .filter((t) => t.type === "P")
    .sort((a, b) => a.expiry.localeCompare(b.expiry) || a.strike - b.strike);

  const calls = tickerData
    .filter((t) => t.type === "C")
    .sort((a, b) => a.expiry.localeCompare(b.expiry) || a.strike - b.strike);

  return { puts, calls };
}

// Legacy — still exported for backward compat
export async function fetchProtectivePuts(currency, spotPrice) {
  const { puts } = await fetchOptionsChain(currency, spotPrice);
  return puts;
}
