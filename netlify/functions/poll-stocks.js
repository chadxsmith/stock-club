// Scheduled Netlify Function: keeps the shared Blobs store warm so per-request
// traffic (chat, quotes.js, analyst.js) reads a cache instead of calling
// Finnhub. Requires FINNHUB_API_KEY. Runs every 2 minutes — see netlify.toml.
//
// Rate-limit math (this is the whole design constraint): Finnhub's free tier
// allows ~60 calls/minute on one shared key. Polling every tracked ticker's
// quote AND analyst rating each run was ~130 calls fired in a couple of
// seconds, so the poller itself got 429'd, the store stayed empty, and user
// requests fell through to live Finnhub calls that got 429'd too.
//
// Instead we rotate: each run refreshes a slice of the universe, so the full
// list comes around every few minutes and each run stays far under the limit,
// leaving headroom for live user traffic.
const { stockStore, getStockRecord, setStockRecord } = require('./lib/stock-store');
const TICKERS = require('./lib/tracked-tickers');

// Universe is 88 tickers. At 24/run every 2 min the full list comes around in
// ~7.3 min, which must stay under quotes.js STORE_TTL_MS (15 min) or records
// expire before the rotation returns to them.
const CHUNK = 24;              // tickers refreshed per run (~24 quote calls)
const MAX_ANALYST_PER_RUN = 8; // ratings move slowly; refresh a few per run
const ANALYST_TTL_MS = 12 * 60 * 60 * 1000;
const CURSOR_KEY = '__poll_cursor';

async function readCursor() {
  try {
    const rec = await stockStore().get(CURSOR_KEY, { type: 'json' });
    return (rec && typeof rec.i === 'number') ? rec.i : 0;
  } catch (e) { return 0; }
}
async function writeCursor(i) {
  try { await stockStore().set(CURSOR_KEY, JSON.stringify({ i })); } catch (e) { /* non-fatal */ }
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

exports.handler = async () => {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) return { statusCode: 500, body: 'FINNHUB_API_KEY not set' };

  const start = await readCursor();
  const slice = [];
  for (let n = 0; n < Math.min(CHUNK, TICKERS.length); n++) {
    slice.push(TICKERS[(start + n) % TICKERS.length]);
  }

  // Existing records tell us both what analyst data we already have and what to
  // preserve when we only refresh the quote this run.
  const existing = {};
  await Promise.all(slice.map(async (sym) => {
    try { existing[sym] = await getStockRecord(sym); } catch (e) { existing[sym] = null; }
  }));

  const needAnalyst = slice.filter((sym) => {
    const r = existing[sym];
    return !r || !r.analystRatings || !r.analystAt || (Date.now() - r.analystAt) > ANALYST_TTL_MS;
  }).slice(0, MAX_ANALYST_PER_RUN);

  let ok = 0, failed = 0, rateLimited = false;

  const BATCH = 5, ROUND_DELAY_MS = 1200; // ~5 calls per 1.2s => well under 60/min
  for (let i = 0; i < slice.length; i += BATCH) {
    if (rateLimited) break;
    const batch = slice.slice(i, i + BATCH);
    await Promise.all(batch.map(async (sym) => {
      const prev = existing[sym] || {};
      let quote = null, analyst = prev.analystRatings || null, analystAt = prev.analystAt || null;
      try {
        const q = await getJson(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${apiKey}`);
        if (typeof q.c === 'number' && q.c > 0) quote = { price: q.c, changePct: q.dp, prevClose: q.pc };
      } catch (e) {
        if (String(e.message).includes('429')) rateLimited = true;
        failed++;
        console.error('poll-stocks: quote failed for', sym, '-', e.message);
      }
      if (needAnalyst.includes(sym) && !rateLimited) {
        try {
          const rec = await getJson(`https://finnhub.io/api/v1/stock/recommendation?symbol=${encodeURIComponent(sym)}&token=${apiKey}`);
          if (Array.isArray(rec) && rec.length) {
            const l = rec[0];
            const total = (l.strongBuy || 0) + (l.buy || 0) + (l.hold || 0) + (l.sell || 0) + (l.strongSell || 0);
            if (total) analyst = { strongBuy: l.strongBuy || 0, buy: l.buy || 0, hold: l.hold || 0, sell: l.sell || 0, strongSell: l.strongSell || 0, total, period: l.period };
          }
          analystAt = Date.now(); // record the attempt: ETFs legitimately have no ratings
        } catch (e) {
          if (String(e.message).includes('429')) rateLimited = true;
          console.error('poll-stocks: analyst failed for', sym, '-', e.message);
        }
      }
      // Never overwrite a good record with nulls just because one call failed.
      if (!quote && !analyst && prev.price == null) {
        await setStockRecord(sym, { ticker: sym, price: null, changePct: null, prevClose: null, analystRatings: null, error: 'No live data available for this ticker' });
        return;
      }
      await setStockRecord(sym, {
        ticker: sym,
        price: quote ? quote.price : (prev.price ?? null),
        changePct: quote ? quote.changePct : (prev.changePct ?? null),
        prevClose: quote ? quote.prevClose : (prev.prevClose ?? null),
        analystRatings: analyst,
        analystAt,
      });
      if (quote) ok++;
    }));
    if (i + BATCH < slice.length) await new Promise((r) => setTimeout(r, ROUND_DELAY_MS));
  }

  // Advance even on a partial run so one bad ticker can't stall the rotation.
  await writeCursor((start + slice.length) % TICKERS.length);

  return {
    statusCode: 200,
    body: JSON.stringify({
      polled: slice.length, updated: ok, failed, rateLimited,
      analystRefreshed: needAnalyst.length,
      window: slice[0] + '\u2026' + slice[slice.length - 1],
      nextCursor: (start + slice.length) % TICKERS.length,
      universe: TICKERS.length,
      at: new Date().toISOString(),
    }),
  };
};
