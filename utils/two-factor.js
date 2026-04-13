const crypto = require('crypto');
const QRCode = require('qrcode');
const { generateSecret, generateURI, verifySync } = require('otplib');

const RECOVERY_CODE_COUNT = 8;
const TWO_FACTOR_SESSION_KEY = 'pendingTwoFactorAuth';
const TWO_FACTOR_SETUP_SESSION_KEY = 'pendingTwoFactorSetup';
const TOTP_PERIOD_SECONDS = 30;
const TOTP_EPOCH_TOLERANCE = [TOTP_PERIOD_SECONDS, TOTP_PERIOD_SECONDS];

function normalizeRecoveryCode(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function formatRecoveryCode(value) {
  const normalizedValue = normalizeRecoveryCode(value);
  if (!normalizedValue) {
    return '';
  }

  return normalizedValue.match(/.{1,4}/g).join('-');
}

function hashRecoveryCode(value) {
  return crypto
    .createHash('sha256')
    .update(normalizeRecoveryCode(value), 'utf8')
    .digest('hex');
}

function generateRecoveryCodes(count = RECOVERY_CODE_COUNT) {
  const recoveryCodes = [];
  while (recoveryCodes.length < count) {
    const rawCode = crypto.randomBytes(4).toString('hex').toUpperCase();
    const formattedCode = formatRecoveryCode(rawCode);
    if (!recoveryCodes.includes(formattedCode)) {
      recoveryCodes.push(formattedCode);
    }
  }

  return recoveryCodes;
}

function hashRecoveryCodes(codes) {
  if (!Array.isArray(codes)) {
    return [];
  }

  return codes.map((code) => hashRecoveryCode(code));
}

function parseStoredRecoveryCodeHashes(value) {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string' && entry) : [];
  } catch (err) {
    return [];
  }
}

function serializeRecoveryCodeHashes(values) {
  return JSON.stringify(Array.isArray(values) ? values : []);
}

function generateTwoFactorSecret() {
  return generateSecret();
}

function getTwoFactorOtpAuthUrl(username, secret) {
  return generateURI({
    issuer: 'PARACAUSAL',
    label: username || 'admin',
    secret,
  });
}

async function buildTwoFactorSetup(username) {
  const secret = generateTwoFactorSecret();
  const recoveryCodes = generateRecoveryCodes();
  const otpAuthUrl = getTwoFactorOtpAuthUrl(username, secret);
  const qrCodeDataUrl = await QRCode.toDataURL(otpAuthUrl, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 220,
  });

  return {
    secret,
    recoveryCodes,
    otpAuthUrl,
    qrCodeDataUrl,
  };
}

function normalizeTotpToken(value) {
  return String(value || '').trim().replace(/\s+/g, '');
}

function verifyTotpToken(secret, token) {
  if (!secret) {
    return false;
  }

  try {
    const result = verifySync({
      secret,
      token: normalizeTotpToken(token),
      epochTolerance: TOTP_EPOCH_TOLERANCE,
    });

    return !!(result && result.valid);
  } catch (err) {
    return false;
  }
}

function verifyRecoveryCode(rawCode, storedHashes) {
  const normalizedCode = normalizeRecoveryCode(rawCode);
  if (!normalizedCode) {
    return {
      valid: false,
      remainingHashes: Array.isArray(storedHashes) ? storedHashes : [],
    };
  }

  const hashedCode = hashRecoveryCode(normalizedCode);
  const remainingHashes = Array.isArray(storedHashes) ? [...storedHashes] : [];
  const matchedIndex = remainingHashes.findIndex((entry) => entry === hashedCode);
  if (matchedIndex === -1) {
    return {
      valid: false,
      remainingHashes,
    };
  }

  remainingHashes.splice(matchedIndex, 1);
  return {
    valid: true,
    remainingHashes,
  };
}

function isTwoFactorEnabled(admin) {
  return !!(admin && Number(admin.two_factor_enabled) === 1 && admin.two_factor_secret);
}

function clearPendingTwoFactorAuth(session) {
  if (session && session[TWO_FACTOR_SESSION_KEY]) {
    delete session[TWO_FACTOR_SESSION_KEY];
  }
}

function clearPendingTwoFactorSetup(session) {
  if (session && session[TWO_FACTOR_SETUP_SESSION_KEY]) {
    delete session[TWO_FACTOR_SETUP_SESSION_KEY];
  }
}

module.exports = {
  TWO_FACTOR_SESSION_KEY,
  TWO_FACTOR_SETUP_SESSION_KEY,
  buildTwoFactorSetup,
  clearPendingTwoFactorAuth,
  clearPendingTwoFactorSetup,
  formatRecoveryCode,
  getTwoFactorOtpAuthUrl,
  hashRecoveryCodes,
  isTwoFactorEnabled,
  normalizeRecoveryCode,
  parseStoredRecoveryCodeHashes,
  serializeRecoveryCodeHashes,
  verifyRecoveryCode,
  verifyTotpToken,
};