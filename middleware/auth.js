module.exports.ensureAdmin = (req, res, next) => {
  if (req.adminSetupRequired) {
    req.flash('error', 'Complete the one-time setup to create the first admin account.');
    return res.redirect('/setup');
  }

  if (req.session && req.session.admin) {
    return next();
  }
  req.flash('error', 'Please log in to access that page.');
  res.redirect('/login');
};

module.exports.preventLogin = (req, res, next) => {
  if (req.session && req.session.pendingTwoFactorAuth) {
    return res.redirect('/login/2fa');
  }

  if (req.adminSetupRequired) {
    return res.redirect('/setup');
  }

  if (req.session && req.session.admin) {
    return res.redirect('/admin');
  }
  next();
};

module.exports.preventSetupWhenAdminExists = (req, res, next) => {
  if (!req.adminExists) {
    return next();
  }

  if (typeof req.flash === 'function') {
    req.flash('error', 'Initial setup has already been completed.');
  }

  return res.redirect(req.session && req.session.admin ? '/admin' : '/login');
};