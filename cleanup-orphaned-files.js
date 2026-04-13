/**
 * PARACAUSAL Orphaned Files Cleanup Utility
 * 
 * This script scans the uploads directory and removes files that are no longer
 * referenced in the database. Run this after deletions to clean up orphaned files.
 * 
 * USAGE:
 *   node cleanup-orphaned-files.js [--dry-run]
 * 
 * OPTIONS:
 *   --dry-run    Show what would be deleted without actually deleting
 */

const fs = require('fs').promises;
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { DB_FILE_PATH } = require('./database/db-config');

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

const dryRun = process.argv.includes('--dry-run');
const EXPECTED_TABLES = [
  'music',
  'videos',
  'gallery',
  'projects',
  'releases',
  'curated_collections',
  'project_documents',
  'project_update_attachments'
];

async function assertExpectedTablesExist(db, dbFilePath) {
  const placeholders = EXPECTED_TABLES.map(() => '?').join(',');
  const rows = await db.all(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`,
    ...EXPECTED_TABLES
  );
  const existing = new Set(rows.map(r => r.name));
  const missing = EXPECTED_TABLES.filter(t => !existing.has(t));

  if (missing.length > 0) {
    throw new Error(
      `Connected to wrong or empty database file: ${dbFilePath}\nMissing expected tables: ${missing.join(', ')}`
    );
  }
}

function addReferencedUploads(referencedFiles, dir, filename) {
  if (filename) {
    referencedFiles.add(`${dir}/${filename}`);
  }
}

function isLegacyArchiveVariant(fileName) {
  return typeof fileName === 'string' && fileName.toLowerCase().endsWith('.archive.webp');
}

async function main() {
  console.log(`${colors.cyan}==============================================`);
  console.log(`PARACAUSAL Orphaned Files Cleanup Utility`);
  console.log(`==============================================`);
  console.log(`Mode: ${dryRun ? colors.yellow + 'DRY RUN (no files will be deleted)' : colors.red + 'LIVE (files will be deleted)'}${colors.reset}\n`);
  console.log(`${colors.cyan}Database path: ${DB_FILE_PATH}${colors.reset}\n`);

  // Open database
  const db = await open({
    filename: DB_FILE_PATH,
    driver: sqlite3.Database
  });

  // Fail fast if this is not the real app database.
  await assertExpectedTablesExist(db, DB_FILE_PATH);

  // Collect all referenced files from database
  const referencedFiles = new Set();

  // Music files
  console.log(`${colors.blue}Scanning music table...${colors.reset}`);
  const music = await db.all('SELECT filename, cover_image FROM music');
  music.forEach(m => {
    if (m.filename) referencedFiles.add(`music/${m.filename}`);
    if (m.cover_image) addReferencedUploads(referencedFiles, 'music', m.cover_image);
  });
  console.log(`  Found ${music.length} music tracks`);

  // Video files
  console.log(`${colors.blue}Scanning videos table...${colors.reset}`);
  const videos = await db.all('SELECT filename, thumbnail FROM videos');
  videos.forEach(v => {
    if (v.filename) referencedFiles.add(`videos/${v.filename}`);
    if (v.thumbnail) referencedFiles.add(`videos/${v.thumbnail}`);
  });
  console.log(`  Found ${videos.length} videos`);

  // Gallery files
  console.log(`${colors.blue}Scanning gallery table...${colors.reset}`);
  const gallery = await db.all('SELECT filename FROM gallery');
  gallery.forEach(g => {
    if (g.filename) addReferencedUploads(referencedFiles, 'images', g.filename);
  });
  console.log(`  Found ${gallery.length} gallery images`);

  // Project hero images
  console.log(`${colors.blue}Scanning projects table...${colors.reset}`);
  const projects = await db.all('SELECT hero_image FROM projects');
  projects.forEach(p => {
    if (p.hero_image) addReferencedUploads(referencedFiles, 'projects', p.hero_image);
  });
  console.log(`  Found ${projects.length} projects`);

  // Release covers
  console.log(`${colors.blue}Scanning releases table...${colors.reset}`);
  const releases = await db.all('SELECT cover_image FROM releases');
  releases.forEach(r => {
    if (r.cover_image) addReferencedUploads(referencedFiles, 'releases', r.cover_image);
  });
  console.log(`  Found ${releases.length} releases`);

  console.log(`${colors.blue}Scanning curated_collections table...${colors.reset}`);
  const curatedCollections = await db.all('SELECT hero_image FROM curated_collections');
  curatedCollections.forEach((collection) => {
    if (collection.hero_image) addReferencedUploads(referencedFiles, 'collections', collection.hero_image);
  });
  console.log(`  Found ${curatedCollections.length} curated collections`);

  // Project documents
  console.log(`${colors.blue}Scanning project_documents table...${colors.reset}`);
  const docs = await db.all('SELECT filename FROM project_documents');
  docs.forEach(d => {
    if (d.filename) referencedFiles.add(`documents/${d.filename}`);
  });
  console.log(`  Found ${docs.length} project documents`);

  // Project update attachments
  console.log(`${colors.blue}Scanning project_update_attachments table...${colors.reset}`);
  const attachments = await db.all('SELECT filename FROM project_update_attachments');
  attachments.forEach(a => {
    if (a.filename) referencedFiles.add(`documents/${a.filename}`);
  });
  console.log(`  Found ${attachments.length} update attachments\n`);

  await db.close();

  console.log(`${colors.cyan}Total referenced files: ${referencedFiles.size}${colors.reset}\n`);

  // Scan upload directories
  const uploadDirs = ['music', 'videos', 'images', 'projects', 'documents'];
  const orphanedFiles = [];

  for (const dir of uploadDirs) {
    const dirPath = path.join(__dirname, 'uploads', dir);
    
    try {
      const files = await fs.readdir(dirPath);
      console.log(`${colors.blue}Scanning uploads/${dir}... (${files.length} files)${colors.reset}`);

      for (const file of files) {
        // Skip directories
        const filePath = path.join(dirPath, file);
        const stat = await fs.stat(filePath);
        if (stat.isDirectory()) continue;

        const relPath = `${dir}/${file}`;
        
        if (isLegacyArchiveVariant(file)) {
          orphanedFiles.push({
            dir,
            file,
            path: filePath,
            size: stat.size,
            reason: 'legacy archive variant',
          });
          continue;
        }

        if (!referencedFiles.has(relPath)) {
          orphanedFiles.push({
            dir,
            file,
            path: filePath,
            size: stat.size,
            reason: 'unreferenced upload',
          });
        }
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.log(`  ${colors.yellow}Directory not found, skipping${colors.reset}`);
      } else {
        console.error(`  ${colors.red}Error scanning directory: ${err.message}${colors.reset}`);
      }
    }
  }

  console.log();

  if (orphanedFiles.length === 0) {
    console.log(`${colors.green}✓ No orphaned files found! All uploads are referenced in the database.${colors.reset}`);
    return;
  }

  // Display orphaned files
  console.log(`${colors.yellow}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(`${colors.red}Found ${orphanedFiles.length} orphaned file(s):${colors.reset}\n`);

  const totalSize = orphanedFiles.reduce((sum, f) => sum + f.size, 0);
  const formatSize = (bytes) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return`${(bytes / 1024).toFixed(2)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  };

  orphanedFiles.forEach((f, i) => {
    console.log(`  ${i + 1}. uploads/${f.dir}/${f.file} (${formatSize(f.size)}) [${f.reason}]`);
  });

  console.log(`\n${colors.cyan}Total space occupied: ${formatSize(totalSize)}${colors.reset}\n`);

  if (dryRun) {
    console.log(`${colors.yellow}DRY RUN complete. No files were deleted.${colors.reset}`);
    console.log(`${colors.cyan}To actually delete these files, run: node cleanup-orphaned-files.js${colors.reset}`);
  } else {
    // Delete the orphaned files
    console.log(`${colors.red}Deleting orphaned files...${colors.reset}\n`);
    let deleted = 0;

    for (const f of orphanedFiles) {
      try {
        await fs.unlink(f.path);
        console.log(`  ${colors.green}✓${colors.reset} Deleted: uploads/${f.dir}/${f.file}`);
        deleted++;
      } catch (err) {
        console.log(`  ${colors.red}✗${colors.reset} Failed to delete uploads/${f.dir}/${f.file}: ${err.message}`);
      }
    }

    console.log(`\n${colors.green}✓ Cleanup complete! Deleted ${deleted} of ${orphanedFiles.length} orphaned files.${colors.reset}`);
    console.log(`${colors.cyan}Freed ${formatSize(totalSize)} of disk space.${colors.reset}`);
  }
}

main().catch(err => {
  console.error(`${colors.red}Fatal error: ${err.message}${colors.reset}`);
  process.exit(1);
});
