// Netlify Function: per-account personal watchlist store via Netlify Blobs.
// GET  /.netlify/functions/user-watchlist?email=x       -> { tickers: [...] }
// POST /.netlify/functions/user-watchlist { email, tickers } -> saves full list, returns { ok: true, tickers }
const { resolveStore } = require('./lib/blob-store');

function getStoreInstance() {
  return resolveStore('mm-user-watchlists');
}

function keyFor(email) {
  return (email || '').trim().toLowerCase();
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };

  const store = await getStoreInstance();

  if (event.httpMethod === 'GET') {
    const email = keyFor((event.queryStringParameters || {}).email);
    if (!email) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing email' }) };
    const data = (await store.get(email, { type: 'json' })) || { tickers: [] };
    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
  }

  if (event.httpMethod === 'POST') {
    let payload;
    try {
      payload = JSON.parse(event.body || '{}');
    } catch (e) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }
    const email = keyFor(payload.email);
    if (!email) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing email' }) };
    const tickers = Array.isArray(payload.tickers) ? payload.tickers : [];
    await store.set(email, JSON.stringify({ tickers, ts: Date.now() }));
    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, tickers }) };
  }

  return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Use GET or POST' }) };
};
