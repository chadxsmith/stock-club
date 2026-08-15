// Shared Netlify Blobs store for polled stock data. One record per ticker,
// written by the scheduled poller, read by chat.js (and anything else that
// wants live data without hitting Finnhub directly).
const { getStore } = require('@netlify/blobs');

function stockStore() {
  return process.env.BLOBS_SITE_ID && process.env.BLOBS_TOKEN
    ? getStore({ name: 'mm-stock-cache', siteID: process.env.BLOBS_SITE_ID, token: process.env.BLOBS_TOKEN })
    : getStore('mm-stock-cache');
}

async function getStockRecord(ticker) {
  const store = stockStore();
  return store.get(ticker.toUpperCase(), { type: 'json' });
}

async function setStockRecord(ticker, record) {
  const store = stockStore();
  await store.set(ticker.toUpperCase(), JSON.stringify({ ...record, updatedAt: Date.now() }));
}

module.exports = { stockStore, getStockRecord, setStockRecord };
