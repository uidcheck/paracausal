const { createAsyncRouter } = require('../middleware/async-router');
const bcrypt = require('bcrypt');

const { preventLogin, preventSetupWhenAdminExists } = require('../middleware/auth');
const {
  createInitialAdmin,
  normalizeUsername,
  validateInitialAdminInput,
} = require('../utils/admin-setup');
const { createLoginRateLimiter } = require('../utils/login-rate-limiter');
const {
  TWO_FACTOR_SESSION_KEY,
  clearPendingTwoFactorAuth,
  isTwoFactorEnabled,
  normalizeRecoveryCode,
  parseStoredRecoveryCodeHashes,
  serializeRecoveryCodeHashes,
  verifyRecoveryCode,
  verifyTotpToken,
} = require('../utils/two-factor');

const router = createAsyncRouter();
const loginRateLimiter = createLoginRateLimiter({
  windowMinutes: process.env.LOGIN_RATE_LIMIT_WINDOW_MINUTES,
  maxAttempts: process.env.LOGIN_RATE_LIMIT_MAX_ATTEMPTS,
});

function startAdminSession(req, res, admin, failureRedirectPath, successMessage) {
  return req.session.regenerate((err) => {
    if (err) {
      console.error('Session regeneration failed during authentication:', err);
      req.flash('error', 'Unable to start a secure session. Please try again.');
      return res.redirect(failureRedirectPath);
    }

    req.session.admin = { id: admin.id, username: admin.username };
    req.session.flash = { success: successMessage };
    return res.redirect('/admin');
  });
}

router.get('/setup', preventSetupWhenAdminExists, (req, res) => {
  res.render('admin/setup', {
    formData: {
      username: '',
    },
    hidePlayer: true,
  });
});

router.post('/setup', preventSetupWhenAdminExists, async (req, res) => {
  const db = req.app.locals.db;
  const username = normalizeUsername(req.body.username);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const confirmPassword = typeof req.body.confirmPassword === 'string' ? req.body.confirmPassword : '';
  const validationError = validateInitialAdminInput({ username, password, confirmPassword });

  if (validationError) {
    return res.status(400).render('admin/setup', {
      error: validationError,
      formData: { username },
      hidePlayer: true,
    });
  }

  try {
    const admin = await createInitialAdmin(db, { username, password });
    return startAdminSession(req, res, admin, '/setup', 'Initial admin account created successfully.');
  } catch (err) {
    if (err && err.code === 'SQLITE_CONSTRAINT') {
      req.flash('error', 'Initial setup has already been completed. Please log in.');
      return res.redirect('/login');
    }

    throw err;
  }
});

router.get('/login', preventLogin, (req, res) => {
  res.render('admin/login');
});

router.post('/login', loginRateLimiter.middleware, async (req, res) => {
  if (req.adminSetupRequired) {
    req.flash('error', 'Complete the one-time setup to create the first admin account.');
    return res.redirect('/setup');
  }

  const db = req.app.locals.db;
  const { username, password } = req.body;
  const admin = await db.get('SELECT * FROM admins WHERE username = ?', username);
  if (admin && await bcrypt.compare(password, admin.password)) {
    if (isTwoFactorEnabled(admin)) {
      req.session[TWO_FACTOR_SESSION_KEY] = {
        adminId: admin.id,
        username: admin.username,
      };
      req.flash('success', 'Password accepted. Enter your authenticator code or a recovery code to finish logging in.');
      return res.redirect('/login/2fa');
    }

    loginRateLimiter.reset(req);
    return startAdminSession(req, res, admin, '/login', 'Logged in successfully');
  }
  loginRateLimiter.recordFailure(req);
  req.flash('error', 'Invalid credentials');
  res.redirect('/login');
});

router.get('/login/2fa', (req, res) => {
  if (req.adminSetupRequired) {
    req.flash('error', 'Complete the one-time setup to create the first admin account.');
    return res.redirect('/setup');
  }

  if (req.session && req.session.admin) {
    return res.redirect('/admin');
  }

  const pendingAuth = req.session && req.session[TWO_FACTOR_SESSION_KEY];
  if (!pendingAuth || !pendingAuth.adminId) {
    req.flash('error', 'Start by entering your username and password.');
    return res.redirect('/login');
  }

  return res.render('admin/login-2fa', {
    username: pendingAuth.username,
  });
});

router.post('/login/2fa', loginRateLimiter.middleware, async (req, res) => {
  const pendingAuth = req.session && req.session[TWO_FACTOR_SESSION_KEY];
  if (!pendingAuth || !pendingAuth.adminId) {
    req.flash('error', 'Start by entering your username and password.');
    return res.redirect('/login');
  }

  const db = req.app.locals.db;
  const admin = await db.get('SELECT * FROM admins WHERE id = ?', pendingAuth.adminId);
  if (!admin || !isTwoFactorEnabled(admin)) {
    clearPendingTwoFactorAuth(req.session);
    req.flash('error', 'Two-factor verification is no longer available for this account. Please log in again.');
    return res.redirect('/login');
  }

  const verificationCode = typeof req.body.code === 'string' ? req.body.code : '';
  let verified = verifyTotpToken(admin.two_factor_secret, verificationCode);

  if (!verified) {
    const recoveryCodeResult = verifyRecoveryCode(verificationCode, parseStoredRecoveryCodeHashes(admin.two_factor_recovery_codes));
    if (recoveryCodeResult.valid) {
      verified = true;
      await db.run(
        'UPDATE admins SET two_factor_recovery_codes = ? WHERE id = ?',
        serializeRecoveryCodeHashes(recoveryCodeResult.remainingHashes),
        admin.id
      );
    }
  }

  if (!verified) {
    loginRateLimiter.recordFailure(req);
    req.flash('error', 'Invalid authenticator or recovery code.');
    return res.redirect('/login/2fa');
  }

  clearPendingTwoFactorAuth(req.session);
  loginRateLimiter.reset(req);
  return startAdminSession(req, res, admin, '/login', 'Logged in successfully');
});

router.post('/logout', (req, res) => {
  clearPendingTwoFactorAuth(req.session);
  req.session.destroy();
  res.redirect('/');
});

module.exports = router;