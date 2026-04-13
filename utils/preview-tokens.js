const crypto = require('crypto');

function generatePreviewToken() {
  return crypto.randomBytes(18).toString('hex');
}

module.exports = {
  generatePreviewToken,
};