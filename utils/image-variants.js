const fs = require('fs');
const path = require('path');

const uploadsRoot = path.join(__dirname, '..', 'uploads');

function getUploadFilePath(subdir, filename) {
  if (!filename) return '';
  return path.join(uploadsRoot, subdir, filename);
}

function getPublicUploadUrl(subdir, filename) {
  return filename ? `/uploads/${subdir}/${filename}` : '';
}

function getOriginalImageUrl(subdir, filename) {
  if (!filename) return '';

  const sourcePath = getUploadFilePath(subdir, filename);
  if (sourcePath && fs.existsSync(sourcePath)) {
    return getPublicUploadUrl(subdir, filename);
  }

  return '';
}

module.exports = {
  getOriginalImageUrl,
  getPublicUploadUrl,
  getUploadFilePath,
};