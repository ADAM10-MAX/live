/**
 * Friho TV — ملف الإعدادات المركزي
 * يُستخدم في الخادم وفي الصفحات (عبر /config.json)
 *
 * للتشغيل على الشبكة المغربية المحلية:
 *   PORT=80 node server.js
 *
 * جميع المتغيرات قابلة للتجاوز عبر environment variables.
 */

module.exports = {
  // ── الخادم ──────────────────────────────────────────────
  PORT: Number(process.env.PORT || 3000),

  // ── قيمة P (مفتاح الجلسة لـ edge frames) ───────────────
  P_VALUE: Number(process.env.P_VALUE || 12),

  // ── مهلة التحقق من الرابط (ms) ──────────────────────────
  CHECK_TIMEOUT_MS: Number(process.env.CHECK_TIMEOUT_MS || 5500),

  // ── مدة الكاش (ms) ──────────────────────────────────────
  CACHE_TTL_MS: Number(process.env.CACHE_TTL_MS || 30000),

  // ── مصادر API (مرتّبة حسب الأولوية) ─────────────────────
  SOURCE_BASES: (process.env.STREAM_SOURCES || [
    'https://ws.kora-api.space/',
    'https://ws.kora-api.top/',
    'https://kora-api.space/'
  ].join(',')).split(',').map(s => s.trim()).filter(Boolean)
               .map(s => s.endsWith('/') ? s : `${s}/`),

  // ── Edge frame fallbacks ──────────────────────────────────
  FALLBACK_FRAME_URLS: (process.env.FRAME_FALLBACKS || [
    'https://a13.kora-plus.mov/frame.php',
    'https://a12.kora-plus.mov/frame.php',
    'https://a11.kora-plus.mov/frame.php'
  ].join(',')).split(',').map(s => s.trim()).filter(Boolean),

  // ── مصدر HLS مباشر (hes-goal) ────────────────────────────
  // يستخدم live3 للجمهور العربي
  HES_GOAL_BASE: process.env.HES_GOAL_BASE || 'https://hes-goal.one/',
  HES_GOAL_STREAM_KEY: process.env.HES_GOAL_STREAM_KEY || 'live3',

  // ── إعدادات العرض (تُرسل للعميل عبر /config.json) ───────
  APP_NAME: process.env.APP_NAME || 'Friho TV',
  APP_SUBTITLE: process.env.APP_SUBTITLE || 'بث مباشر مجاني — مباريات اليوم بجودة HD',
  TEAM_IMG_BASE: 'https://cdn.kora-api.space/uploads/team/',
  LEAGUE_IMG_BASE: 'https://cdn.kora-api.space/uploads/league/',

  // ── وصف الموقع لـ SEO ─────────────────────────────────────
  META_DESCRIPTION: 'شاهد مباريات اليوم بث مباشر مجاني بجودة HD على Friho TV. دوري أبطال أوروبا، البريميرليغ، الليغا، كأس العالم وأكثر.',
};