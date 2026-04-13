const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const { DB_FILE_PATH } = require('../database/db-config');

const APP_ROOT = path.join(__dirname, '..');
const UPLOADS_ROOT = path.join(APP_ROOT, 'uploads');
const APP_PACKAGE = require('../package.json');
const BACKUP_FORMAT_VERSION = 1;
const BACKUP_DB_ENTRY_PATH = 'database/paracausal.db';
const BACKUP_MANIFEST_PATH = 'manifest.json';
const BACKUP_UPLOADS_ENTRY_PATH = 'uploads';
const DEFAULT_UPLOAD_SUBDIRECTORIES = ['music', 'videos', 'images', 'projects', 'releases', 'collections', 'documents'];

function padTimestampPart(value) {
  return String(value).padStart(2, '0');
}

function formatBackupTimestamp(date = new Date()) {
  return [
    date.getFullYear(),
    padTimestampPart(date.getMonth() + 1),
    padTimestampPart(date.getDate()),
  ].join('') + '-' + [
    padTimestampPart(date.getHours()),
    padTimestampPart(date.getMinutes()),
    padTimestampPart(date.getSeconds()),
  ].join('');
}

function getBackupFilename(date = new Date()) {
  return `paracausal-backup-${formatBackupTimestamp(date)}.zip`;
}

function ensureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
}

function sqlQuote(value) {
  return String(value).replace(/'/g, "''");
}

function buildManifest(dbPath) {
  return {
    appName: 'PARACAUSAL',
    backupFormatVersion: BACKUP_FORMAT_VERSION,
    backupCreatedAt: new Date().toISOString(),
    appVersion: APP_PACKAGE.version || 'unknown',
    dbPath,
    databaseEntryPath: BACKUP_DB_ENTRY_PATH,
    uploadsEntryPath: `${BACKUP_UPLOADS_ENTRY_PATH}/`,
  };
}

async function createDatabaseSnapshot(db, targetPath, dbPath) {
  ensureDirectory(path.dirname(targetPath));

  if (db && typeof db.exec === 'function') {
    await db.exec(`VACUUM INTO '${sqlQuote(targetPath)}'`);
    return;
  }

  fs.copyFileSync(dbPath, targetPath);
}

async function createBackupArchive(options = {}) {
  const {
    db,
    dbPath = DB_FILE_PATH,
    uploadsPath = UPLOADS_ROOT,
  } = options;

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paracausal-backup-'));
  const archiveFilename = getBackupFilename();
  const archivePath = path.join(tempRoot, archiveFilename);
  const snapshotPath = path.join(tempRoot, 'snapshot', 'paracausal.db');
  const manifest = buildManifest(dbPath);

  try {
    if (!fs.existsSync(dbPath)) {
      throw new Error(`Database file not found at ${dbPath}`);
    }

    await createDatabaseSnapshot(db, snapshotPath, dbPath);

    const archive = new AdmZip();
    archive.addFile(BACKUP_MANIFEST_PATH, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
    archive.addLocalFile(snapshotPath, 'database', 'paracausal.db');

    if (fs.existsSync(uploadsPath)) {
      archive.addLocalFolder(uploadsPath, BACKUP_UPLOADS_ENTRY_PATH);
    }

    archive.writeZip(archivePath);

    return {
      archiveFilename,
      archivePath,
      manifest,
      tempRoot,
    };
  } catch (err) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    throw err;
  }
}

function loadBackupManifest(zip) {
  const manifestEntry = zip.getEntry(BACKUP_MANIFEST_PATH);
  if (!manifestEntry) {
    throw new Error('Backup manifest is missing.');
  }

  let manifest;
  try {
    manifest = JSON.parse(zip.readAsText(manifestEntry));
  } catch (err) {
    throw new Error('Backup manifest is invalid JSON.');
  }

  if (!manifest || manifest.appName !== 'PARACAUSAL') {
    throw new Error('Backup manifest does not describe a PARACAUSAL backup.');
  }

  if (manifest.backupFormatVersion !== BACKUP_FORMAT_VERSION) {
    throw new Error(`Unsupported backup format version: ${manifest.backupFormatVersion}`);
  }

  return manifest;
}

function ensureUploadDirectories(rootPath) {
  ensureDirectory(rootPath);
  DEFAULT_UPLOAD_SUBDIRECTORIES.forEach((subdirectory) => {
    ensureDirectory(path.join(rootPath, subdirectory));
  });
}

function extractBackupArchive(archivePath) {
  if (!archivePath || !fs.existsSync(archivePath)) {
    throw new Error('Backup archive not found.');
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paracausal-restore-'));
  const extractedRoot = path.join(tempRoot, 'extracted');
  ensureDirectory(extractedRoot);

  try {
    const archive = new AdmZip(archivePath);
    const manifest = loadBackupManifest(archive);
    archive.extractAllTo(extractedRoot, true);

    const databasePath = path.join(extractedRoot, BACKUP_DB_ENTRY_PATH);
    if (!fs.existsSync(databasePath)) {
      throw new Error('Backup archive does not contain the database snapshot.');
    }

    const uploadsPath = path.join(extractedRoot, BACKUP_UPLOADS_ENTRY_PATH);

    return {
      manifest,
      tempRoot,
      extractedRoot,
      databasePath,
      uploadsPath,
    };
  } catch (err) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    throw err;
  }
}

function getRollbackPath(targetPath) {
  return `${targetPath}.paracausal-restore-backup-${Date.now()}`;
}

function moveExistingPath(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return null;
  }

  const rollbackPath = getRollbackPath(targetPath);
  fs.renameSync(targetPath, rollbackPath);
  return rollbackPath;
}

function restoreMovedPath(rollbackPath, targetPath) {
  if (!rollbackPath || !fs.existsSync(rollbackPath)) {
    return;
  }

  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath, { recursive: true, force: true });
  }

  fs.renameSync(rollbackPath, targetPath);
}

function cleanupRollbackPath(rollbackPath) {
  if (!rollbackPath || !fs.existsSync(rollbackPath)) {
    return;
  }

  fs.rmSync(rollbackPath, { recursive: true, force: true });
}

function restoreBackupArchive(options = {}) {
  const {
    archivePath,
    dbPath = DB_FILE_PATH,
    uploadsPath = UPLOADS_ROOT,
  } = options;

  const extracted = extractBackupArchive(archivePath);
  const dbRollbackPath = moveExistingPath(dbPath);
  const uploadsRollbackPath = moveExistingPath(uploadsPath);

  try {
    ensureDirectory(path.dirname(dbPath));
    fs.copyFileSync(extracted.databasePath, dbPath);

    if (fs.existsSync(extracted.uploadsPath)) {
      fs.cpSync(extracted.uploadsPath, uploadsPath, { recursive: true, force: true });
    } else {
      ensureUploadDirectories(uploadsPath);
    }

    ensureUploadDirectories(uploadsPath);

    cleanupRollbackPath(dbRollbackPath);
    cleanupRollbackPath(uploadsRollbackPath);
    fs.rmSync(extracted.tempRoot, { recursive: true, force: true });

    return {
      manifest: extracted.manifest,
      dbPath,
      uploadsPath,
    };
  } catch (err) {
    restoreMovedPath(dbRollbackPath, dbPath);
    restoreMovedPath(uploadsRollbackPath, uploadsPath);
    fs.rmSync(extracted.tempRoot, { recursive: true, force: true });
    throw err;
  }
}

module.exports = {
  APP_ROOT,
  BACKUP_DB_ENTRY_PATH,
  BACKUP_MANIFEST_PATH,
  BACKUP_UPLOADS_ENTRY_PATH,
  UPLOADS_ROOT,
  createBackupArchive,
  extractBackupArchive,
  getBackupFilename,
  restoreBackupArchive,
};