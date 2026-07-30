// Netlify Function: chat with Claude via the Anthropic API.
// POST /.netlify/functions/chat  { system, messages: [{role, content}, ...] }
// Requires an ANTHROPIC_API_KEY environment variable set in the Netlify site
// dashboard (Site settings > Environment variables). Get a key at
// https://console.anthropic.com/settings/keys

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Use POST' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500, headers: cors,
      body: JSON.stringify({ error: 'ANTHROPIC_API_KEY is not set. Add it in Netlify: Site settings > Environment variables, then redeploy.' }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { system, messages } = payload;
  if (!Array.isArray(messages) || !messages.length) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing messages array' }) };
  }

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 500,
        system: system || undefined,
        messages,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      return { statusCode: res.status, headers: cors, body: JSON.stringify({ error: (data && data.error && data.error.message) || 'Anthropic API request failed' }) };
    }

    const text = (data.content || []).map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    };
  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: String(err && err.message || err) }) };
  }
};
