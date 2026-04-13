const crypto = require('crypto');

const ANALYTICS_DEDUPE_WINDOW_MS = 30 * 60 * 1000;
const DEFAULT_ANALYTICS_RETENTION_DAYS = 7;
const ANALYTICS_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const recentAnalyticsViews = new Map();
let lastAnalyticsPruneAt = 0;

const EXCLUDED_ANALYTICS_PATH_PREFIXES = ['/admin'];
const EXCLUDED_ANALYTICS_PATHS = new Set(['/login', '/login/2fa', '/logout', '/setup']);
const LOCAL_ANALYTICS_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);
const DEV_TRAFFIC_USER_AGENT_TOKENS = ['postman', 'insomnia', 'curl/', 'wget/', 'node', 'headlesschrome', 'lighthouse'];

function cleanupRecentAnalyticsViews(now = Date.now()) {
  for (const [key, timestamp] of recentAnalyticsViews.entries()) {
    if (now - timestamp > ANALYTICS_DEDUPE_WINDOW_MS) {
      recentAnalyticsViews.delete(key);
    }
  }
}

function buildVisitorFingerprint(req) {
  const ipAddress = req.ip || (req.socket && req.socket.remoteAddress) || '';
  const userAgent = req.get('user-agent') || '';

  return crypto
    .createHash('sha256')
    .update(`${ipAddress}|${userAgent}`, 'utf8')
    .digest('hex');
}

function normalizeRequestHost(req) {
  const requestHost = typeof req.hostname === 'string' && req.hostname.trim()
    ? req.hostname.trim().toLowerCase()
    : (req.get('host') || '').trim().toLowerCase();

  if (!requestHost) {
    return '';
  }

  if (requestHost.startsWith('[')) {
    const bracketEnd = requestHost.indexOf(']');
    return bracketEnd >= 0 ? requestHost.slice(0, bracketEnd + 1) : requestHost;
  }

  return requestHost.split(':')[0];
}

function normalizeRequestIp(req) {
  const rawIp = String(req.ip || (req.socket && req.socket.remoteAddress) || '').trim().toLowerCase();
  return rawIp.startsWith('::ffff:') ? rawIp.slice(7) : rawIp;
}

function isLocalOrDevHost(host) {
  return !!host && (
    LOCAL_ANALYTICS_HOSTS.has(host)
    || host.endsWith('.local')
    || host.endsWith('.test')
    || host.endsWith('.localhost')
  );
}

function isLocalOrDevIp(ipAddress) {
  return !!ipAddress && (
    ipAddress === '127.0.0.1'
    || ipAddress === '::1'
    || ipAddress === '0.0.0.0'
  );
}

function hasDevTrafficUserAgent(req) {
  const userAgent = String(req.get('user-agent') || '').toLowerCase();
  return DEV_TRAFFIC_USER_AGENT_TOKENS.some((token) => userAgent.includes(token));
}

function normalizeAnalyticsPath(value) {
  if (typeof value !== 'string') {
    return '/';
  }

  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return '/';
  }

  return trimmedValue.split('?')[0] || '/';
}

function isExcludedAnalyticsPath(pathname) {
  const normalizedPath = normalizeAnalyticsPath(pathname);
  return EXCLUDED_ANALYTICS_PATHS.has(normalizedPath)
    || EXCLUDED_ANALYTICS_PATH_PREFIXES.some((prefix) => normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`));
}

function normalizeReferrerHost(req) {
  const referrer = req.get('referer');
  if (!referrer) {
    return null;
  }

  try {
    const referrerUrl = new URL(referrer);
    const requestHost = (req.get('host') || '').split(':')[0].trim().toLowerCase();
    const referrerHost = (referrerUrl.hostname || '').trim().toLowerCase();

    if (!referrerHost) {
      return null;
    }

    if (requestHost && referrerHost === requestHost) {
      return 'self';
    }

    return referrerHost;
  } catch (err) {
    return null;
  }
}

function normalizeAnalyticsEvent(event = {}) {
  return {
    requestPath: normalizeAnalyticsPath(event.requestPath),
    pageType: typeof event.pageType === 'string' && event.pageType.trim() ? event.pageType.trim() : 'page',
    contentType: typeof event.contentType === 'string' && event.contentType.trim() ? event.contentType.trim() : null,
    contentId: Number.isInteger(event.contentId) ? event.contentId : null,
    contentSlug: typeof event.contentSlug === 'string' && event.contentSlug.trim() ? event.contentSlug.trim() : null,
  };
}

function shouldTrackAnalyticsRequest(req, event = {}) {
  if (!req || (req.method || 'GET').toUpperCase() !== 'GET') {
    return false;
  }

  if (req.session && req.session.admin) {
    return false;
  }

  const normalizedPath = normalizeAnalyticsPath(event.requestPath || req.path || req.originalUrl || '/');
  if (isExcludedAnalyticsPath(normalizedPath)) {
    return false;
  }

  if (req.query && typeof req.query.preview === 'string' && req.query.preview.trim()) {
    return false;
  }

  if (isLocalOrDevHost(normalizeRequestHost(req)) || isLocalOrDevIp(normalizeRequestIp(req))) {
    return false;
  }

  if (hasDevTrafficUserAgent(req)) {
    return false;
  }

  return true;
}

function normalizeAnalyticsRetentionDays() {
  return DEFAULT_ANALYTICS_RETENTION_DAYS;
}

async function maybePruneAnalyticsEvents(db, force = false) {
  if (!db) {
    return false;
  }

  const now = Date.now();
  if (!force && lastAnalyticsPruneAt && now - lastAnalyticsPruneAt < ANALYTICS_PRUNE_INTERVAL_MS) {
    return false;
  }

  await pruneOldAnalyticsEvents(db);
  lastAnalyticsPruneAt = now;
  return true;
}

async function recordAnalyticsPageView(req, event = {}) {
  const db = req && req.app && req.app.locals ? req.app.locals.db : null;
  if (!db) {
    return false;
  }

  const normalizedEvent = normalizeAnalyticsEvent(event);
  if (!shouldTrackAnalyticsRequest(req, normalizedEvent)) {
    return false;
  }

  await maybePruneAnalyticsEvents(db);

  const now = Date.now();
  cleanupRecentAnalyticsViews(now);

  const dedupeKey = crypto
    .createHash('sha256')
    .update(`${buildVisitorFingerprint(req)}|${normalizedEvent.requestPath}`, 'utf8')
    .digest('hex');

  const lastSeenAt = recentAnalyticsViews.get(dedupeKey);
  if (lastSeenAt && now - lastSeenAt < ANALYTICS_DEDUPE_WINDOW_MS) {
    return false;
  }

  try {
    await db.run(
      `INSERT INTO analytics_page_views (
        request_path,
        page_type,
        content_type,
        content_id,
        content_slug,
        referrer_host
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      normalizedEvent.requestPath,
      normalizedEvent.pageType,
      normalizedEvent.contentType,
      normalizedEvent.contentId,
      normalizedEvent.contentSlug,
      normalizeReferrerHost(req)
    );

    recentAnalyticsViews.set(dedupeKey, now);
    return true;
  } catch (err) {
    console.error('Analytics record error:', err);
    return false;
  }
}

async function pruneOldAnalyticsEvents(db, retentionDays = DEFAULT_ANALYTICS_RETENTION_DAYS) {
  const normalizedRetentionDays = normalizeAnalyticsRetentionDays(retentionDays);

  await db.run(
    `DELETE FROM analytics_page_views
     WHERE viewed_at < datetime('now', ?)`,
    `-${normalizedRetentionDays} days`
  );
}

async function resetAnalyticsPageViews(db) {
  if (!db) {
    return;
  }

  recentAnalyticsViews.clear();
  await db.run('DELETE FROM analytics_page_views');
}

function buildRecentDaySummary(rows, totalDays = 7) {
  const byDay = new Map((rows || []).map((row) => [row.day, row.views]));
  const items = [];

  for (let offset = totalDays - 1; offset >= 0; offset -= 1) {
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - offset);
    const isoDay = day.toISOString().slice(0, 10);

    items.push({
      day: isoDay,
      views: byDay.get(isoDay) || 0,
    });
  }

  return items;
}

function formatAnalyticsPage(row) {
  const pageType = row.page_type || 'page';

  if (pageType === 'project_detail') {
    return {
      label: row.project_title || 'Project Detail',
      path: row.project_slug ? `/projects/${row.project_slug}` : '/projects/:slug',
      views: row.views,
    };
  }

  if (pageType === 'video_detail') {
    return {
      label: row.video_title || 'Video Detail',
      path: row.video_slug ? `/videos/${row.video_slug}` : '/videos/:slug',
      views: row.views,
    };
  }

  if (pageType === 'gallery_detail') {
    return {
      label: row.gallery_title || 'Gallery Detail',
      path: row.gallery_slug ? `/gallery/${row.gallery_slug}` : '/gallery/:slug',
      views: row.views,
    };
  }

  if (pageType === 'music_detail') {
    return {
      label: row.music_title || 'Track Detail',
      path: row.music_slug ? `/music/${row.music_slug}` : '/music/:slug',
      views: row.views,
    };
  }

  if (pageType === 'tag') {
    return {
      label: 'Tag Page',
      path: row.content_slug ? `/tags/${row.content_slug}` : '/tags/:tag',
      views: row.views,
    };
  }

  const fallbackLabels = {
    home: 'Home',
    music: 'Music',
    videos: 'Videos',
    gallery: 'Gallery',
    projects: 'Projects',
    search: 'Search',
  };

  return {
    label: fallbackLabels[pageType] || row.request_path,
    path: row.request_path,
    views: row.views,
  };
}

async function getAnalyticsSummary(db) {
  await maybePruneAnalyticsEvents(db, true);

  const totals = await db.get(
    `SELECT
       COUNT(*) AS total_views,
       SUM(CASE WHEN viewed_at >= datetime('now', '-1 day') THEN 1 ELSE 0 END) AS views_last_24_hours,
       SUM(CASE WHEN viewed_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS views_last_7_days
     FROM analytics_page_views`
  );

  const topPagesRows = await db.all(
    `SELECT
       ae.request_path,
       ae.page_type,
       ae.content_type,
       ae.content_id,
       ae.content_slug,
       COUNT(*) AS views,
       m.title AS music_title,
       m.slug AS music_slug,
       p.title AS project_title,
       p.slug AS project_slug,
       v.title AS video_title,
       v.slug AS video_slug,
       g.title AS gallery_title,
       g.slug AS gallery_slug
     FROM analytics_page_views ae
     LEFT JOIN music m
       ON ae.page_type = 'music_detail'
      AND ae.content_slug = m.slug
      AND COALESCE(m.publication_status, 'published') = 'published'
     LEFT JOIN projects p
       ON ae.page_type = 'project_detail'
      AND ae.content_slug = p.slug
      AND COALESCE(p.publication_status, 'published') = 'published'
     LEFT JOIN videos v
       ON ae.page_type = 'video_detail'
      AND ae.content_slug = v.slug
      AND COALESCE(v.publication_status, 'published') = 'published'
     LEFT JOIN gallery g
       ON ae.page_type = 'gallery_detail'
      AND ae.content_slug = g.slug
      AND COALESCE(g.publication_status, 'published') = 'published'
     WHERE ae.page_type NOT IN ('music_detail', 'project_detail', 'video_detail', 'gallery_detail')
        OR (ae.page_type = 'music_detail' AND m.slug IS NOT NULL)
        OR (ae.page_type = 'project_detail' AND p.slug IS NOT NULL)
        OR (ae.page_type = 'video_detail' AND v.slug IS NOT NULL)
        OR (ae.page_type = 'gallery_detail' AND g.slug IS NOT NULL)
     GROUP BY ae.request_path, ae.page_type, ae.content_type, ae.content_id, ae.content_slug, m.title, m.slug, p.title, p.slug, v.title, v.slug, g.title, g.slug
     ORDER BY views DESC, ae.request_path ASC
     LIMIT 10`
  );

  const topProjects = await db.all(
    `SELECT
       p.title AS label,
       '/projects/' || p.slug AS path,
       COUNT(*) AS views
     FROM analytics_page_views ae
     JOIN projects p
       ON ae.content_slug = p.slug
      AND COALESCE(p.publication_status, 'published') = 'published'
     WHERE ae.page_type = 'project_detail'
     GROUP BY ae.content_slug, p.title, p.slug
     ORDER BY views DESC, label ASC
     LIMIT 10`
  );

  const topVideos = await db.all(
    `SELECT
       v.title AS label,
       '/videos/' || v.slug AS path,
       COUNT(*) AS views
     FROM analytics_page_views ae
     JOIN videos v
       ON ae.content_slug = v.slug
      AND COALESCE(v.publication_status, 'published') = 'published'
     WHERE ae.page_type = 'video_detail'
     GROUP BY ae.content_slug, v.title, v.slug
     ORDER BY views DESC, label ASC
     LIMIT 10`
  );

  const topReferrers = await db.all(
    `SELECT
       CASE
         WHEN referrer_host IS NULL OR TRIM(referrer_host) = '' THEN 'Direct / Unknown'
         ELSE referrer_host
       END AS label,
       COUNT(*) AS views
     FROM analytics_page_views
     WHERE referrer_host IS NULL OR LOWER(TRIM(referrer_host)) != 'self'
     GROUP BY label
     ORDER BY views DESC, label ASC
     LIMIT 10`
  );

  const recentDailyViewsRows = await db.all(
    `SELECT date(viewed_at) AS day, COUNT(*) AS views
     FROM analytics_page_views
     WHERE viewed_at >= datetime('now', '-6 days')
     GROUP BY date(viewed_at)
     ORDER BY day ASC`
  );

  return {
    totals: {
      totalViews: totals && Number.isFinite(totals.total_views) ? totals.total_views : 0,
      viewsLast24Hours: totals && Number.isFinite(totals.views_last_24_hours) ? totals.views_last_24_hours : 0,
      viewsLast7Days: totals && Number.isFinite(totals.views_last_7_days) ? totals.views_last_7_days : 0,
    },
    recentDailyViews: buildRecentDaySummary(recentDailyViewsRows, 7),
    topPages: topPagesRows.map(formatAnalyticsPage),
    topProjects,
    topVideos,
    topReferrers,
  };
}

module.exports = {
  ANALYTICS_DEDUPE_WINDOW_MS,
  DEFAULT_ANALYTICS_RETENTION_DAYS,
  getAnalyticsSummary,
  pruneOldAnalyticsEvents,
  recordAnalyticsPageView,
  resetAnalyticsPageViews,
  shouldTrackAnalyticsRequest,
};