// Netlify Function: real analyst recommendation trends via Finnhub (free tier).
// GET /.netlify/functions/analyst?symbols=MU,NVDA,TSM
// Returns { analyst: { SYM: { strongBuy, buy, hold, sell, strongSell, total, period } | { error } } }
// Uses the same FINNHUB_API_KEY env var as quotes.js.

const _cache = new Map(); // symbol -> { at, data }
const CACHE_TTL_MS = 60 * 60 * 1000; // analyst counts move slowly; cache an hour

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };

  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'FINNHUB_API_KEY is not set.' }) };
  }

  const symbolsParam = (event.queryStringParameters || {}).symbols || '';
  const symbols = symbolsParam.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (!symbols.length) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing symbols query param' }) };
  }

  const analyst = {};
  const now = Date.now();
  const toFetch = [];
  symbols.forEach((sym) => {
    const hit = _cache.get(sym);
    if (hit && now - hit.at < CACHE_TTL_MS) analyst[sym] = hit.data;
    else toFetch.push(sym);
  });
  if (!toFetch.length) {
    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ analyst, fetchedAt: new Date().toISOString() }) };
  }
  const fetchOne = async (sym) => {
    const res = await fetch(`https://finnhub.io/api/v1/stock/recommendation?symbol=${encodeURIComponent(sym)}&token=${apiKey}`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) throw new Error('no data');
    const latest = rows[0]; // most recent month first
    const total = (latest.strongBuy || 0) + (latest.buy || 0) + (latest.hold || 0) + (latest.sell || 0) + (latest.strongSell || 0);
    if (!total) throw new Error('no analysts');
    return {
      strongBuy: latest.strongBuy || 0, buy: latest.buy || 0, hold: latest.hold || 0,
      sell: latest.sell || 0, strongSell: latest.strongSell || 0, total, period: latest.period,
    };
  };

  const DEADLINE_MS = Date.now() + 8000;
  const BATCH = 8, ROUND_DELAY_MS = 300;
  const failed = [];
  for (let i = 0; i < toFetch.length && Date.now() < DEADLINE_MS; i += BATCH) {
    const batch = toFetch.slice(i, i + BATCH);
    await Promise.all(batch.map(async (sym) => {
      try { const d = await fetchOne(sym); analyst[sym] = d; _cache.set(sym, { at: Date.now(), data: d }); } catch (e) { failed.push(sym); }
    }));
    if (i + BATCH < toFetch.length) await new Promise((r) => setTimeout(r, ROUND_DELAY_MS));
  }
  if (failed.length && Date.now() < DEADLINE_MS) {
    await new Promise((r) => setTimeout(r, 400));
    await Promise.all(failed.map(async (sym) => {
      try { const d = await fetchOne(sym); analyst[sym] = d; _cache.set(sym, { at: Date.now(), data: d }); } catch (e2) { analyst[sym] = { error: e2.message }; }
    }));
  }

  const body = JSON.stringify({ analyst, fetchedAt: new Date().toISOString() });
  return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body };
};
