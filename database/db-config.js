const fs = require('fs');
const path = require('path');

// Default local database path when DB_PATH is not explicitly configured.
const DEFAULT_DB_FILE_PATH = path.join(__dirname, 'paracausal.db');

function resolveDbFilePath() {
  const configuredPath = process.env.DB_PATH;
  if (!configuredPath || configuredPath.trim() === '') {
    return DEFAULT_DB_FILE_PATH;
  }

  if (path.isAbsolute(configuredPath)) {
    return configuredPath;
  }

  return path.resolve(process.cwd(), configuredPath);
}

const DB_FILE_PATH = resolveDbFilePath();

function ensureDbDirectoryExists() {
  const dbDirectory = path.dirname(DB_FILE_PATH);
  fs.mkdirSync(dbDirectory, { recursive: true });
}

module.exports = {
  DB_FILE_PATH,
  DEFAULT_DB_FILE_PATH,
  ensureDbDirectoryExists
};
