const DEFAULT_LOGIN_RATE_LIMIT_WINDOW_MINUTES = 15;
const DEFAULT_LOGIN_RATE_LIMIT_MAX_ATTEMPTS = 5;

function parsePositiveInteger(rawValue, fallbackValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return fallbackValue;
  }

  const parsedValue = Number.parseInt(String(rawValue), 10);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return fallbackValue;
  }

  return parsedValue;
}

function normalizeRequestIp(req) {
  const rawIp = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  return String(rawIp).trim().toLowerCase() || 'unknown';
}

function createLoginRateLimiter(options = {}) {
  const windowMinutes = parsePositiveInteger(
    options.windowMinutes,
    DEFAULT_LOGIN_RATE_LIMIT_WINDOW_MINUTES
  );
  const maxAttempts = parsePositiveInteger(
    options.maxAttempts,
    DEFAULT_LOGIN_RATE_LIMIT_MAX_ATTEMPTS
  );
  const windowMs = windowMinutes * 60 * 1000;
  const attemptsByIp = new Map();
  let lastCleanupAt = 0;

  function cleanupExpiredEntries(now = Date.now()) {
    if (attemptsByIp.size === 0 || now - lastCleanupAt < windowMs) {
      return;
    }

    for (const [key, entry] of attemptsByIp.entries()) {
      if (!entry || entry.resetAt <= now) {
        attemptsByIp.delete(key);
      }
    }

    lastCleanupAt = now;
  }

  function getRequestKey(req) {
    return normalizeRequestIp(req);
  }

  function getActiveEntry(key, now = Date.now()) {
    const entry = attemptsByIp.get(key);
    if (!entry) {
      return null;
    }

    if (entry.resetAt <= now) {
      attemptsByIp.delete(key);
      return null;
    }

    return entry;
  }

  function middleware(req, res, next) {
    if (req.adminSetupRequired) {
      return next();
    }

    const now = Date.now();
    cleanupExpiredEntries(now);

    const key = getRequestKey(req);
    req.loginRateLimitKey = key;

    const entry = getActiveEntry(key, now);
    if (!entry || entry.failedAttempts < maxAttempts) {
      return next();
    }

    const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    res.set('Retry-After', String(retryAfterSeconds));

    if (typeof req.flash === 'function') {
      req.flash('error', 'Too many login attempts. Please wait a few minutes and try again.');
    }

    return res.redirect('/login');
  }

  function recordFailure(req) {
    const now = Date.now();
    cleanupExpiredEntries(now);

    const key = req.loginRateLimitKey || getRequestKey(req);
    const existingEntry = getActiveEntry(key, now);

    if (!existingEntry) {
      attemptsByIp.set(key, {
        failedAttempts: 1,
        resetAt: now + windowMs,
      });
      return;
    }

    existingEntry.failedAttempts += 1;
  }

  function reset(req) {
    const key = req.loginRateLimitKey || getRequestKey(req);
    attemptsByIp.delete(key);
  }

  return {
    middleware,
    recordFailure,
    reset,
    windowMinutes,
    maxAttempts,
  };
}

module.exports = {
  DEFAULT_LOGIN_RATE_LIMIT_MAX_ATTEMPTS,
  DEFAULT_LOGIN_RATE_LIMIT_WINDOW_MINUTES,
  createLoginRateLimiter,
};
