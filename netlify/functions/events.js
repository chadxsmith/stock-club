// Netlify Function: shared usage-event store via Netlify Blobs.
// POST /.netlify/functions/events   { type, meta, ts }   -> append one event
// GET  /.netlify/functions/events                        -> { events: [...] }
// DELETE /.netlify/functions/events                       -> clear store
const { resolveStore } = require('./lib/blob-store');

const MAX_EVENTS = 5000;

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };

  const store = await resolveStore('mm-usage-events');
  const KEY = 'events.json';

  if (event.httpMethod === 'GET') {
    const events = (await store.get(KEY, { type: 'json' })) || [];
    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ events }) };
  }

  if (event.httpMethod === 'DELETE') {
    await store.set(KEY, JSON.stringify([]));
    return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };
  }

  if (event.httpMethod === 'POST') {
    let payload;
    try {
      payload = JSON.parse(event.body || '{}');
    } catch (e) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }
    if (!payload.type) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing type' }) };
    }
    const events = (await store.get(KEY, { type: 'json' })) || [];
    events.push({ type: payload.type, meta: payload.meta || {}, ts: payload.ts || Date.now() });
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
    await store.set(KEY, JSON.stringify(events));
    return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Use GET, POST, or DELETE' }) };
};
