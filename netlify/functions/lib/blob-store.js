// Shared Blobs auth resolver for every store in this project.
//
// Why this exists: Netlify rejects this project's explicit credentials
// (BLOBS_SITE_ID + BLOBS_TOKEN) with a hard 401, even though the site ID
// matches the project ID and the token is a live personal access token. The
// implicit runtime context works. Functions used to hardcode "explicit if the
// env vars exist, else implicit", so the moment those vars were set every store
// access started failing — and mm-stock-cache could never be created at all.
//
// Implicit is tried FIRST because it is what actually works here. Explicit is
// kept as a fallback rather than deleted, so the code still works in contexts
// where the runtime context isn't injected (local CLI runs, or if Netlify
// changes this behaviour). Whichever authenticates is cached per store name for
// the life of the container, so the probe cost is paid once per cold start.
const { getStore } = require('@netlify/blobs');

const _resolved = new Map(); // storeName -> { store, mode }

function hasExplicit() {
  return Boolean(process.env.BLOBS_SITE_ID && process.env.BLOBS_TOKEN);
}

function build(name, mode) {
  return mode === 'explicit'
    ? getStore({ name, siteID: process.env.BLOBS_SITE_ID, token: process.env.BLOBS_TOKEN })
    : getStore(name);
}

function candidates() {
  const list = ['implicit'];
  if (hasExplicit()) list.push('explicit');
  return list;
}

function tag(err, tried) {
  const msg = String((err && err.message) || err);
  const e = new Error(msg);
  e.storeUnavailable = /401|403|BlobsInternalError|unauthor/i.test(msg);
  e.tried = tried || [];
  e.hint = 'Blobs rejected every auth mode tried (' + e.tried.join(', ') + '). '
    + 'Implicit is the mode that normally works on this project; if it is failing, '
    + 'check that Blobs is still enabled for the site.';
  return e;
}

// Probe each mode with a cheap read — a read is enough to prove auth.
async function resolveStore(name) {
  const hit = _resolved.get(name);
  if (hit) return hit.store;
  const tried = [];
  let lastErr = null;
  for (const mode of candidates()) {
    try {
      const store = build(name, mode);
      await store.get('__probe', { type: 'json' });
      _resolved.set(name, { store, mode });
      if (mode !== 'implicit') console.log('blob-store: ' + name + ' authenticated via ' + mode);
      return store;
    } catch (err) {
      tried.push(mode);
      lastErr = err;
      console.error('blob-store: ' + name + ' ' + mode + ' auth failed -', String(err && err.message || err));
    }
  }
  throw tag(lastErr, tried);
}

// Non-throwing variant for callers that want to report status instead of fail.
async function probeStore(name) {
  try {
    await resolveStore(name);
    const hit = _resolved.get(name);
    return { ok: true, mode: hit ? hit.mode : 'unknown' };
  } catch (err) {
    return { ok: false, mode: 'none', tried: err.tried, error: err.message, hint: err.hint };
  }
}

module.exports = { resolveStore, probeStore };
