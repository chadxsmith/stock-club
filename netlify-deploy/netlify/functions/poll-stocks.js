// Scheduled Netlify Function: polls Finnhub for the full tracked-ticker
// universe on a fixed cadence and writes each result into a shared Blobs
// store, so per-request traffic (chat, quotes.js, analyst.js) reads a cache
// instead of calling Finnhub directly. Requires FINNHUB_API_KEY.
// Configured to run every 2 minutes — see netlify.toml.
const { setStockRecord } = require('./lib/stock-store');
const TICKERS = require('./lib/tracked-tickers');

async function fetchOne(sym, apiKey) {
  const [quoteRes, recRes] = await Promise.allSettled([
    fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${apiKey}`).then((r) => r.ok ? r.json() : Promise.reject(new Error('quote HTTP ' + r.status))),
    fetch(`https://finnhub.io/api/v1/stock/recommendation?symbol=${encodeURIComponent(sym)}&token=${apiKey}`).then((r) => r.ok ? r.json() : Promise.reject(new Error('analyst HTTP ' + r.status))),
  ]);

  let quote = null;
  if (quoteRes.status === 'fulfilled' && typeof quoteRes.value.c === 'number' && quoteRes.value.c > 0) {
    quote = { price: quoteRes.value.c, changePct: quoteRes.value.dp, prevClose: quoteRes.value.pc };
  }
  let analyst = null;
  if (recRes.status === 'fulfilled' && Array.isArray(recRes.value) && recRes.value.length) {
    const latest = recRes.value[0];
    const total = (latest.strongBuy || 0) + (latest.buy || 0) + (latest.hold || 0) + (latest.sell || 0) + (latest.strongSell || 0);
    if (total) analyst = { strongBuy: latest.strongBuy || 0, buy: latest.buy || 0, hold: latest.hold || 0, sell: latest.sell || 0, strongSell: latest.strongSell || 0, total, period: latest.period };
  }

  await setStockRecord(sym, {
    ticker: sym,
    price: quote ? quote.price : null,
    changePct: quote ? quote.changePct : null,
    prevClose: quote ? quote.prevClose : null,
    analystRatings: analyst,
    error: (!quote && !analyst) ? 'No live data available for this ticker' : undefined,
  });
}

exports.handler = async () => {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) return { statusCode: 500, body: 'FINNHUB_API_KEY not set' };

  const BATCH = 10, ROUND_DELAY_MS = 300;
  for (let i = 0; i < TICKERS.length; i += BATCH) {
    const batch = TICKERS.slice(i, i + BATCH);
    await Promise.all(batch.map((sym) => fetchOne(sym, apiKey).catch((e) => console.error('poll-stocks: failed for', sym, '-', e.message))));
    if (i + BATCH < TICKERS.length) await new Promise((r) => setTimeout(r, ROUND_DELAY_MS));
  }
  return { statusCode: 200, body: JSON.stringify({ polled: TICKERS.length, at: new Date().toISOString() }) };
};
