/**
 * Friho TV — Vercel Serverless Proxy
 * المسار: /api/proxy
 * يعمل كـ: /api/proxy?type=extract&url=...
 *           /api/proxy?type=frame&url=...
 *           /api/proxy?type=hls&url=...
 */

'use strict';

// نطاقات مسموح بها فقط
const ALLOWED = [
  'kora-plus.mov', 'kora-api.space', 'kora-api.top',
  'hes-goal.one', 'hes-goal.cc',
  'akamaized.net', 'cloudfront.net',
];

function isAllowed(hostname) {
  return ALLOWED.some(h => hostname === h || hostname.endsWith('.' + h));
}

function isHttpUrl(u) { return /^https?:\/\//i.test(String(u || '')); }

// قائمة نطاقات إعلانية للحذف
const AD_RE = /(?:exoclick|trafficjunky|propellerads|adcash|popcash|juicyads|plugrush|hilltopads|adsterra|clickadu|yllix|outbrain|taboola|googlesyndication|doubleclick|adnxs|openx|pubmatic|rubiconproject)/i;

// سكريبت الحماية يُحقن داخل الـ frame
const GUARD = `<script>(function(){
var _o=window.open;
window.open=function(u){if(!u||/\\.m3u8|\\.ts|\\.mp4/i.test(String(u)))return _o.apply(window,arguments);console.warn('[Guard] blocked popup:',String(u).slice(0,60));return null;};
var obs=new MutationObserver(function(ms){ms.forEach(function(m){m.addedNodes.forEach(function(n){if(!n.tagName)return;if(n.tagName.toLowerCase()==='iframe'){var s=n.src||n.getAttribute('src')||'';if(s&&${AD_RE.toString()}.test(s)){n.remove();}}});});});
obs.observe(document.documentElement,{childList:true,subtree:true});
document.addEventListener('visibilitychange',function(e){if(document.hidden)e.stopImmediatePropagation();},true);
window.addEventListener('blur',function(e){e.stopImmediatePropagation();},true);
})()</script>`;

function cleanHtml(html, frameUrl) {
  const origin = (() => { try { return new URL(frameUrl).origin; } catch { return ''; } })();
  const base   = frameUrl.replace(/[^/]*$/, '');

  // حذف scripts إعلانية
  html = html.replace(/<script[^>]+src=["'][^"']*["'][^>]*><\/script>/gi, t =>
    AD_RE.test(t) ? '<!-- ad-removed -->' : t);

  // حذف iframes إعلانية
  html = html.replace(/<iframe[\s\S]*?<\/iframe>/gi, t =>
    AD_RE.test(t) ? '' : t);

  // تحييد window.open في JS blocks
  html = html.replace(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi, (full, code) => {
    if (AD_RE.test(code)) return '<!-- js-ad-removed -->';
    const c = code
      .replace(/window\.open\s*\(\s*['"`](https?:\/\/(?!(?:hes-goal|kora)))[^)]+\)/g, '(void 0)')
      .replace(/(?:document\.location|location\.href)\s*=\s*['"`]https?:\/\/(?!(?:hes-goal|kora))/g, '//_blocked=');
    return full.replace(code, c);
  });

  // إصلاح الروابط النسبية
  html = html.replace(/(src|href)=["'](?!https?:|\/\/|data:|#|javascript:)([^"']+)["']/g,
    (_, a, p) => `${a}="${p.startsWith('/') ? origin + p : base + p}"`);
  html = html.replace(/(src|href)=["']\/\/([^"']+)["']/g, (_, a, p) => `${a}="https://${p}"`);

  // حقن الحارس
  html = html.replace(/(<head[^>]*>)/i, '$1' + GUARD);
  if (!/<head/i.test(html)) html = GUARD + html;

  return html;
}

async function extractHls(frameUrl) {
  const r = await fetch(frameUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0',
      'Referer': 'https://friho.tv/',
      'Accept': 'text/html,*/*',
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) return null;
  const html = await r.text();

  const pats = [
    /(?:file|source|src|stream|url|hls|m3u8)\s*[:=]\s*['"`]([^'"`]+\.m3u8[^'"`]*)/gi,
    /['"`](https?:\/\/[^'"`]+\.m3u8[^'"`]*)/gi,
    /(https?:\/\/\S+\.m3u8[^\s'"`,)>]*)/gi,
  ];
  for (const p of pats) {
    p.lastIndex = 0;
    const m = p.exec(html);
    if (m && isHttpUrl(m[1])) return m[1].trim();
  }
  return null;
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const { type, url: target, ref } = req.query;
  if (!target || !isHttpUrl(target)) return res.status(400).json({ error: 'missing url' });

  let hostname;
  try { hostname = new URL(target).hostname; } catch { return res.status(400).json({ error: 'bad url' }); }
  if (!isAllowed(hostname)) return res.status(403).json({ error: 'domain not allowed: ' + hostname });

  const targetOrigin = new URL(target).origin;

  // ── /api/proxy?type=extract ───────────────────────────────
  if (type === 'extract') {
    try {
      const hls = await extractHls(target);
      return res.status(200).json({ hls });
    } catch (e) {
      return res.status(200).json({ hls: null });
    }
  }

  // ── /api/proxy?type=frame ─────────────────────────────────
  if (type === 'frame') {
    try {
      const r = await fetch(target, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0',
          'Accept': 'text/html,*/*',
          'Referer': 'https://friho.tv/',
        },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) throw new Error('upstream ' + r.status);
      const html = cleanHtml(await r.text(), target);

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Frame-Options', 'ALLOWALL');
      res.setHeader('Content-Security-Policy', '');
      return res.status(200).send(html);
    } catch (e) {
      // fallback iframe wrapper
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(`<!DOCTYPE html><html><head><style>*{margin:0;padding:0}html,body,iframe{width:100%;height:100%}</style>${GUARD}</head><body><iframe src="${target}" frameborder="0" allowfullscreen allow="autoplay;fullscreen" scrolling="no"></iframe></body></html>`);
    }
  }

  // ── /api/proxy?type=hls ───────────────────────────────────
  if (type === 'hls') {
    try {
      const r = await fetch(target, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0',
          'Origin':  ref || targetOrigin,
          'Referer': (ref || targetOrigin) + '/',
          'Accept':  'application/vnd.apple.mpegurl,video/mp2t,*/*',
          'Range':   req.headers['range'] || '',
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) throw new Error('upstream ' + r.status);

      const ct = r.headers.get('content-type') || '';
      const isM3u8 = ct.includes('mpegurl') || /\.m3u8/i.test(target);

      res.setHeader('Cache-Control', 'no-cache');

      if (isM3u8) {
        let text = await r.text();
        const base = target.replace(/[^/]*$/, '');
        const rp   = ref ? `&ref=${encodeURIComponent(ref || targetOrigin)}` : '';

        // إزالة إعلانات SCTE-35
        text = text.replace(/#EXT-X-CUE[^\n]*\n?/gi, '');
        text = text.replace(/#EXT-OATCLS-SCTE35[^\n]*\n?/gi, '');
        text = text.replace(/#EXT-X-SCTE35[^\n]*\n?/gi, '');
        text = text.replace(
          /#EXT-X-DISCONTINUITY\s*\n(?:#[^\n]*\n)*[^\n#][^\n]*\n(?:#[^\n]*\n)*#EXT-X-DISCONTINUITY\s*\n/gi,
          ''
        );

        // إعادة كتابة الروابط
        text = text.replace(/^(?!#)(\S+)$/mg, seg => {
          if (!seg.trim()) return seg;
          const abs = /^https?:\/\//i.test(seg) ? seg
            : seg.startsWith('/') ? targetOrigin + seg
            : base + seg;
          return `/api/proxy?type=hls&url=${encodeURIComponent(abs)}${rp}`;
        });

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        return res.status(200).send(text);
      } else {
        const buf = Buffer.from(await r.arrayBuffer());
        res.setHeader('Content-Type', ct || 'video/mp2t');
        res.setHeader('Content-Length', buf.length);
        return res.status(200).send(buf);
      }
    } catch (e) {
      return res.status(502).json({ error: 'hls proxy error: ' + e.message });
    }
  }

  return res.status(400).json({ error: 'unknown type. use: extract|frame|hls' });
};
