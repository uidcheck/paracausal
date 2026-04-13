require('dotenv').config();
const path = require('path');
const { DB_FILE_PATH } = require('./database/db-config');
const { UPLOADS_ROOT, restoreBackupArchive } = require('./utils/backup');

function printUsage() {
  console.log('Usage: node restore-backup.js <backup.zip> --yes [--db-path=/custom/db.sqlite] [--uploads-path=/custom/uploads]');
  console.log('');
  console.log('This overwrites the configured SQLite database and uploads directory.');
  console.log('Stop PARACAUSAL before running the restore.');
}

function main() {
  const args = process.argv.slice(2);
  const archiveArg = args.find((arg) => !arg.startsWith('--'));
  const confirmed = args.includes('--yes');
  const dbPathOverride = args.find((arg) => arg.startsWith('--db-path='));
  const uploadsPathOverride = args.find((arg) => arg.startsWith('--uploads-path='));

  if (!archiveArg || !confirmed) {
    printUsage();
    process.exit(1);
  }

  const archivePath = path.resolve(process.cwd(), archiveArg);

  try {
    const result = restoreBackupArchive({
      archivePath,
      dbPath: dbPathOverride ? path.resolve(process.cwd(), dbPathOverride.slice('--db-path='.length)) : DB_FILE_PATH,
      uploadsPath: uploadsPathOverride ? path.resolve(process.cwd(), uploadsPathOverride.slice('--uploads-path='.length)) : UPLOADS_ROOT,
    });

    console.log(`Restore completed from ${archivePath}`);
    console.log(`Database restored to ${result.dbPath}`);
    console.log(`Uploads restored to ${result.uploadsPath}`);
    console.log(`Backup timestamp: ${result.manifest.backupCreatedAt}`);
  } catch (err) {
    console.error(`Restore failed: ${err.message || err}`);
    process.exit(1);
  }
}

main();