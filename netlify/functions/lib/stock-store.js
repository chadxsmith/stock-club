// Shared Netlify Blobs store for polled stock data. One record per ticker,
// written by the scheduled poller, read by chat.js and quotes.js (and anything
// else that wants live data without hitting Finnhub directly).
//
// Auth is resolved at runtime rather than assumed. Explicit credentials
// (BLOBS_SITE_ID + BLOBS_TOKEN) were returning a hard 401 here while the
// implicit runtime context worked for other stores on the same project, so we
// probe each candidate once and keep whichever authenticates. Picking one mode
// blindly is what kept this store empty — and because every caller swallowed
// the error, the UI reported it as "17 tickers out of date" (i.e. Finnhub rate
// limits) rather than a broken cache.
const { getStore } = require('@netlify/blobs');

const STORE_NAME = 'mm-stock-cache';

let _resolved = null;   // { store, mode } once a mode authenticates
let _lastError = null;

function build(mode) {
  return mode === 'explicit'
    ? getStore({ name: STORE_NAME, siteID: process.env.BLOBS_SITE_ID, token: process.env.BLOBS_TOKEN })
    : getStore(STORE_NAME);
}

function candidates() {
  const list = [];
  if (process.env.BLOBS_SITE_ID && process.env.BLOBS_TOKEN) list.push('explicit');
  list.push('implicit');
  return list;
}

// A store that can't authenticate is a configuration problem, not a data
// problem. Tag it so callers report it as such rather than as a cache miss.
function tag(err, tried) {
  const msg = String((err && err.message) || err);
  const e = new Error(msg);
  e.storeUnavailable = /401|403|BlobsInternalError|unauthor/i.test(msg);
  e.tried = tried || [];
  e.hint = 'Blobs rejected every auth mode tried (' + e.tried.join(', ') + '). '
    + 'Check that BLOBS_SITE_ID matches the project ID and BLOBS_TOKEN is a live '
    + 'personal access token — or clear both to force the implicit runtime context.';
  return e;
}

// Probe each mode once, cache the winner. A read is enough to prove auth.
async function resolveStore() {
  if (_resolved) return _resolved;
  const tried = [];
  let lastErr = null;
  for (const mode of candidates()) {
    try {
      const store = build(mode);
      await store.get('__probe', { type: 'json' });
      _resolved = { store, mode };
      _lastError = null;
      return _resolved;
    } catch (err) {
      tried.push(mode);
      lastErr = err;
      console.error('stock-store: ' + mode + ' auth failed -', String(err && err.message || err));
    }
  }
  _lastError = tag(lastErr, tried);
  throw _lastError;
}

async function getStockRecord(ticker) {
  const { store } = await resolveStore();
  try {
    return await store.get(ticker.toUpperCase(), { type: 'json' });
  } catch (err) { throw tag(err, [_resolved && _resolved.mode]); }
}

async function setStockRecord(ticker, record) {
  const { store } = await resolveStore();
  try {
    await store.set(ticker.toUpperCase(), JSON.stringify({ ...record, updatedAt: Date.now() }));
  } catch (err) { throw tag(err, [_resolved && _resolved.mode]); }
}

// Tell a working store from a misconfigured one, naming the mode that won so a
// silent fallback is still visible in the logs.
async function probeStore() {
  try {
    const { mode } = await resolveStore();
    return { ok: true, mode };
  } catch (err) {
    return { ok: false, mode: 'none', tried: err.tried, error: err.message, hint: err.hint };
  }
}

async function stockStore() {
  const { store } = await resolveStore();
  return store;
}

module.exports = { stockStore, getStockRecord, setStockRecord, probeStore, STORE_NAME };
