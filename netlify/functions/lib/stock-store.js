// Shared Netlify Blobs store for polled stock data. One record per ticker,
// written by the scheduled poller, read by chat.js and quotes.js (and anything
// else that wants live data without hitting Finnhub directly).
//
// Failures here used to be swallowed by every caller, which meant a broken
// store was indistinguishable from stale prices: the UI reported "17 tickers
// out of date" (pointing at Finnhub rate limits) while the real cause was a
// Blobs 401. Errors are now tagged so callers can say which it is.
const { getStore } = require('@netlify/blobs');

// Implicit getStore() relies on Netlify injecting a Blobs context at runtime.
// Upload-based deploys with no build step often don't get it, yielding a 401 —
// set BLOBS_SITE_ID and BLOBS_TOKEN to use explicit credentials instead.
function blobsMode() {
  return (process.env.BLOBS_SITE_ID && process.env.BLOBS_TOKEN) ? 'explicit' : 'implicit';
}

function stockStore() {
  return blobsMode() === 'explicit'
    ? getStore({ name: 'mm-stock-cache', siteID: process.env.BLOBS_SITE_ID, token: process.env.BLOBS_TOKEN })
    : getStore('mm-stock-cache');
}

// A store that can't authenticate is a configuration problem, not a data
// problem. Tag it so callers report it as such rather than as a cache miss.
function tag(err) {
  const msg = String((err && err.message) || err);
  const e = new Error(msg);
  e.storeUnavailable = /401|403|BlobsInternalError|unauthor/i.test(msg);
  e.blobsMode = blobsMode();
  if (e.storeUnavailable) {
    e.hint = blobsMode() === 'implicit'
      ? 'Blobs rejected the implicit runtime context. Set BLOBS_SITE_ID and BLOBS_TOKEN env vars, then redeploy.'
      : 'Blobs rejected BLOBS_SITE_ID/BLOBS_TOKEN. Check the site ID and that the personal access token is valid.';
  }
  return e;
}

async function getStockRecord(ticker) {
  try {
    return await stockStore().get(ticker.toUpperCase(), { type: 'json' });
  } catch (err) { throw tag(err); }
}

async function setStockRecord(ticker, record) {
  try {
    await stockStore().set(ticker.toUpperCase(), JSON.stringify({ ...record, updatedAt: Date.now() }));
  } catch (err) { throw tag(err); }
}

// Cheap round-trip to tell a working store from a misconfigured one, so callers
// can fail fast with a real reason instead of N identical per-ticker errors.
async function probeStore() {
  try {
    await stockStore().get('__probe', { type: 'json' });
    return { ok: true, mode: blobsMode() };
  } catch (err) {
    const e = tag(err);
    return { ok: false, mode: e.blobsMode, error: e.message, hint: e.hint };
  }
}

module.exports = { stockStore, getStockRecord, setStockRecord, probeStore, blobsMode };
