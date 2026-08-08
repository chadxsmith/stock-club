// Netlify Function: shared watchlist store via Netlify Blobs.
// GET  /.netlify/functions/shared-lists
//   -> { lists: [{id,name,avatarColors,memberCount}], membership: { listId: { TICKER: addedByName } } }
// POST /.netlify/functions/shared-lists  { action, ... }
//   action "addStock"    { listId, ticker, addedBy }        -> add/toggle a ticker on a list
//   action "removeStock" { listId, ticker }                  -> remove a ticker
//   action "createList"  { name, avatarColors, email, name2 } -> create a new shared list, returns { id }
//   action "join"        { listId, email, name }             -> register a real member on a list
const { getStore } = require('@netlify/blobs');

const KEY = 'shared-lists.json';
const DEFAULT_DATA = {
  lists: [
    { id: 'instagram', name: 'Instagram Friends', avatarColors: ['#E7B53C', '#3B82F6', '#22C55E', '#EC4899'] },
  ],
  membership: { instagram: {} },
  members: { instagram: {} },
};

// Sends a "stock added" notification email to every member of a list except
// the person who added it. Best-effort: failures are logged, never thrown,
// so a Postmark hiccup can't break the addStock action itself.
async function sendStockAddedEmails(listName, listId, ticker, addedBy, members) {
  const token = process.env.POSTMARK_API_TOKEN;
  if (!token) return; // not configured yet; skip silently
  const from = process.env.POSTMARK_FROM || 'notifications@stock-club.com';
  const recipients = Object.entries(members || {}).filter(([, info]) => (info.name || '') !== addedBy);
  await Promise.all(recipients.map(async ([email, info]) => {
    const html = `<!DOCTYPE html><html lang="en"><body style="margin:0;padding:0;background-color:#f4f2ee;">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;font-family:Georgia,serif;">${addedBy} just added ${ticker} to ${listName}.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f2ee;"><tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#ffffff;">
<tr><td style="padding:32px 32px 4px;font-family:Georgia,'Times New Roman',serif;font-size:14px;color:#111111;">Market Mondays</td></tr>
<tr><td style="padding:18px 32px 0;font-family:Georgia,'Times New Roman',serif;font-size:15px;line-height:24px;color:#222222;">Hi ${info.name || 'there'},</td></tr>
<tr><td style="padding:10px 32px 0;font-family:Georgia,'Times New Roman',serif;font-size:15px;line-height:24px;color:#222222;">${addedBy} just added <strong>${ticker}</strong> to the <strong>${listName}</strong> watchlist you're part of.</td></tr>
<tr><td style="padding:20px 32px 0;font-family:Georgia,'Times New Roman',serif;font-size:15px;line-height:24px;"><a href="https://sprightly-cascaron-3e3a29.netlify.app/?list=${encodeURIComponent(listId)}" style="color:#8a6d1f;">View the watchlist &rarr;</a></td></tr>
<tr><td style="padding:32px 32px 6px;font-family:Georgia,'Times New Roman',serif;font-size:13px;color:#777777;">&mdash; Market Mondays</td></tr>
<tr><td style="padding:20px 32px 28px;border-top:1px solid #eeeeee;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#999999;">You're receiving this because you're a member of ${listName} on Market Mondays.</td></tr>
</table></td></tr></table></body></html>`;
    try {
      const res = await fetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'X-Postmark-Server-Token': token },
        body: JSON.stringify({ From: from, To: email, Subject: `${ticker} was added to ${listName}`, HtmlBody: html, MessageStream: 'outbound' }),
      });
      if (!res.ok) console.error('postmark send failed', email, await res.text().catch(() => ''));
    } catch (e) {
      console.error('postmark send error', email, e.message);
    }
  }));
}

function getStoreInstance() {
  return process.env.BLOBS_SITE_ID && process.env.BLOBS_TOKEN
    ? getStore({ name: 'mm-shared-lists', siteID: process.env.BLOBS_SITE_ID, token: process.env.BLOBS_TOKEN })
    : getStore('mm-shared-lists');
}

function withMemberCounts(data) {
  return {
    ...data,
    lists: data.lists.map((l) => ({
      ...l,
      memberCount: Math.max(1, Object.keys((data.members || {})[l.id] || {}).length),
    })),
  };
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };

  const store = getStoreInstance();

  if (event.httpMethod === 'GET') {
    const data = (await store.get(KEY, { type: 'json' })) || DEFAULT_DATA;
    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(withMemberCounts(data)) };
  }

  if (event.httpMethod === 'POST') {
    let payload;
    try {
      payload = JSON.parse(event.body || '{}');
    } catch (e) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }
    const data = (await store.get(KEY, { type: 'json' })) || JSON.parse(JSON.stringify(DEFAULT_DATA));
    if (!data.members) data.members = {};

    if (payload.action === 'createList') {
      if (!payload.name) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing name' }) };
      const id = 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      data.lists.push({ id, name: payload.name, avatarColors: payload.avatarColors || ['#E7B53C'] });
      data.membership[id] = {};
      data.members[id] = {};
      if (payload.email) data.members[id][payload.email] = { name: payload.creatorName || payload.email, ts: Date.now() };
      await store.set(KEY, JSON.stringify(data));
      const out = withMemberCounts(data);
      return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, id, data: out }) };
    }

    if (payload.action === 'join') {
      const { listId, email, name } = payload;
      if (!listId || !email) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing listId or email' }) };
      if (!data.members[listId]) data.members[listId] = {};
      if (!data.members[listId][email]) {
        data.members[listId][email] = { name: name || email, ts: Date.now() };
        await store.set(KEY, JSON.stringify(data));
      }
      const out = withMemberCounts(data);
      return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, data: out }) };
    }

    if (payload.action === 'addStock' || payload.action === 'removeStock') {
      const { listId, ticker } = payload;
      if (!listId || !ticker) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing listId or ticker' }) };
      if (!data.membership[listId]) data.membership[listId] = {};
      if (payload.action === 'addStock') data.membership[listId][ticker] = payload.addedBy || 'someone';
      else delete data.membership[listId][ticker];
      await store.set(KEY, JSON.stringify(data));
      if (payload.action === 'addStock') {
        const list = data.lists.find((l) => l.id === listId);
        await sendStockAddedEmails(list ? list.name : listId, listId, ticker, payload.addedBy || 'someone', data.members[listId]);
      }
      const out = withMemberCounts(data);
      return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, data: out }) };
    }

    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Unknown action' }) };
  }

  return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Use GET or POST' }) };
};
