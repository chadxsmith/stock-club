// Netlify Function: live stock quotes via Finnhub (free tier, no cost).
// GET /.netlify/functions/quotes?symbols=NVDA,MU,TSM
// Requires a FINNHUB_API_KEY environment variable set in the Netlify site
// dashboard (Site settings > Environment variables). Get a free key at
// https://finnhub.io/register — no credit card required.

let _cache = new Map(); // symbol -> { at, data }
let _rateLimitedUntil = 0; // set on a 429 — stop calling Finnhub until it passes
const RATE_LIMIT_COOLDOWN_MS = 60 * 1000;
const CACHE_TTL_MS = 60 * 1000;
// Poller rotates the full 88-ticker universe in ~7.3 min; accept a store record
// up to 15 min old before going live, so a record never expires mid-rotation.
const STORE_TTL_MS = 15 * 60 * 1000;

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

  try {
    const results = {};
    const now = Date.now();
    const toFetch = [];

    // 1) Shared store first. The scheduled poller refreshes every ~2 min, so for
    // tracked tickers this answers without spending any Finnhub budget — which is
    // what kept the tail of a 60+ symbol request falling back to seed prices.
    let stored = {};
    // Probe once. A misconfigured store throws identically for all 55 symbols, and
    // swallowing that made a Blobs 401 look like Finnhub staleness in the UI.
    let store = { ok: false, mode: 'unknown', error: 'store not attempted' };
    try {
      const { getStockRecord, probeStore } = require('./lib/stock-store');
      store = await probeStore();
      if (store.ok) {
        const recs = await Promise.all(symbols.map(async (sym) => {
          try { return [sym, await getStockRecord(sym)]; } catch (e) { return [sym, null]; }
        }));
        recs.forEach(([sym, rec]) => {
          if (rec && typeof rec.price === 'number' && rec.price > 0 && now - (rec.updatedAt || 0) < STORE_TTL_MS) {
            stored[sym] = { price: rec.price, changePct: rec.changePct, prevClose: rec.prevClose, source: 'store' };
          }
        });
      } else {
        console.error('quotes: store unavailable, tried [' + (store.tried || []).join(', ') + '] -', store.error, '|', store.hint || '');
      }
    } catch (e) {
      store = { ok: false, mode: 'unknown', error: String(e && e.message || e) };
      console.error('quotes: store module failed -', store.error);
    }

    symbols.forEach((sym) => {
      if (stored[sym]) { results[sym] = stored[sym]; return; }
      const hit = _cache.get(sym);
      if (hit && now - hit.at < CACHE_TTL_MS) results[sym] = hit.data;
      else toFetch.push(sym);
    });
    // Finnhub free tier is one symbol per call; run them in parallel.
    const fetchOne = async (sym) => {
      if (Date.now() < _rateLimitedUntil) throw new Error('rate limited, serving cache');
      const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${apiKey}`);
      if (!res.ok) {
        // A 429 means the shared key is out of budget this minute. Retrying
        // immediately makes it worse, so back everything off instead.
        if (res.status === 429) _rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
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
            if (Date.now() < _rateLimitedUntil) throw e; // don't retry into a 429
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

    // `store` tells the client whether the warm cache is working. Without it a
    // 401 is indistinguishable from rate-limited staleness.
    const fromStore = Object.values(results).filter((r) => r && r.source === 'store').length;
    const body = JSON.stringify({
      quotes: results,
      fetchedAt: new Date().toISOString(),
      store: { ...store, served: fromStore, requested: symbols.length, liveFetched: toFetch.length },
    });
    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body,
    };
  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: String(err && err.message || err) }) };
  }
};
