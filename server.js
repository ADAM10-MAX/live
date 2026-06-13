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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
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

// ═══════════════════════════════════════════════════════════════
// ── LAYER 1: استخراج رابط HLS من الـ frame مباشرة (بدون iframe)
// الخادم يجلب frame.php ويبحث عن رابط m3u8 داخل JS الصفحة
// ═══════════════════════════════════════════════════════════════
async function extractHlsFromFrame(frameUrl) {
  const cacheKey = `hls-extract:${frameUrl}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  try {
    const response = await fetchWithTimeout(frameUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*',
        'Referer': 'https://friho.tv/',
        'Origin':  'https://friho.tv',
      }
    }, 10000);

    if (!response.ok) return null;
    const html = await response.text();

    // أنماط استخراج رابط m3u8 من JavaScript داخل HTML
    const patterns = [
      // file: 'https://...' or source: 'https://...'
      /(?:file|source|src|stream|url|hls_url|m3u8)\s*[:=]\s*['"`]([^'"`]+\.m3u8[^'"`]*)[`'"]/gi,
      // jwplayer setup / videojs source
      /['"`](https?:\/\/[^'"`]+\.m3u8[^'"`]*)[`'"]/gi,
      // مباشرة داخل النص
      /(https?:\/\/\S+\.m3u8[^\s'"`,)>]*)/gi,
    ];

    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      const match = pattern.exec(html);
      if (match) {
        const hlsUrl = match[1].trim();
        if (hlsUrl && isHttpUrl(hlsUrl)) {
          // نتحقق أن الرابط يعمل فعلاً
          try {
            const check = await fetchWithTimeout(hlsUrl, {
              headers: {
                'Referer': new URL(frameUrl).origin + '/',
                'Origin':  new URL(frameUrl).origin,
                'Accept':  'application/vnd.apple.mpegurl,*/*',
              }
            }, 6000);
            if (check.ok) {
              const body = await check.text();
              if (body.includes('#EXTM3U') || /\.ts|\.m3u8/i.test(body)) {
                console.log(`[hls-extract] ✅ وجدنا HLS: ${hlsUrl}`);
                setCache(cacheKey, hlsUrl);
                return hlsUrl;
              }
            }
          } catch {}
        }
      }
    }
    return null;
  } catch (err) {
    console.warn('[hls-extract] فشل:', err.message);
    return null;
  }
}

// API: /api/proxy/extract?url=... → يرجع { hls: '...' } أو { hls: null }
async function handleExtract(req, res, url) {
  const target = url.searchParams.get('url');
  if (!target || !isHttpUrl(target)) return sendJson(res, 400, { error: 'missing url' });

  const hlsUrl = await extractHlsFromFrame(target);
  return sendJson(res, 200, { hls: hlsUrl });
}

// ═══════════════════════════════════════════════════════════════
// ── LAYER 2: HLS Proxy — يُوجّه m3u8 وTS مع إزالة إعلانات HLS
// ═══════════════════════════════════════════════════════════════
const ALLOWED_HLS_HOSTS = [
  'hes-goal.one', 'hes-goal.cc',
  'kora-plus.mov', 'kora-api.space', 'kora-api.top',
  'streame2.com', 'streameast.live',
  'gstatic.com', 'akamaized.net', 'cloudfront.net',
  'cdninstagram.com',
];

function isAllowedHlsHost(hostname) {
  return ALLOWED_HLS_HOSTS.some(h => hostname === h || hostname.endsWith('.' + h));
}

async function proxyHls(req, res, url) {
  const target = url.searchParams.get('url');
  const refOverride = url.searchParams.get('ref') || '';
  if (!target || !isHttpUrl(target)) return sendJson(res, 400, { error: 'missing url param' });

  let targetHost, targetOrigin;
  try {
    const u = new URL(target);
    targetHost   = u.hostname;
    targetOrigin = u.origin;
  } catch { return sendJson(res, 400, { error: 'invalid url' }); }

  if (!isAllowedHlsHost(targetHost)) return sendJson(res, 403, { error: 'domain not allowed' });

  try {
    const response = await fetchWithTimeout(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Origin':  refOverride || targetOrigin,
        'Referer': (refOverride || targetOrigin) + '/',
        'Accept':  'application/vnd.apple.mpegurl,application/x-mpegURL,video/mp2t,*/*',
        'Range':   req.headers['range'] || '',
      }
    }, 20000);

    if (!response.ok) throw new Error(`upstream HTTP ${response.status}`);

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const isM3u8 = contentType.includes('mpegurl') || /\.m3u8(\?|$)/i.test(target);

    setCors(res);

    if (isM3u8) {
      let text = await response.text();
      const baseUrl = target.substring(0, target.lastIndexOf('/') + 1);
      const refParam = `&ref=${encodeURIComponent(targetOrigin)}`;

      // ── إزالة إعلانات SCTE-35 / #EXT-X-DISCONTINUITY ──────
      // نحذف أي مقطع إعلاني كامل (من DISCONTINUITY إلى DISCONTINUITY)
      text = text.replace(
        /#EXT-X-DISCONTINUITY\s*\n(?:#[^\n]*\n)*[^\n#][^\n]*\n(?:#[^\n]*\n)*#EXT-X-DISCONTINUITY\s*\n/gi,
        ''
      );
      // إزالة روابط إعلانية واضحة
      text = text.replace(/^[^\n#]*(?:ad|ads|advert|banner|preroll|midroll|postroll|doubleclick|googlesyndication)[^\n]*$/gim, '');
      // إزالة تعليقات الإعلانات
      text = text.replace(/#EXT-X-CUE[^\n]*\n?/gi, '');
      text = text.replace(/#EXT-OATCLS-SCTE35[^\n]*\n?/gi, '');
      text = text.replace(/#EXT-X-SCTE35[^\n]*\n?/gi, '');

      // ── إعادة كتابة كل الروابط عبر proxy ──────────────────
      text = text.replace(/^(?!#)(\S+)$/mg, (match) => {
        if (!match.trim()) return match;
        const abs = /^https?:\/\//i.test(match) ? match : (match.startsWith('/') ? targetOrigin + match : baseUrl + match);
        if (/\.m3u8/i.test(abs)) return `/api/proxy/hls?url=${encodeURIComponent(abs)}${refParam}`;
        if (/\.ts/i.test(abs) || isAllowedHlsHost(new URL(abs).hostname)) return `/api/proxy/hls?url=${encodeURIComponent(abs)}${refParam}`;
        return `/api/proxy/hls?url=${encodeURIComponent(abs)}${refParam}`;
      });

      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache' });
      res.end(text);
    } else {
      // ملفات TS وغيرها — نمررها مباشرة
      const rangeStatus = req.headers['range'] ? 206 : response.status;
      res.writeHead(rangeStatus, {
        'Content-Type':   contentType,
        'Cache-Control':  'public, max-age=60',
        'Content-Length': response.headers.get('content-length') || '',
        'Content-Range':  response.headers.get('content-range')  || '',
        'Accept-Ranges':  'bytes',
      });
      const buffer = await response.arrayBuffer();
      res.end(Buffer.from(buffer));
    }
  } catch (error) {
    console.error('[hls-proxy error]', error.message);
    sendJson(res, 502, { error: 'proxy error: ' + error.message });
  }
}

// ═══════════════════════════════════════════════════════════════
// ── LAYER 3: Frame Proxy — يُنظّف HTML ويُزيل كل الإعلانات
// إذا فشل استخراج HLS، نجلب الـ frame ونُشغّلها نظيفة
// ═══════════════════════════════════════════════════════════════

// قائمة نطاقات الإعلانات الشهيرة لحذفها من HTML
const AD_DOMAINS_PATTERN = /(?:doubleclick\.net|googlesyndication\.com|adnxs\.com|advertising\.com|adform\.net|openx\.net|pubmatic\.com|rubiconproject\.com|moatads\.com|scorecardresearch\.com|quantserve\.com|outbrain\.com|taboola\.com|zedo\.com|adroll\.com|hotjar\.com|trafficjunky\.com|exoclick\.com|juicyads\.com|plugrush\.com|hilltopads\.net|popcash\.net|propellerads\.com|adsterra\.com|yllix\.com|clickadu\.com|adcash\.com)/i;

// أنماط JavaScript مشبوهة تُولّد popups
const AD_JS_PATTERNS = [
  /window\.open\s*\(/g,
  /document\.location\s*=/g,
  /location\.replace\s*\(/g,
  /location\.assign\s*\(/g,
  /location\.href\s*=\s*['"`]https?/g,
  /onclick\s*=\s*["'][^"']*(?:http|window\.open)/gi,
  // سكريبتات الـ popup الشهيرة
  /new\s+(?:Ad|Popup|Banner|Pop)\s*\(/gi,
  /showAd\s*\(/gi,
  /openPopup\s*\(/gi,
];

function cleanAdHtml(html, frameUrl) {
  const targetOrigin = (() => { try { return new URL(frameUrl).origin; } catch { return ''; } })();
  const baseUrl      = frameUrl.substring(0, frameUrl.lastIndexOf('/') + 1);

  // 1. حذف وسوم script تحتوي على src لنطاقات إعلانية
  html = html.replace(/<script[^>]*src=["'][^"']*["'][^>]*><\/script>/gi, (tag) => {
    if (AD_DOMAINS_PATTERN.test(tag)) {
      console.log('[ad-clean] حذف script إعلاني:', tag.substring(0, 80));
      return '<!-- ad-removed -->';
    }
    return tag;
  });

  // 2. حذف iframes إعلانية
  html = html.replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, (tag) => {
    if (AD_DOMAINS_PATTERN.test(tag)) return '<!-- ad-iframe-removed -->';
    return tag;
  });

  // 3. حذف script blocks تحتوي على أكواد popup/redirect
  html = html.replace(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi, (fullTag, code) => {
    // إذا كان الكود يحتوي على window.open أو location.href إلى domain خارجي — احذفه
    const hasAdCode = AD_DOMAINS_PATTERN.test(code) ||
      /window\.open\s*\(\s*['"`]https?:\/\/(?!(?:hes-goal|kora|friho))/i.test(code) ||
      /document\.location\s*=\s*['"`]https?:\/\/(?!(?:hes-goal|kora|friho))/i.test(code);

    if (hasAdCode) {
      console.log('[ad-clean] حذف JS إعلاني (block)');
      return '<!-- js-ad-removed -->';
    }

    // تحييد window.open داخل الكود المتبقي
    let cleaned = code
      .replace(/window\.open\s*\([^)]*\)/g, '(function(){})()')
      .replace(/window\.location\s*=\s*['"`]https?:\/\/(?!(?:hes-goal|kora))/g, '//blocked-redirect=');

    return fullTag.replace(code, cleaned);
  });

  // 4. حذف onclick إعلاني من عناصر HTML
  html = html.replace(/onclick\s*=\s*["'][^"']*window\.open[^"']*["']/gi, 'onclick=""');
  html = html.replace(/onclick\s*=\s*["'][^"']*location\.href[^"']*["']/gi, 'onclick=""');

  // 5. إصلاح الروابط النسبية
  html = html.replace(/(src|href)=["'](?!https?:\/\/|\/\/|data:|#|javascript:)([^"']+)["']/g, (_, attr, p) => {
    if (p.startsWith('/')) return `${attr}="${targetOrigin}${p}"`;
    return `${attr}="${baseUrl}${p}"`;
  });
  html = html.replace(/(src|href)=["']\/\/([^"']+)["']/g, (_, attr, p) => `${attr}="https://${p}"`);

  // 6. حقن script للحماية داخل الـ frame نفسها
  const guardScript = `
<script>
(function() {
  'use strict';
  // تجميد window.open
  var _origOpen = window.open;
  window.open = function(url, name, features) {
    if (!url || url === 'about:blank' || url === '') return null;
    // نسمح فقط لروابط بث معروفة
    var allowed = /\\.(m3u8|ts|mp4|mpd)/i.test(String(url));
    if (allowed) return _origOpen.call(window, url, name, features);
    console.warn('[FrihoTV Guard] منع popup:', url);
    return null;
  };
  // منع الـ redirect التلقائي
  var _loc = window.location;
  try {
    Object.defineProperty(window, 'location', {
      get: function() { return _loc; },
      set: function(v) { console.warn('[FrihoTV Guard] منع location redirect:', v); }
    });
  } catch(e) {}
  // مراقبة document.createElement لمنع إنشاء iframes إعلانية
  var _origCreate = document.createElement.bind(document);
  document.createElement = function(tag) {
    var el = _origCreate(tag);
    if (tag.toLowerCase() === 'iframe') {
      var _origSet = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src');
      // سنتعامل معه عبر MutationObserver أدناه
    }
    return el;
  };
  // MutationObserver: يحذف أي iframe أو div إعلاني يُضاف ديناميكياً
  var observer = new MutationObserver(function(mutations) {
    mutations.forEach(function(m) {
      m.addedNodes.forEach(function(node) {
        if (!node.tagName) return;
        var tag = node.tagName.toLowerCase();
        // iframe مشبوه
        if (tag === 'iframe') {
          var src = node.src || node.getAttribute('src') || '';
          if (src && !/(?:hes-goal|kora|friho|about:blank|^$)/i.test(src)) {
            console.warn('[FrihoTV Guard] حذف iframe إعلاني:', src);
            node.remove();
          }
        }
        // div/a overlay إعلاني (يغطي الشاشة)
        if (['div','a','span'].includes(tag)) {
          var style = node.style;
          if (style && (style.position === 'fixed' || style.position === 'absolute') &&
              style.zIndex > 100 && node.children.length === 0) {
            var href = node.href || '';
            if (href && !/(?:hes-goal|kora|friho)/i.test(href)) {
              console.warn('[FrihoTV Guard] حذف overlay إعلاني');
              node.remove();
            }
          }
        }
      });
    });
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
<\/script>`;

  // أضف السكريبت في بداية الـ head
  html = html.replace(/(<head[^>]*>)/i, '$1' + guardScript);
  if (!/<head/i.test(html)) html = guardScript + html;

  return html;
}

async function proxyFrame(req, res, url) {
  const target = url.searchParams.get('url');
  if (!target || !isHttpUrl(target)) return sendJson(res, 400, { error: 'missing url param' });

  let targetHost;
  try { targetHost = new URL(target).hostname; } catch { return sendJson(res, 400, { error: 'invalid url' }); }

  const allowedFrameHosts = [
    'kora-plus.mov', 'kora-api.space', 'kora-api.top',
    'hes-goal.one', 'hes-goal.cc',
  ];
  const allowed = allowedFrameHosts.some(h => targetHost === h || targetHost.endsWith('.' + h));
  if (!allowed) return sendJson(res, 403, { error: 'domain not allowed' });

  try {
    const response = await fetchWithTimeout(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'ar,en;q=0.9',
        'Referer':         'https://friho.tv/',
        'Origin':          'https://friho.tv',
      }
    }, 12000);

    if (!response.ok) throw new Error(`upstream HTTP ${response.status}`);

    const html = await response.text();
    const cleanHtml = cleanAdHtml(html, target);

    setCors(res);
    res.writeHead(200, {
      'Content-Type':           'text/html; charset=utf-8',
      'Cache-Control':          'no-cache',
      'X-Frame-Options':        'ALLOWALL',
      'Content-Security-Policy': '',
    });
    res.end(cleanHtml);

  } catch (error) {
    console.error('[frame-proxy error]', error.message);
    // Fallback: نرسل iframe wrapper نظيف مع الحماية
    setCors(res);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(`<!DOCTYPE html><html><head><style>*{margin:0;padding:0;box-sizing:border-box}html,body,iframe{width:100%;height:100%;overflow:hidden}</style><script>(function(){var o=window.open;window.open=function(u){if(!u||/m3u8|ts|mp4/i.test(u))return o.apply(window,arguments);return null};})();<\/script></head><body><iframe src="${target}" frameborder="0" allowfullscreen allow="autoplay;fullscreen" scrolling="no" sandbox="allow-scripts allow-same-origin allow-forms allow-presentation"></iframe></body></html>`);
  }
}

// ── API Handlers ──────────────────────────────────────────────
async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const route = parts[1];

  if (route === 'config') {
    return sendJson(res, 200, {
      APP_NAME:            CFG.APP_NAME,
      APP_SUBTITLE:        CFG.APP_SUBTITLE,
      TEAM_IMG_BASE:       CFG.TEAM_IMG_BASE,
      LEAGUE_IMG_BASE:     CFG.LEAGUE_IMG_BASE,
      HES_GOAL_BASE:       CFG.HES_GOAL_BASE,
      HES_GOAL_STREAM_KEY: CFG.HES_GOAL_STREAM_KEY,
    });
  }

  if (route === 'health') {
    return sendJson(res, 200, { ok: true, name: 'Friho TV server', time: new Date().toISOString() });
  }

  // /api/proxy/hls?url=...
  if (route === 'proxy' && parts[2] === 'hls') return proxyHls(req, res, url);

  // /api/proxy/frame?url=... — يجلب frame ويُزيل الإعلانات
  if (route === 'proxy' && parts[2] === 'frame') return proxyFrame(req, res, url);

  // /api/proxy/extract?url=... — يستخرج HLS من frame
  if (route === 'proxy' && parts[2] === 'extract') return handleExtract(req, res, url);

  if (route === 'match') {
    const id   = parts[2];
    const lang = parts[3] || 'ar';
    if (!id) return sendJson(res, 400, { error: 'missing match id' });
    const apiPath = `api/matche/${encodeURIComponent(id)}/${encodeURIComponent(lang)}?t=${Date.now()}`;
    const match   = normalizeMatch(await fetchJsonFromSources(apiPath, `match:${id}:${lang}`));
    if (url.searchParams.get('check') === '1') {
      match.channels        = await checkChannels(match);
      match.working_channel = match.channels.find(ch => ch._working) || null;
    }
    return sendJson(res, 200, match);
  }

  if (route === 'working') {
    const id   = parts[2];
    const lang = parts[3] || 'ar';
    if (!id) return sendJson(res, 400, { error: 'missing match id' });
    const apiPath  = `api/matche/${encodeURIComponent(id)}/${encodeURIComponent(lang)}?t=${Date.now()}`;
    const match    = normalizeMatch(await fetchJsonFromSources(apiPath, `match:${id}:${lang}`));
    const channels = await checkChannels(match);
    return sendJson(res, 200, {
      id:              match.id,
      title:           `${match.home || match.home_en || ''} vs ${match.away || match.away_en || ''}`.trim(),
      working_channel: channels.find(ch => ch._working) || null,
      channels
    });
  }

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
