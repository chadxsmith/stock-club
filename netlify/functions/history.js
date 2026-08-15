// Netlify Function: real historical % change via Yahoo Finance daily closes (free, no API key).
// GET /.netlify/functions/history?symbols=QQQ,MU,NVDA
// Returns { history: { SYM: { '5D':pct, '1M':pct, '3M':pct, '6M':pct, 'YTD':pct } | { error } } }
// Note: Stooq's data is free but its endpoint blocks requests from cloud/datacenter
// IPs (which is what Netlify functions run from), so every request failed there
// silently and the app fell back to the seed table. Yahoo's chart endpoint works
// fine from serverless.

// Module-level cache: survives across invocations on a warm lambda instance,
// so repeated page loads / tab refocuses don't re-hammer Yahoo.
let _cache = { key: '', at: 0, body: null };
const CACHE_TTL_MS = 5 * 60 * 1000;

function fmtDate(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function closestOnOrBefore(rows, targetDate) {
  let best = null;
  for (const r of rows) {
    if (r.date <= targetDate) best = r;
    else break;
  }
  return best;
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };

  const symbolsParam = (event.queryStringParameters || {}).symbols || '';
  const symbols = symbolsParam.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (!symbols.length) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing symbols query param' }) };
  }

  const cacheKey = symbols.slice().sort().join(',');
  if (_cache.body && _cache.key === cacheKey && Date.now() - _cache.at < CACHE_TTL_MS) {
    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: _cache.body };
  }

  const now = new Date();
  const jan1 = fmtDate(new Date(now.getFullYear(), 0, 1));

  const mark = (days) => { const d = new Date(now); d.setDate(d.getDate() - days); return fmtDate(d); };
  const markMonths = (n) => { const d = new Date(now); d.setMonth(d.getMonth() - n); return fmtDate(d); };

  const history = {};
  const fetchOne = async (sym) => {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1y&interval=1d`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MarketMondays/1.0)' } }
    );
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    const result = json && json.chart && json.chart.result && json.chart.result[0];
    const timestamps = result && result.timestamp;
    const closes = result && result.indicators && result.indicators.quote && result.indicators.quote[0] && result.indicators.quote[0].close;
    if (!timestamps || !closes) throw new Error('no data');
    const rows = timestamps
      .map((ts, i) => ({ date: fmtDate(new Date(ts * 1000)), close: closes[i] }))
      .filter((r) => typeof r.close === 'number' && !isNaN(r.close));
    if (rows.length < 2) throw new Error('no data');
    const last = rows[rows.length - 1];
    const pctFrom = (targetDateStr) => {
      const row = closestOnOrBefore(rows, targetDateStr);
      if (!row || !row.close) return null;
      return ((last.close - row.close) / row.close) * 100;
    };
    return {
      '5D': pctFrom(mark(5)),
      '1M': pctFrom(markMonths(1)),
      '3M': pctFrom(markMonths(3)),
      '6M': pctFrom(markMonths(6)),
      'YTD': pctFrom(jan1),
      '1Y': pctFrom(mark(365)),
      // Full daily close series (trading days only) so the client can draw the
      // real chart shape instead of a fabricated wiggle between two points.
      series: rows,
    };
  };

  // Previous version (BATCH=3, 900ms rounds + per-symbol retries) took ~9-10s
  // for 29 symbols and was blowing past Netlify's 10s synchronous timeout —
  // the whole function died, the frontend's catch swallowed it, and every
  // ticker silently fell back to the hardcoded seed table (which is why QQQ
  // was showing the seed's 31% instead of the real ~9%). Budget against a
  // hard deadline instead of a fixed slow throttle, and do one bulk retry
  // pass for whatever failed (mainly 429s) rather than retrying inline.
  const DEADLINE_MS = Date.now() + 8000;
  const BATCH = 10, ROUND_DELAY_MS = 150;
  const failed = [];
  for (let i = 0; i < symbols.length && Date.now() < DEADLINE_MS; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH);
    await Promise.all(batch.map(async (sym) => {
      try {
        history[sym] = await fetchOne(sym);
      } catch (e) {
        failed.push(sym);
      }
    }));
    if (i + BATCH < symbols.length) await new Promise((r) => setTimeout(r, ROUND_DELAY_MS));
  }
  if (failed.length && Date.now() < DEADLINE_MS) {
    await new Promise((r) => setTimeout(r, 400));
    await Promise.all(failed.map(async (sym) => {
      try {
        history[sym] = await fetchOne(sym);
      } catch (e2) {
        console.error('history: failed for', sym, '-', e2.message);
        history[sym] = { error: e2.message };
      }
    }));
  }

  const body = JSON.stringify({ history, fetchedAt: new Date().toISOString() });
  _cache = { key: cacheKey, at: Date.now(), body };

  return {
    statusCode: 200,
    headers: { ...cors, 'Content-Type': 'application/json' },
    body,
  };
};
