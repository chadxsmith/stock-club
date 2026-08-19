// Netlify Function: chat with Claude via the Anthropic API, grounded with
// server-side tool use. Claude cannot answer with a stock metric it invented —
// it must call get_stock_from_db, which this function intercepts and answers
// from live Finnhub data (or "unavailable" if there's none).
// POST /.netlify/functions/chat  { system, messages: [{role, content}, ...] }
// Requires ANTHROPIC_API_KEY and FINNHUB_API_KEY env vars (Netlify site
// dashboard > Site settings > Environment variables).

const _quoteCache = new Map(); // symbol -> { at, data }
const _analystCache = new Map();
const _newsCache = new Map();
const QUOTE_TTL_MS = 60 * 1000;
const ANALYST_TTL_MS = 60 * 60 * 1000;
const NEWS_TTL_MS = 10 * 60 * 1000;

async function withRetry(fn) {
  const delays = [500, 1200];
  for (let i = 0; i < delays.length; i++) {
    try { return await fn(); }
    catch (e) {
      if (!/HTTP 429/.test(String(e && e.message))) throw e;
      await new Promise((r) => setTimeout(r, delays[i]));
    }
  }
  return fn();
}

async function fetchQuote(sym, apiKey) {
  const hit = _quoteCache.get(sym);
  if (hit && Date.now() - hit.at < QUOTE_TTL_MS) return hit.data;
  return withRetry(async () => {
    const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${apiKey}`);
    if (!res.ok) throw new Error('quote HTTP ' + res.status);
    const data = await res.json();
    if (typeof data.c !== 'number' || data.c <= 0) throw new Error('no quote data');
    const out = { price: data.c, changePct: data.dp, prevClose: data.pc };
    _quoteCache.set(sym, { at: Date.now(), data: out });
    return out;
  });
}

const fetchAnalyst = async (sym, apiKey) => {
  const hit = _analystCache.get(sym);
  if (hit && Date.now() - hit.at < ANALYST_TTL_MS) return hit.data;
  return withRetry(async () => {
    const res = await fetch(`https://finnhub.io/api/v1/stock/recommendation?symbol=${encodeURIComponent(sym)}&token=${apiKey}`);
    if (!res.ok) throw new Error('analyst HTTP ' + res.status);
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) throw new Error('no analyst data');
    const latest = rows[0];
    const total = (latest.strongBuy || 0) + (latest.buy || 0) + (latest.hold || 0) + (latest.sell || 0) + (latest.strongSell || 0);
    if (!total) throw new Error('no analysts');
    const out = {
      strongBuy: latest.strongBuy || 0, buy: latest.buy || 0, hold: latest.hold || 0,
      sell: latest.sell || 0, strongSell: latest.strongSell || 0, total, period: latest.period,
    };
    _analystCache.set(sym, { at: Date.now(), data: out });
    return out;
  });
};

// Why a stock is moving lives in headlines, not in price data. Finnhub's
// company-news endpoint is on the same key we already hold, so this costs no new
// integration — without it "why is DELL down" is structurally unanswerable and
// the model correctly refuses.
async function fetchNews(rawTicker, apiKey, days) {
  const ticker = String(rawTicker || '').trim().toUpperCase();
  if (!ticker) return { ticker, error: 'No ticker provided' };
  const span = Math.min(Math.max(Number(days) || 7, 1), 30);
  const cacheKey = ticker + ':' + span;
  const hit = _newsCache.get(cacheKey);
  if (hit && Date.now() - hit.at < NEWS_TTL_MS) return hit.data;

  const iso = (d) => d.toISOString().slice(0, 10);
  const to = new Date();
  const from = new Date(to.getTime() - span * 86400000);
  const url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(ticker)}&from=${iso(from)}&to=${iso(to)}&token=${apiKey}`;

  const out = await withRetry(async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error('news HTTP ' + res.status);
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) {
      return { ticker, windowDays: span, articles: [], note: 'No company news published in this window.' };
    }
    const articles = rows
      .sort((a, b) => (b.datetime || 0) - (a.datetime || 0))
      .slice(0, 8)
      .map((r) => ({
        headline: r.headline,
        summary: String(r.summary || '').slice(0, 400),
        source: r.source,
        url: r.url,
        published: r.datetime ? new Date(r.datetime * 1000).toISOString() : null,
      }));
    return { ticker, windowDays: span, articles };
  });
  _newsCache.set(cacheKey, { at: Date.now(), data: out });
  return out;
}

// The one source of truth Claude is allowed to cite numbers from. Checks the
// shared poller-fed store first (covers the ~60 tracked tickers with no
// per-request Finnhub cost); only falls back to a live call for tickers
// outside that universe or if the store has nothing yet.
async function getStockFromDb(rawTicker, finnhubKey) {
  const ticker = String(rawTicker || '').trim().toUpperCase();
  if (!ticker) return { ticker, error: 'No ticker provided' };

  try {
    const { getStockRecord } = require('./lib/stock-store');
    const stored = await getStockRecord(ticker);
    if (stored) return stored;
  } catch (e) {
    // Blobs unavailable/misconfigured — fall through to a live lookup.
  }

  const [quoteRes, analystRes] = await Promise.allSettled([
    fetchQuote(ticker, finnhubKey),
    fetchAnalyst(ticker, finnhubKey),
  ]);
  const quote = quoteRes.status === 'fulfilled' ? quoteRes.value : null;
  const analyst = analystRes.status === 'fulfilled' ? analystRes.value : null;
  if (quoteRes.status === 'rejected') console.error('quote lookup failed for', ticker, '-', quoteRes.reason && quoteRes.reason.message || quoteRes.reason);
  if (analystRes.status === 'rejected') console.error('analyst lookup failed for', ticker, '-', analystRes.reason && analystRes.reason.message || analystRes.reason);
  if (!quote && !analyst) return { ticker, error: 'No live data available for this ticker' };
  return {
    ticker,
    price: quote ? quote.price : null,
    changePct: quote ? quote.changePct : null,
    prevClose: quote ? quote.prevClose : null,
    analystRatings: analyst || null,
    ...(analyst ? {} : { analystNote: 'Analyst ratings unavailable for this ticker' }),
    ...(quote ? {} : { priceNote: 'Live price unavailable for this ticker' }),
  };
}

const STOCK_TOOL = {
  name: 'get_stock_from_db',
  description: "Look up the current price, day change, and analyst buy/hold/sell recommendation counts for a single stock ticker from our live database (backed by Finnhub). Always call this before stating any price, percent change, or analyst rating for a specific ticker \u2014 never state those numbers from memory.",
  input_schema: {
    type: 'object',
    properties: {
      ticker: { type: 'string', description: 'Stock ticker symbol, e.g. NVDA, MU, DELL' },
    },
    required: ['ticker'],
  },
};

const NEWS_TOOL = {
  name: 'get_company_news',
  description: "Fetch recent published news headlines and summaries for a single stock ticker. Call this whenever the user asks WHY a stock moved, what happened to it, what the news is, or anything about earnings, announcements, downgrades, or catalysts. Returns real published articles with dates and sources.",
  input_schema: {
    type: 'object',
    properties: {
      ticker: { type: 'string', description: 'Stock ticker symbol, e.g. NVDA, MU, DELL' },
      days: { type: 'number', description: 'How many days back to search, 1-30. Use 2 for "today/why is it moving", 7 for general context.' },
    },
    required: ['ticker'],
  },
};

const EPISODE_TRANSCRIPT = require('./lib/episode-transcript');
const TRANSCRIPT_RULE = "Below is the transcript of the most recent Market Mondays episode. Lead with the real data \u2014 price, change, and analyst ratings from get_stock_from_db \u2014 and use the hosts' reasoning only as brief color layered on top of it, at most a sentence, when it genuinely sharpens the picture (why they like the sector, a level they named, a risk they flagged). Do not open with what the hosts said, do not build an answer around their opinions, and do not name-drop or quote at length; a light 'the show framed this as...' is the right weight. Do not repeat it every message. If the user asks directly what was said on the episode, then answer that fully from this transcript. Never attribute an opinion to Rashad, Troy, or Ian that is not in this transcript, and never treat any number inside it as current market data. If something wasn't discussed, say so.\n\n";

const GROUNDING_RULE = "You must never invent, guess, estimate, or recall from memory any stock price, percent change, or analyst buy/hold/sell rating or count. For every specific ticker you discuss, call get_stock_from_db to get that ticker's real data before stating any metric about it, and only state numbers that tool returns. If the tool returns an error or missing data for a ticker, tell the user live data is unavailable for that ticker \u2014 do not substitute a guess, a typical range, or a remembered figure. Non-numeric context (which show mentioned a ticker, why, general commentary) may come from the conversation context, but every metric must come from the tool.";

const NEWS_RULE = "When the user asks why a stock is moving, what happened to it, or about earnings, downgrades, or catalysts, call get_company_news for that ticker \u2014 do NOT reply that you lack access to news and do NOT tell the user to go check an investor relations page or search elsewhere. Pair it with get_stock_from_db so you state the real move alongside the reason. Attribute each reason to its headline and date in plain language ('Reuters reported Tuesday that...'). If the headlines do not actually explain the move, say the move has no clear news catalyst in the last few days rather than inventing one, and note that daily moves are often just sector or index drift.";

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
  const finnhubKey = process.env.FINNHUB_API_KEY;

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

  const fullSystem = (system ? system + '\n\n' : '') + GROUNDING_RULE + '\n\n' + NEWS_RULE + '\n\n' + TRANSCRIPT_RULE + EPISODE_TRANSCRIPT;
  // Anthropic messages use content as either a string or an array of blocks;
  // normalize incoming history to blocks so we can append tool_use/tool_result turns.
  let convo = messages.map((m) => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : m.content,
  }));

  const callClaude = async (forceTool) => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 700,
        system: fullSystem,
        messages: convo,
        tools: [STOCK_TOOL, NEWS_TOOL],
        // Force the first turn to ground itself via the tool rather than trusting
        // the model to opt in on its own — this is what actually stops invented
        // numbers; the instruction alone is not enough.
        ...(forceTool ? { tool_choice: { type: 'any' } } : {}),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error((data && data.error && data.error.message) || 'Anthropic API request failed');
    return data;
  };

  try {
    let data = await callClaude(true);
    let hops = 0;
    const MAX_TOOL_HOPS = 6;

    while (data.stop_reason === 'tool_use' && hops < MAX_TOOL_HOPS) {
      hops += 1;
      const toolUses = (data.content || []).filter((b) => b.type === 'tool_use');
      convo = convo.concat([{ role: 'assistant', content: data.content }]);

      const toolResults = [];
      for (const tu of toolUses) {
        let resultPayload;
        try {
          if (!finnhubKey) throw new Error('Live stock database is not configured (FINNHUB_API_KEY missing)');
          const record = tu.name === 'get_company_news'
            ? await fetchNews(tu.input && tu.input.ticker, finnhubKey, tu.input && tu.input.days)
            : await getStockFromDb(tu.input && tu.input.ticker, finnhubKey);
          resultPayload = JSON.stringify(record);
        } catch (toolErr) {
          console.error(tu.name + ' failed for', tu.input && tu.input.ticker, '-', toolErr && toolErr.message || toolErr);
          resultPayload = JSON.stringify({ ticker: (tu.input && tu.input.ticker) || null, error: String(toolErr && toolErr.message || toolErr) });
        }
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: resultPayload });
      }
      convo = convo.concat([{ role: 'user', content: toolResults }]);
      data = await callClaude();
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
