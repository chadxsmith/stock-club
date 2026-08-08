// Netlify Function: live stock quotes via Finnhub (free tier, no cost).
// GET /.netlify/functions/quotes?symbols=NVDA,MU,TSM
// Requires a FINNHUB_API_KEY environment variable set in the Netlify site
// dashboard (Site settings > Environment variables). Get a free key at
// https://finnhub.io/register — no credit card required.

let _cache = new Map(); // symbol -> { at, data }
const CACHE_TTL_MS = 60 * 1000;

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };

  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500, headers: cors,
      body: JSON.stringify({ error: 'FINNHUB_API_KEY is not set. Add it in Netlify: Site settings > Environment variables, then redeploy.' }),
    };
  }

  const symbolsParam = (event.queryStringParameters || {}).symbols || '';
  const symbols = symbolsParam.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (!symbols.length) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing symbols query param, e.g. ?symbols=NVDA,MU' }) };
  }

  const cacheKey = symbols.slice().sort().join(',');

  try {
    const results = {};
    const now = Date.now();
    const toFetch = [];
    symbols.forEach((sym) => {
      const hit = _cache.get(sym);
      if (hit && now - hit.at < CACHE_TTL_MS) results[sym] = hit.data;
      else toFetch.push(sym);
    });
    // Finnhub free tier is one symbol per call; run them in parallel.
    const fetchOne = async (sym) => {
      const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${apiKey}`);
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error('HTTP ' + res.status + (body ? ': ' + body.slice(0, 200) : ''));
      }
      const data = await res.json();
      if (typeof data.c === 'number' && data.c > 0) {
        return { price: data.c, changePct: data.dp, prevClose: data.pc };
      }
      throw new Error('no data: ' + JSON.stringify(data));
    };

    // Batch concurrency: enough parallelism to finish before the function timeout,
    // gentle enough to avoid Finnhub's burst limit.
    const BATCH = 8, ROUND_DELAY_MS = 400;
    for (let i = 0; i < toFetch.length; i += BATCH) {
      const batch = toFetch.slice(i, i + BATCH);
      await Promise.all(batch.map(async (sym) => {
        try {
          const d = await fetchOne(sym);
          results[sym] = d;
          _cache.set(sym, { at: Date.now(), data: d });
        } catch (e) {
          try {
            await new Promise((r) => setTimeout(r, 500));
            const d = await fetchOne(sym);
            results[sym] = d;
            _cache.set(sym, { at: Date.now(), data: d });
          } catch (e2) {
            console.error('quotes: failed for', sym, '-', e2.message);
            // Serve stale cache rather than nothing if we have it, even past TTL.
            const stale = _cache.get(sym);
            results[sym] = stale ? stale.data : { error: e2.message };
          }
        }
      }));
      if (i + BATCH < toFetch.length) await new Promise((r) => setTimeout(r, ROUND_DELAY_MS));
    }

    const body = JSON.stringify({ quotes: results, fetchedAt: new Date().toISOString() });
    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body,
    };
  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: String(err && err.message || err) }) };
  }
};
