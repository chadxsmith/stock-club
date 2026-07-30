// Helper module: turn a raw transcript string into a ranked list of
// { ticker, name, mentions } by matching cashtags ($NVDA) and known
// company-name aliases. Loaded via dynamic import() from the DC logic class.
// Pure JS, no dependencies — safe to extend with more tickers/aliases.

export const DICTIONARY = {
  NVDA:  { name: 'Nvidia',        aliases: ['nvidia'] },
  AMD:   { name: 'Adv. Micro',    aliases: ['amd', 'advanced micro devices'] },
  TSLA:  { name: 'Tesla',         aliases: ['tesla'] },
  AAPL:  { name: 'Apple',         aliases: ['apple'] },
  MSFT:  { name: 'Microsoft',     aliases: ['microsoft'] },
  GOOGL: { name: 'Alphabet',      aliases: ['google', 'alphabet'] },
  AMZN:  { name: 'Amazon',        aliases: ['amazon'] },
  META:  { name: 'Meta',          aliases: ['meta', 'facebook'] },
  NFLX:  { name: 'Netflix',       aliases: ['netflix'] },
  DIS:   { name: 'Disney',        aliases: ['disney'] },
  COIN:  { name: 'Coinbase',      aliases: ['coinbase'] },
  HOOD:  { name: 'Robinhood',     aliases: ['robinhood'] },
  SOFI:  { name: 'SoFi',          aliases: ['sofi'] },
  PLTR:  { name: 'Palantir',      aliases: ['palantir'] },
  MU:    { name: 'Micron',        aliases: ['micron'] },
  SNDK:  { name: 'SanDisk',       aliases: ['sandisk'] },
  AVGO:  { name: 'Broadcom',      aliases: ['broadcom'] },
  INTC:  { name: 'Intel',         aliases: ['intel'] },
  QCOM:  { name: 'Qualcomm',      aliases: ['qualcomm'] },
  ORCL:  { name: 'Oracle',        aliases: ['oracle'] },
  CRM:   { name: 'Salesforce',    aliases: ['salesforce'] },
  UBER:  { name: 'Uber',          aliases: ['uber'] },
  LYFT:  { name: 'Lyft',          aliases: ['lyft'] },
  ABNB:  { name: 'Airbnb',        aliases: ['airbnb'] },
  PYPL:  { name: 'PayPal',        aliases: ['paypal'] },
  SQ:    { name: 'Block',         aliases: ['block inc', 'square'] },
  F:     { name: 'Ford',          aliases: ['ford'] },
  GM:    { name: 'General Motors',aliases: ['general motors'] },
  RIVN:  { name: 'Rivian',        aliases: ['rivian'] },
  LCID:  { name: 'Lucid',         aliases: ['lucid motors', 'lucid'] },
  NIO:   { name: 'Nio',           aliases: ['nio'] },
  BA:    { name: 'Boeing',        aliases: ['boeing'] },
  JPM:   { name: 'JPMorgan',      aliases: ['jpmorgan', 'jp morgan'] },
  BAC:   { name: 'Bank of America', aliases: ['bank of america'] },
  GS:    { name: 'Goldman Sachs', aliases: ['goldman sachs', 'goldman'] },
  V:     { name: 'Visa',          aliases: ['visa'] },
  MA:    { name: 'Mastercard',    aliases: ['mastercard'] },
  WMT:   { name: 'Walmart',       aliases: ['walmart'] },
  TGT:   { name: 'Target',        aliases: ['target'] },
  NKE:   { name: 'Nike',          aliases: ['nike'] },
  SBUX:  { name: 'Starbucks',     aliases: ['starbucks'] },
  MCD:   { name: "McDonald's",    aliases: ["mcdonald's", 'mcdonalds'] },
  CVX:   { name: 'Chevron',       aliases: ['chevron'] },
  XOM:   { name: 'Exxon',         aliases: ['exxon'] },
  T:     { name: 'AT&T',          aliases: ['at&t', 'at and t'] },
  VZ:    { name: 'Verizon',       aliases: ['verizon'] },
  SNAP:  { name: 'Snap',          aliases: ['snapchat', 'snap inc'] },
  RBLX:  { name: 'Roblox',        aliases: ['roblox'] },
  DKNG:  { name: 'DraftKings',    aliases: ['draftkings'] },
  GME:   { name: 'GameStop',      aliases: ['gamestop'] },
  AMC:   { name: 'AMC',           aliases: ['amc entertainment', 'amc'] },
  MSTR:  { name: 'MicroStrategy', aliases: ['microstrategy', 'strategy inc'] },
};

/**
 * Extract ticker mentions from a transcript.
 * @param {string} transcript
 * @returns {Array<{ticker: string, name: string, mentions: number}>} sorted desc by mentions
 */
export function extractMentions(transcript) {
  if (!transcript) return [];
  const text = ' ' + transcript.toLowerCase() + ' ';
  const counts = {};

  // Cashtags, e.g. $NVDA
  const cashtags = transcript.match(/\$[A-Za-z]{1,5}\b/g) || [];
  cashtags.forEach((c) => {
    const t = c.slice(1).toUpperCase();
    if (DICTIONARY[t]) counts[t] = (counts[t] || 0) + 1;
  });

  // Company-name aliases
  Object.entries(DICTIONARY).forEach(([ticker, { aliases }]) => {
    aliases.forEach((alias) => {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('(?<![a-z0-9])' + escaped + '(?![a-z0-9])', 'g');
      const m = text.match(re);
      if (m) counts[ticker] = (counts[ticker] || 0) + m.length;
    });
  });

  return Object.entries(counts)
    .map(([ticker, mentions]) => ({ ticker, name: DICTIONARY[ticker].name, mentions }))
    .sort((a, b) => b.mentions - a.mentions);
}

/** Parse a YouTube URL or bare ID into a video ID. */
export function parseVideoId(input) {
  if (!input) return null;
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1);
    if (u.searchParams.get('v')) return u.searchParams.get('v');
    const m = u.pathname.match(/\/embed\/([\w-]{11})/);
    if (m) return m[1];
  } catch (e) { /* not a URL */ }
  return null;
}
