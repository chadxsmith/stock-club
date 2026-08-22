// Per-ticker records for the polled stock cache, written by poll-stocks.js and
// read by quotes.js and chat.js. Auth resolution lives in lib/blob-store.js —
// see that file for why implicit is preferred over explicit credentials here.
const { resolveStore, probeStore } = require('./blob-store');

const STORE_NAME = 'mm-stock-cache';

async function stockStore() {
  return resolveStore(STORE_NAME);
}

async function getStockRecord(ticker) {
  const store = await stockStore();
  return store.get(ticker.toUpperCase(), { type: 'json' });
}

async function setStockRecord(ticker, record) {
  const store = await stockStore();
  await store.set(ticker.toUpperCase(), JSON.stringify({ ...record, updatedAt: Date.now() }));
}

module.exports = {
  stockStore,
  getStockRecord,
  setStockRecord,
  probeStore: () => probeStore(STORE_NAME),
  STORE_NAME,
};
