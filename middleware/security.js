const crypto = require('crypto');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function createCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

function attachCsrfToken(req, res, next) {
  const requiresToken = !!(
    req.session && req.session.admin
  ) || req.path === '/login' || req.path === '/login/2fa' || req.path === '/logout' || req.path === '/setup' || req.path.startsWith('/admin');

  if (!req.session || !requiresToken) {
    res.locals.csrfToken = '';
    return next();
  }

  if (!req.session.csrfToken) {
    req.session.csrfToken = createCsrfToken();
  }

  res.locals.csrfToken = req.session.csrfToken;

  next();
}

function getRequestCsrfToken(req) {
  if (req.body && typeof req.body._csrf === 'string') {
    return req.body._csrf;
  }

  if (req.query && typeof req.query._csrf === 'string') {
    return req.query._csrf;
  }

  const headerToken = req.get('x-csrf-token') || req.get('x-xsrf-token');
  return typeof headerToken === 'string' ? headerToken : '';
}

function tokensMatch(sessionToken, requestToken) {
  if (!sessionToken || !requestToken) return false;

  const sessionBuffer = Buffer.from(sessionToken);
  const requestBuffer = Buffer.from(requestToken);
  if (sessionBuffer.length !== requestBuffer.length) return false;

  return crypto.timingSafeEqual(sessionBuffer, requestBuffer);
}

function rejectInvalidCsrf(req, res) {
  const requestedWith = (req.get('x-requested-with') || '').toLowerCase();
  const acceptsJson = (req.get('accept') || '').toLowerCase().includes('application/json');
  const expectsJson = requestedWith === 'xmlhttprequest' || acceptsJson || req.path === '/admin/music/metadata-preview';

  if (expectsJson) {
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }

  if (typeof req.flash === 'function') {
    req.flash('error', 'Your session expired or the form token was invalid. Please try again.');
  }

  const fallbackPath = req.session && req.session.admin ? '/admin' : (req.adminSetupRequired ? '/setup' : '/login');
  return res.status(403).redirect(req.get('referrer') || fallbackPath);
}

function validateCsrfToken(req, res, next) {
  if (SAFE_METHODS.has((req.method || 'GET').toUpperCase())) {
    return next();
  }

  const sessionToken = req.session && req.session.csrfToken ? req.session.csrfToken : '';
  const requestToken = getRequestCsrfToken(req);

  if (tokensMatch(sessionToken, requestToken)) {
    return next();
  }

  return rejectInvalidCsrf(req, res);
}

function validateCsrfTokenForNonMultipart(req, res, next) {
  if (SAFE_METHODS.has((req.method || 'GET').toUpperCase())) {
    return next();
  }

  const contentType = (req.headers['content-type'] || '').toLowerCase();
  if (contentType.startsWith('multipart/form-data')) {
    return next();
  }

  return validateCsrfToken(req, res, next);
}

function parseTrustProxySetting(rawValue, fallbackValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return fallbackValue;
  }

  const normalized = String(rawValue).trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  if (/^\d+$/.test(normalized)) {
    return parseInt(normalized, 10);
  }

  return rawValue;
}

module.exports = {
  attachCsrfToken,
  parseTrustProxySetting,
  validateCsrfToken,
  validateCsrfTokenForNonMultipart,
};