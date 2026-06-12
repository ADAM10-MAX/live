/**
 * Friho TV — الخادم الرئيسي
 * تشغيل: node server.js
 *
 * للشبكة المغربية المحلية على المنفذ 80:
 *   sudo PORT=80 node server.js
 */

'use strict';

const http  = require('http');
const https = require('https');
const fs    = require('fs/promises');
const path  = require('path');
const { URL } = require('url');
const CFG   = require('./config');

const ROOT = __dirname;

// ── MIME Types ───────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts':   'video/mp2t',
};

// ── Simple in-memory cache ───────────────────────────────────
const cache = new Map();
function getCache(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() - item.time > CFG.CACHE_TTL_MS) { cache.delete(key); return null; }
  return item.data;
}
function setCache(key, data) { cache.set(key, { time: Date.now(), data }); }

// ── Helpers ──────────────────────────────────────────────────
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range');
}

function sendJson(res, status, data) {
  setCors(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  setCors(res);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(text);
}

function jsonFromText(text) {
  const oi = text.indexOf('{'), ai = text.indexOf('[');
  let start = -1;
  if (oi >= 0 && ai >= 0) start = Math.min(oi, ai);
  else start = Math.max(oi, ai);
  if (start < 0) throw new Error('Invalid JSON response');
  return JSON.parse(text.slice(start));
}

async function fetchWithTimeout(url, options = {}, timeout = CFG.CHECK_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, {
      redirect: 'follow',
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Friho TV Server)',
        'Accept':     'application/json,text/plain,text/html,*/*',
        'Referer':    'https://friho.tv/',
        ...(options.headers || {})
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonFromSources(apiPath, cacheKey) {
  const cached = getCache(cacheKey || apiPath);
  if (cached) return cached;

  let lastError = null;
  for (const base of CFG.SOURCE_BASES) {
    const url = `${base}${apiPath.replace(/^\/+/, '')}`;
    try {
      const response = await fetchWithTimeout(url, {}, 12000);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      const data = jsonFromText(text);
      setCache(cacheKey || apiPath, data);
      return data;
    } catch (error) {
      lastError = error;
      console.warn(`[source failed] ${url} -> ${error.message}`);
    }
  }
  throw lastError || new Error('All sources failed');
}

function parseMaybeJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try { const p = JSON.parse(value || '[]'); return Array.isArray(p) ? p : []; } catch { return []; }
}

function normalizeMatch(match) {
  const m = { ...match };
  m.channels = Array.isArray(m.channels) ? m.channels : parseMaybeJsonArray(m.channels);
  m.edges = parseMaybeJsonArray(m.edges).length ? parseMaybeJsonArray(m.edges) : (Array.isArray(match.edges) ? match.edges : []);
  return m;
}

function isHttpUrl(url) { return /^https?:\/\//i.test(String(url || '')); }
function isHls(channel, url) {
  return String(channel.type || '').toUpperCase() === 'HLS' || /\.m3u8(\?|$)/i.test(String(url || channel.link || ''));
}

function buildEdgeFrameUrls(match) {
  const edges  = parseMaybeJsonArray(match.edges).length ? parseMaybeJsonArray(match.edges) : (Array.isArray(match.edges) ? match.edges : []);
  const domain = match.edge_domain || '';
  if (edges.length && domain) return edges.map(e => `https://${e}.${domain}/frame.php`);
  return CFG.FALLBACK_FRAME_URLS;
}

function buildChannelCandidates(match, channel) {
  const candidates = [];
  const type = String(channel.type || '').toUpperCase();
  const directLink = channel.link || channel.url || channel.mobile_link || '';

  if (directLink && isHls(channel, directLink)) {
    candidates.push({ url: directLink, playback: 'HLS', source: 'direct-hls' });
    return candidates;
  }

  if (directLink && (type === 'LANDSCAPE' || type === 'FRAME') && Number(channel.edge) === 0) {
    candidates.push({ url: directLink, playback: 'Frame', source: 'direct-frame' });
  }

  const ch = channel.ch || channel.key || channel.id || '';
  if (ch) {
    const token = `friho-${Date.now().toString(36)}`;
    const kt = Math.floor(Date.now() / 1000);
    for (const frameBase of buildEdgeFrameUrls(match)) {
      candidates.push({
        url: `${frameBase}?ch=${encodeURIComponent(ch)}&p=${encodeURIComponent(CFG.P_VALUE)}&token=${encodeURIComponent(token)}&kt=${kt}`,
        playback: 'Frame',
        source: 'edge-frame'
      });
    }
  }

  if (directLink) {
    candidates.push({
      url: directLink,
      playback: isHls(channel, directLink) ? 'HLS' : 'Frame',
      source: 'original-link'
    });
  }

  const seen = new Set();
  return candidates.filter(item => {
    if (!isHttpUrl(item.url) || seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

async function checkUrl(candidate, channel) {
  if (!candidate || !isHttpUrl(candidate.url)) return { ok: false, reason: 'invalid-url' };
  try {
    const hls = candidate.playback === 'HLS' || isHls(channel, candidate.url);
    const response = await fetchWithTimeout(candidate.url, {
      method: 'GET',
      headers: hls
        ? { Accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,text/plain,*/*' }
        : { Accept: 'text/html,*/*' }
    }, CFG.CHECK_TIMEOUT_MS);

    const okStatus = response.status >= 200 && response.status < 400;
    if (!okStatus) {
      try { if (response.body) await response.body.cancel(); } catch {}
      return { ok: false, status: response.status, reason: `HTTP ${response.status}` };
    }

    if (hls) {
      const body = await response.text();
      const ok   = body.includes('#EXTM3U') || /\.ts|\.m3u8/i.test(body);
      return { ok, status: response.status, reason: ok ? 'hls-ok' : 'not-m3u8' };
    }

    try { if (response.body) await response.body.cancel(); } catch {}
    return { ok: true, status: response.status, reason: 'frame-ok' };
  } catch (error) {
    return { ok: false, reason: error.name === 'AbortError' ? 'timeout' : error.message };
  }
}

async function checkOneChannel(match, channel, index) {
  const candidates = buildChannelCandidates(match, channel);
  const checked = { ...channel, _checked: true, _working: false, _index: index, _candidates_count: candidates.length };

  for (const candidate of candidates) {
    const result = await checkUrl(candidate, channel);
    if (result.ok) {
      checked._working = true;
      checked._player_url = candidate.url;
      checked._playback   = candidate.playback;
      checked._source     = candidate.source;
      checked._check_status = result.status || 200;
      return checked;
    }
  }
  checked._check_status = 0;
  return checked;
}

async function checkChannels(match) {
  const channels = Array.isArray(match.channels) ? match.channels : [];
  if (!channels.length) return [];

  const cacheKey = `checked:${match.id || match.api_matche_id}:${match.date || ''}:${channels.length}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const checked = await Promise.all(channels.map((ch, i) => checkOneChannel(match, ch, i)));
  checked.sort((a, b) => {
    if (a._working !== b._working) return a._working ? -1 : 1;
    return (a._index || 0) - (b._index || 0);
  });

  setCache(cacheKey, checked);
  return checked;
}

// ── HLS Proxy ─────────────────────────────────────────────────
// يُعيد توجيه طلبات m3u8 وملفات TS من hes-goal مع إزالة الإعلانات
async function proxyHls(req, res, url) {
  const target = url.searchParams.get('url');
  if (!target || !isHttpUrl(target)) return sendJson(res, 400, { error: 'missing url param' });

  // للأمان: نسمح فقط بنطاقات موثوقة
  const allowedHosts = ['hes-goal.one', 'hes-goal.cc', 'kora-plus.mov', 'kora-api.space', 'kora-api.top'];
  let targetHost;
  try { targetHost = new URL(target).hostname; } catch { return sendJson(res, 400, { error: 'invalid url' }); }
  const allowed = allowedHosts.some(h => targetHost === h || targetHost.endsWith('.' + h));
  if (!allowed) return sendJson(res, 403, { error: 'domain not allowed' });

  try {
    const response = await fetchWithTimeout(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Friho TV)',
        'Origin': 'https://hes-goal.one',
        'Referer': 'https://hes-goal.one/',
        'Accept': 'application/vnd.apple.mpegurl,application/x-mpegURL,video/mp2t,*/*',
        'Range': req.headers['range'] || '',
      }
    }, 15000);

    if (!response.ok) throw new Error(`upstream HTTP ${response.status}`);

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const isM3u8 = contentType.includes('mpegurl') || target.includes('.m3u8');

    setCors(res);

    if (isM3u8) {
      // نُعيد كتابة m3u8: نحوّل روابط TS المطلقة/النسبية إلى proxy
      let text = await response.text();

      // نزيل مقاطع الإعلانات (#EXT-X-DISCONTINUITY إذا كانت قبل/بعد uri إعلاني)
      text = text.replace(/#EXT-X-DISCONTINUITY\s*\n[^\n]*ad[^\n]*\n/gi, '');

      // نحوّل كل رابط سطري إلى رابط proxy
      const baseUrl = target.substring(0, target.lastIndexOf('/') + 1);
      text = text.replace(/^(https?:\/\/[^\s]+)/mg, (match) =>
        `/api/proxy/hls?url=${encodeURIComponent(match)}`
      );
      text = text.replace(/^(?!#)([^\s]+\.ts[^\s]*)/mg, (match) => {
        const abs = match.startsWith('http') ? match : baseUrl + match;
        return `/api/proxy/hls?url=${encodeURIComponent(abs)}`;
      });
      text = text.replace(/^(?!#)([^\s]+\.m3u8[^\s]*)/mg, (match) => {
        const abs = match.startsWith('http') ? match : baseUrl + match;
        return `/api/proxy/hls?url=${encodeURIComponent(abs)}`;
      });

      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-cache',
      });
      res.end(text);
    } else {
      // ملفات TS: نمررها مباشرة
      res.writeHead(response.status, {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=60',
        'Content-Length': response.headers.get('content-length') || '',
      });
      const buffer = await response.arrayBuffer();
      res.end(Buffer.from(buffer));
    }
  } catch (error) {
    console.error('[proxy error]', error.message);
    sendJson(res, 502, { error: 'proxy error: ' + error.message });
  }
}

// ── API Handlers ──────────────────────────────────────────────
async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const route = parts[1];

  // /api/config — إعدادات العميل
  if (route === 'config') {
    return sendJson(res, 200, {
      APP_NAME:        CFG.APP_NAME,
      APP_SUBTITLE:    CFG.APP_SUBTITLE,
      TEAM_IMG_BASE:   CFG.TEAM_IMG_BASE,
      LEAGUE_IMG_BASE: CFG.LEAGUE_IMG_BASE,
      HES_GOAL_BASE:   CFG.HES_GOAL_BASE,
      HES_GOAL_STREAM_KEY: CFG.HES_GOAL_STREAM_KEY,
    });
  }

  // /api/health
  if (route === 'health') {
    return sendJson(res, 200, { ok: true, name: 'Friho TV server', time: new Date().toISOString() });
  }

  // /api/proxy/hls?url=...
  if (route === 'proxy' && parts[2] === 'hls') {
    return proxyHls(req, res, url);
  }

  // /api/match/:id/:lang?check=1
  if (route === 'match') {
    const id   = parts[2];
    const lang = parts[3] || 'ar';
    if (!id) return sendJson(res, 400, { error: 'missing match id' });

    const apiPath = `api/matche/${encodeURIComponent(id)}/${encodeURIComponent(lang)}?t=${Date.now()}`;
    const match   = normalizeMatch(await fetchJsonFromSources(apiPath, `match:${id}:${lang}`));

    if (url.searchParams.get('check') === '1') {
      match.channels       = await checkChannels(match);
      match.working_channel = match.channels.find(ch => ch._working) || null;
    }
    return sendJson(res, 200, match);
  }

  // /api/working/:id/:lang
  if (route === 'working') {
    const id   = parts[2];
    const lang = parts[3] || 'ar';
    if (!id) return sendJson(res, 400, { error: 'missing match id' });

    const apiPath = `api/matche/${encodeURIComponent(id)}/${encodeURIComponent(lang)}?t=${Date.now()}`;
    const match   = normalizeMatch(await fetchJsonFromSources(apiPath, `match:${id}:${lang}`));
    const channels = await checkChannels(match);
    return sendJson(res, 200, {
      id:              match.id,
      title:           `${match.home || match.home_en || ''} vs ${match.away || match.away_en || ''}`.trim(),
      working_channel: channels.find(ch => ch._working) || null,
      channels
    });
  }

  // /api/matches/:date/:page
  if (route === 'matches') {
    const date = parts[2] || new Date().toISOString().slice(0, 10);
    const page = parts[3] || '1';
    const apiPath = `api/matches/${encodeURIComponent(date)}/${encodeURIComponent(page)}?t=${Date.now()}`;
    const data = await fetchJsonFromSources(apiPath, `matches:${date}:${page}`);
    return sendJson(res, 200, data);
  }

  return sendJson(res, 404, { error: 'api route not found' });
}

// ── Static file server ────────────────────────────────────────
async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';

  const safePath = path.normalize(path.join(ROOT, pathname));
  if (!safePath.startsWith(ROOT)) return sendText(res, 403, 'Forbidden');

  try {
    const stat = await fs.stat(safePath);
    if (stat.isDirectory()) return sendText(res, 403, 'Forbidden');
    const ext  = path.extname(safePath).toLowerCase();
    const data = await fs.readFile(safePath);
    setCors(res);
    res.writeHead(200, {
      'Content-Type':  MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
    });
    res.end(data);
  } catch {
    sendText(res, 404, 'Not found');
  }
}

// ── Main server ───────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return await serveStatic(req, res, url);
  } catch (error) {
    console.error('[server error]', error.message);
    return sendJson(res, 500, { error: error.message || 'server error' });
  }
});

server.listen(CFG.PORT, '0.0.0.0', () => {
  console.log(`\n⚽  Friho TV — خادم محلي`);
  console.log(`   الرابط: http://localhost:${CFG.PORT}`);
  console.log(`   للشبكة المحلية: http://0.0.0.0:${CFG.PORT}`);
  console.log(`   المصادر: ${CFG.SOURCE_BASES.join(', ')}\n`);
});