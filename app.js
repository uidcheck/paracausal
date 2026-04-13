require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const path = require('path');
const methodOverride = require('method-override');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');
const { DB_FILE_PATH, ensureDbDirectoryExists } = require('./database/db-config');
const SqliteSessionStore = require('./database/sqlite-session-store');
const {
  attachCsrfToken,
  parseTrustProxySetting,
  validateCsrfTokenForNonMultipart,
} = require('./middleware/security');
const { getOriginalImageUrl } = require('./utils/image-variants');
const { bootstrapInitialAdminFromEnv, getAdminCount, hasAnyAdmin } = require('./utils/admin-setup');
const { pruneOldAnalyticsEvents } = require('./utils/analytics');
const {
  ALL_PUBLICATION_STATUSES,
  formatPublicationStatusLabel,
  toDateTimeLocalValue,
} = require('./utils/content-publication-status');
const {
  CLOSED_PROJECT_STATUS,
  ONGOING_PROJECT_STATUS,
} = require('./utils/project-status');
const { generateUniqueSlug } = require('./utils/slugs');
const { ensureTagTablesReady } = require('./utils/tags');

ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobeStatic.path);

const authRoutes = require('./routes/auth');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');

const { ensureAdmin } = require('./middleware/auth');

const STYLE_CSS_PATH = path.join(__dirname, 'public', 'css', 'style.css');
const STYLE_CSS_VERSION = (() => {
  try {
    return String(Math.floor(fs.statSync(STYLE_CSS_PATH).mtimeMs));
  } catch (err) {
    return String(Date.now());
  }
})();

function requestExpectsJson(req) {
  const requestedWith = (req.get('X-Requested-With') || '').toLowerCase();
  const accept = (req.get('Accept') || '').toLowerCase();

  return requestedWith === 'xmlhttprequest' || accept.includes('application/json');
}

function isAdminRequest(req) {
  return req.path === '/admin' || req.path.startsWith('/admin/');
}

function isAuthRequest(req) {
  return req.path === '/login' || req.path === '/logout' || req.path === '/setup';
}

function getErrorStatusCode(err) {
  if (Number.isInteger(err && err.statusCode)) return err.statusCode;
  if (Number.isInteger(err && err.status)) return err.status;
  if (err && err.name === 'MulterError') return 400;
  return 500;
}

function getUserFacingErrorMessage(err, statusCode) {
  if (statusCode >= 500) {
    return 'An unexpected error occurred. Please try again.';
  }

  return (err && err.message) || 'The request could not be completed.';
}

async function ensurePublicationStatusColumns(db) {
  const contentTables = ['music', 'videos', 'gallery', 'projects', 'releases', 'curated_collections'];

  for (const tableName of contentTables) {
    try {
      await db.exec(`ALTER TABLE ${tableName} ADD COLUMN publication_status TEXT NOT NULL DEFAULT 'published'`);
    } catch (err) {
      if (!/duplicate column name|no such table/i.test(err.message)) {
        throw err;
      }
    }

    try {
      await db.exec(`ALTER TABLE ${tableName} ADD COLUMN published_at DATETIME`);
    } catch (err) {
      if (!/duplicate column name|no such table/i.test(err.message)) {
        throw err;
      }
    }

    const tableExists = await db.get(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table'
         AND name = ?`,
      tableName
    );
    if (!tableExists) {
      continue;
    }

    await db.exec(
      `UPDATE ${tableName}
       SET publication_status = LOWER(TRIM(COALESCE(publication_status, 'published')))`
    );
    await db.exec(
      `UPDATE ${tableName}
       SET publication_status = 'unlisted'
       WHERE publication_status = 'archived'`
    );
    await db.exec(
      `UPDATE ${tableName}
       SET publication_status = 'published'
       WHERE publication_status NOT IN (${ALL_PUBLICATION_STATUSES.map((status) => `'${status}'`).join(', ')})`
    );
    await db.exec(
      `UPDATE ${tableName}
       SET published_at = NULL
       WHERE published_at IS NOT NULL
         AND TRIM(COALESCE(published_at, '')) = ''`
    );
    await db.exec(
      `CREATE INDEX IF NOT EXISTS idx_${tableName}_publication_status
       ON ${tableName}(publication_status)`
    );
    await db.exec(
      `CREATE INDEX IF NOT EXISTS idx_${tableName}_published_at
       ON ${tableName}(published_at)`
    );
  }
}

async function ensureColumnExists(db, tableName, columnName, definition) {
  try {
    await db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  } catch (err) {
    if (!/duplicate column name|no such table/i.test(err.message)) {
      throw err;
    }
  }
}

async function ensurePreviewTokenColumns(db) {
  const previewTables = ['music', 'videos', 'gallery', 'projects', 'releases', 'curated_collections'];

  for (const tableName of previewTables) {
    await ensureColumnExists(db, tableName, 'preview_token', 'TEXT');

    const tableExists = await db.get(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
      tableName
    );
    if (!tableExists) {
      continue;
    }

    await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${tableName}_preview_token ON ${tableName}(preview_token)`);
  }
}

async function ensurePhaseTwoColumns(db) {
  await ensureColumnExists(db, 'projects', 'tools_used', 'TEXT');
  await ensureColumnExists(db, 'projects', 'stack_used', 'TEXT');
  await ensureColumnExists(db, 'projects', 'started_on', 'DATE');
  await ensureColumnExists(db, 'projects', 'completed_on', 'DATE');
  await ensureColumnExists(db, 'projects', 'accent_colour', 'TEXT');
  await ensureColumnExists(db, 'projects', 'visual_style', "TEXT NOT NULL DEFAULT 'default'");

  await ensureColumnExists(db, 'releases', 'accent_colour', 'TEXT');
  await ensureColumnExists(db, 'releases', 'visual_style', "TEXT NOT NULL DEFAULT 'default'");

  await ensureColumnExists(db, 'project_updates', 'title', 'TEXT');
  await ensureColumnExists(db, 'project_updates', 'update_kind', "TEXT NOT NULL DEFAULT 'note'");
  await ensureColumnExists(db, 'project_updates', 'is_pinned', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumnExists(db, 'project_updates', 'image_filename', 'TEXT');
  await ensureColumnExists(db, 'project_updates', 'linked_video_id', 'INTEGER');
}

async function ensureHomepageSectionColumns(db) {
  const homepageSectionsTable = await db.get(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'homepage_sections'`
  );
  if (!homepageSectionsTable) {
    return;
  }

  await ensureColumnExists(db, 'homepage_sections', 'title_override', 'TEXT');
  await ensureColumnExists(db, 'homepage_sections', 'body_text', 'TEXT');
  await ensureColumnExists(db, 'homepage_sections', 'item_limit', 'INTEGER NOT NULL DEFAULT 6');
  await ensureColumnExists(db, 'homepage_sections', 'enabled', 'INTEGER NOT NULL DEFAULT 1');
  await ensureColumnExists(db, 'homepage_sections', 'linked_release_id', 'INTEGER');
  await ensureColumnExists(db, 'homepage_sections', 'linked_track_id', 'INTEGER');
  await ensureColumnExists(db, 'homepage_sections', 'linked_video_id', 'INTEGER');
  await ensureColumnExists(db, 'homepage_sections', 'linked_gallery_id', 'INTEGER');
  await ensureColumnExists(db, 'homepage_sections', 'linked_collection_id', 'INTEGER');
  await ensureColumnExists(db, 'homepage_sections', 'source_group', 'TEXT');
  await ensureColumnExists(db, 'homepage_sections', 'filter_tag', 'TEXT');
  await ensureColumnExists(db, 'homepage_sections', 'accent_colour', 'TEXT');
  await ensureColumnExists(db, 'homepage_sections', 'style_mode', "TEXT NOT NULL DEFAULT 'default'");

  await db.exec(
    `UPDATE homepage_sections
     SET enabled = CASE
       WHEN COALESCE(enabled, 0) IN (0, 1) THEN COALESCE(enabled, 1)
       ELSE 1
     END`
  );
  await db.exec(
    `UPDATE homepage_sections
     SET item_limit = CASE
       WHEN item_limit IS NULL OR item_limit < 1 THEN 6
       WHEN item_limit > 24 THEN 24
       ELSE item_limit
     END`
  );
  await db.exec(
    `UPDATE homepage_sections
     SET style_mode = 'default'
     WHERE TRIM(COALESCE(style_mode, '')) = ''`
  );
  await db.exec('CREATE INDEX IF NOT EXISTS idx_homepage_sections_enabled ON homepage_sections(enabled)');
}

async function ensureAnalyticsColumns(db) {
  const analyticsTable = await db.get(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'analytics_page_views'`
  );
  if (!analyticsTable) {
    return;
  }

  await ensureColumnExists(db, 'analytics_page_views', 'content_type', 'TEXT');
  await ensureColumnExists(db, 'analytics_page_views', 'content_id', 'INTEGER');
  await ensureColumnExists(db, 'analytics_page_views', 'content_slug', 'TEXT');
  await ensureColumnExists(db, 'analytics_page_views', 'referrer_host', 'TEXT');
  await ensureColumnExists(db, 'analytics_page_views', 'viewed_at', 'DATETIME');

  await db.exec(
    `UPDATE analytics_page_views
     SET viewed_at = CURRENT_TIMESTAMP
     WHERE viewed_at IS NULL OR TRIM(COALESCE(viewed_at, '')) = ''`
  );

  await db.exec('CREATE INDEX IF NOT EXISTS idx_analytics_page_views_viewed_at ON analytics_page_views(viewed_at)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_analytics_page_views_request_path ON analytics_page_views(request_path)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_analytics_page_views_page_type ON analytics_page_views(page_type)');
  await db.exec(
    'CREATE INDEX IF NOT EXISTS idx_analytics_page_views_content ON analytics_page_views(content_type, content_id, content_slug)'
  );
}

async function ensureProjectStatusColumn(db) {
  try {
    await db.exec(`ALTER TABLE projects ADD COLUMN project_status TEXT NOT NULL DEFAULT '${ONGOING_PROJECT_STATUS}'`);
  } catch (err) {
    if (!/duplicate column name/i.test(err.message)) {
      throw err;
    }
  }

  const projectColumns = await db.all('PRAGMA table_info(projects)');
  const hasLegacyStatusColumn = projectColumns.some((column) => column && column.name === 'status');

  if (hasLegacyStatusColumn) {
    await db.exec(
      `UPDATE projects
       SET project_status = CASE
         WHEN TRIM(COALESCE(project_status, '')) = '' THEN CASE
           WHEN LOWER(TRIM(COALESCE(status, ''))) IN ('${ONGOING_PROJECT_STATUS}', '${CLOSED_PROJECT_STATUS}')
             THEN LOWER(TRIM(status))
           ELSE '${ONGOING_PROJECT_STATUS}'
         END
         ELSE LOWER(TRIM(project_status))
       END`
    );
  } else {
    await db.exec(
      `UPDATE projects
       SET project_status = LOWER(TRIM(COALESCE(project_status, '${ONGOING_PROJECT_STATUS}')))`
    );
  }

  await db.exec(
    `UPDATE projects
     SET project_status = '${ONGOING_PROJECT_STATUS}'
     WHERE project_status NOT IN ('${ONGOING_PROJECT_STATUS}', '${CLOSED_PROJECT_STATUS}')`
  );
  await db.exec(
    'CREATE INDEX IF NOT EXISTS idx_projects_project_status ON projects(project_status)'
  );
}

async function ensureTwoFactorColumns(db) {
  const adminColumns = [
    {
      name: 'two_factor_secret',
      definition: 'TEXT',
    },
    {
      name: 'two_factor_enabled',
      definition: 'INTEGER NOT NULL DEFAULT 0',
    },
    {
      name: 'two_factor_recovery_codes',
      definition: 'TEXT',
    },
  ];

  for (const column of adminColumns) {
    try {
      await db.exec(`ALTER TABLE admins ADD COLUMN ${column.name} ${column.definition}`);
    } catch (err) {
      if (!/duplicate column name/i.test(err.message)) {
        throw err;
      }
    }
  }

  await db.exec(`
    UPDATE admins
    SET two_factor_enabled = CASE
      WHEN two_factor_secret IS NOT NULL AND TRIM(two_factor_secret) != '' THEN 1
      ELSE 0
    END
    WHERE COALESCE(two_factor_enabled, 0) NOT IN (0, 1)
       OR (COALESCE(two_factor_enabled, 0) = 1 AND (two_factor_secret IS NULL OR TRIM(two_factor_secret) = ''))
  `);
}

async function ensureSortOrderColumns(db) {
  const contentTables = [
    {
      tableName: 'music',
      backfillOrderBy: `CASE WHEN order_index IS NULL THEN 0 ELSE 1 END,
        order_index,
        id`,
    },
    {
      tableName: 'videos',
      backfillOrderBy: 'created_at DESC, id DESC',
    },
    {
      tableName: 'gallery',
      backfillOrderBy: 'created_at DESC, id DESC',
    },
    {
      tableName: 'projects',
      backfillOrderBy: 'created_at DESC, id DESC',
    },
    {
      tableName: 'releases',
      backfillOrderBy: 'COALESCE(release_date, created_at) DESC, id DESC',
    },
    {
      tableName: 'curated_collections',
      backfillOrderBy: 'created_at DESC, id DESC',
    },
    {
      tableName: 'homepage_sections',
      backfillOrderBy: 'created_at ASC, id ASC',
    },
  ];

  for (const config of contentTables) {
    let addedColumn = false;

    try {
      await db.exec(`ALTER TABLE ${config.tableName} ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`);
      addedColumn = true;
    } catch (err) {
      if (!/duplicate column name/i.test(err.message)) {
        throw err;
      }
    }

    if (addedColumn) {
      const rows = await db.all(`SELECT id FROM ${config.tableName} ORDER BY ${config.backfillOrderBy}`);

      await db.exec('BEGIN TRANSACTION');
      try {
        for (let index = 0; index < rows.length; index += 1) {
          await db.run(
            `UPDATE ${config.tableName} SET sort_order = ? WHERE id = ?`,
            index + 1,
            rows[index].id
          );
        }
        await db.exec('COMMIT');
      } catch (txErr) {
        await db.exec('ROLLBACK');
        throw txErr;
      }
    }

    await db.exec(`CREATE INDEX IF NOT EXISTS idx_${config.tableName}_sort_order ON ${config.tableName}(sort_order)`);
  }
}

async function ensureContentSlugColumns(db) {
  const slugTables = [
    {
      tableName: 'music',
      fallbackPrefix: 'track',
      allowNumericOnly: false,
      addColumn: true,
      createUniqueIndex: true,
    },
    {
      tableName: 'music_playlists',
      fallbackPrefix: 'playlist',
      allowNumericOnly: false,
      addColumn: true,
      createUniqueIndex: true,
    },
    {
      tableName: 'videos',
      fallbackPrefix: 'video',
      allowNumericOnly: false,
      addColumn: true,
      createUniqueIndex: true,
    },
    {
      tableName: 'gallery',
      fallbackPrefix: 'image',
      allowNumericOnly: false,
      addColumn: true,
      createUniqueIndex: true,
    },
    {
      tableName: 'projects',
      fallbackPrefix: 'project',
      allowNumericOnly: true,
      addColumn: false,
      createUniqueIndex: false,
    },
    {
      tableName: 'releases',
      fallbackPrefix: 'release',
      allowNumericOnly: false,
      addColumn: false,
      createUniqueIndex: false,
    },
    {
      tableName: 'curated_collections',
      fallbackPrefix: 'collection',
      allowNumericOnly: false,
      addColumn: false,
      createUniqueIndex: false,
    },
  ];

  for (const config of slugTables) {
    if (config.addColumn) {
      try {
        await db.exec(`ALTER TABLE ${config.tableName} ADD COLUMN slug TEXT`);
      } catch (err) {
        if (!/duplicate column name/i.test(err.message)) {
          throw err;
        }
      }
    }

    const rows = await db.all(
      `SELECT id, title, slug
       FROM ${config.tableName}
       WHERE slug IS NULL OR TRIM(slug) = ''
       ORDER BY id ASC`
    );

    for (const row of rows) {
      const slug = await generateUniqueSlug(db, {
        tableName: config.tableName,
        title: row.title,
        fallbackPrefix: config.fallbackPrefix,
        allowNumericOnly: config.allowNumericOnly,
        ignoreId: row.id,
        idForFallback: row.id,
      });

      await db.run(`UPDATE ${config.tableName} SET slug = ? WHERE id = ?`, slug, row.id);
    }

    if (config.createUniqueIndex) {
      await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${config.tableName}_slug_unique ON ${config.tableName}(slug)`);
    }
  }
}

function normalizeSchemaStatement(statement) {
  return statement.replace(/^\s*--.*$/gm, '').trim();
}

async function applySchemaWithCompatibility(db, schema) {
  try {
    await db.exec(schema);
    return;
  } catch (err) {
    if (!/no such (column|table):/i.test(err.message)) {
      throw err;
    }
  }

  const statements = schema
    .split(/;\s*(?:\r?\n|$)/)
    .map(normalizeSchemaStatement)
    .filter(Boolean);

  for (const statement of statements) {
    try {
      await db.exec(statement);
    } catch (err) {
      const isCreateIndexStatement = /^CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(statement);
      if (isCreateIndexStatement && /no such (column|table):/i.test(err.message)) {
        continue;
      }

      throw err;
    }
  }
}

(async () => {
  ensureDbDirectoryExists();
  console.log(`Using SQLite database at: ${DB_FILE_PATH}`);

  const db = await open({
    filename: DB_FILE_PATH,
    driver: sqlite3.Database
  });

  // Enable foreign key constraints
  await db.exec('PRAGMA foreign_keys = ON;');

  // Run schema to ensure all tables exist
  const schemaPath = path.join(__dirname, 'database', 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  await applySchemaWithCompatibility(db, schema);
  await ensureAnalyticsColumns(db);
  await pruneOldAnalyticsEvents(db, process.env.ANALYTICS_RETENTION_DAYS);
  await ensureTwoFactorColumns(db);
  await ensurePublicationStatusColumns(db);
  await ensurePreviewTokenColumns(db);
  await ensurePhaseTwoColumns(db);
  await ensureHomepageSectionColumns(db);
  await ensureProjectStatusColumn(db);
  await ensureSortOrderColumns(db);
  await ensureContentSlugColumns(db);
  await ensureTagTablesReady(db);

  // Safety indexes for existing databases (no DB reset required)
  await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_music_playlist_items_unique ON music_playlist_items(playlist_id, music_id)').catch(() => {});
  await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_video_playlist_items_unique ON video_playlist_items(playlist_id, video_id)').catch(() => {});
  await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_gallery_collection_items_unique ON gallery_collection_items(collection_id, gallery_id)').catch(() => {});
  await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_project_collection_items_unique ON project_collection_items(collection_id, project_id)').catch(() => {});
  await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_project_collection_items_project_collection ON project_collection_items(project_id, collection_id)').catch(() => {});

  // Generate missing video thumbnails
  const videosWithoutThumbs = await db.all('SELECT * FROM videos WHERE thumbnail IS NULL AND filename IS NOT NULL');
  for (const video of videosWithoutThumbs) {
    try {
      const videoPath = path.join(__dirname, 'uploads', 'videos', video.filename);
      const thumbFilename = Date.now() + '_' + video.id + '.jpg';
      const thumbnailPath = path.join(__dirname, 'uploads', 'videos', thumbFilename);
      await new Promise((resolve, reject) => {
        ffmpeg(videoPath)
          .on('error', reject)
          .screenshot({
            timestamps: ['1%'],
            filename: path.basename(thumbnailPath),
            folder: path.dirname(thumbnailPath),
            size: '320x240'
          })
          .on('end', () => resolve());
      });
      await db.run('UPDATE videos SET thumbnail = ? WHERE id = ?', thumbFilename, video.id);
      console.log(`Generated thumbnail for video ${video.id}`);
    } catch (err) {
      console.error(`Failed to generate thumbnail for video ${video.id}:`, err);
    }
  }

  // ============================================================================
  // Bootstrap initial admin account if requested
  // ============================================================================
  try {
    const adminCount = await getAdminCount(db);
    if (adminCount === 0) {
      const bootstrapResult = await bootstrapInitialAdminFromEnv(db, process.env, console);
      if (!bootstrapResult.created) {
        console.log('⚠️  No admin account exists yet. Complete the one-time setup at /setup.');
      }
    } else {
      console.log(`✓ Admin account check passed (${adminCount} admin(s) exist)`);
    }
  } catch (err) {
    console.error('Failed to initialize admin setup state:', err);
    // This is not a fatal error - continue startup
  }

  // make db available via app.locals
  const app = express();
  const isProduction = process.env.NODE_ENV === 'production';
  const trustProxySetting = parseTrustProxySetting(process.env.TRUST_PROXY, isProduction ? 1 : false);
  const sessionSecret = process.env.SESSION_SECRET;

  app.locals.db = db;
  app.locals.formatPublicationStatusLabel = formatPublicationStatusLabel;
  app.locals.getOriginalImageUrl = getOriginalImageUrl;
  app.locals.toDateTimeLocalValue = toDateTimeLocalValue;
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxySetting);

  if (!sessionSecret && isProduction) {
    throw new Error('SESSION_SECRET must be set when NODE_ENV=production.');
  }

  if (!sessionSecret) {
    console.warn('SESSION_SECRET is not set. Using a temporary fallback secret for local development only.');
  }

  // view engine
  app.set('views', path.join(__dirname, 'views'));
  app.set('view engine', 'ejs');

  // static
  app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
      const ext = path.extname(filePath).toLowerCase();

      if (['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.svg', '.ico'].includes(ext)) {
        res.setHeader('Cache-Control', 'public, max-age=2592000');
        return;
      }

      if (['.css', '.js'].includes(ext)) {
        res.setHeader('Cache-Control', 'public, max-age=604800');
      }
    },
  }));
  app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
    maxAge: '30d',
    immutable: true,
  }));

  // parsers
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(methodOverride('_method'));

  // Initialize persistent session store
  const sessionStore = new SqliteSessionStore(db, {
    cleanupIntervalSeconds: 900 // Clean expired sessions every 15 minutes
  });

  // sessions - now using persistent SQLite store instead of MemoryStore
  app.use(
    session({
      store: sessionStore,
      secret: sessionSecret || crypto.randomBytes(32).toString('hex'),
      name: process.env.SESSION_COOKIE_NAME || 'paracausal.sid',
      proxy: !!trustProxySetting,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'strict',
        secure: isProduction ? 'auto' : false,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
      }
    })
  );

  // Custom flash middleware - stores messages in session, no external dependency
  app.use((req, res, next) => {
    if (!req.session) {
      req.flash = () => '';
      return next();
    }
    
    if (!req.session.flash) {
      req.session.flash = {};
    }
    
    req.flash = function(type, message) {
      if (typeof message === 'string') {
        // Store message
        req.session.flash[type] = message;
        return;
      }
      // Retrieve and clear message
      const msg = req.session.flash[type] || '';
      delete req.session.flash[type];
      return msg;
    };
    
    next();
  });

  app.use(attachCsrfToken);

  app.use((req, res, next) => {
    hasAnyAdmin(db)
      .then((adminExists) => {
        req.adminExists = adminExists;
        req.adminSetupRequired = !adminExists;
        res.locals.adminSetupRequired = !adminExists;
        next();
      })
      .catch(next);
  });

  // set locals middleware
  app.use((req, res, next) => {
    res.locals.currentUser = req.session.admin || null;
    res.locals.adminSetupRequired = !!req.adminSetupRequired;
    res.locals.assetVersion = STYLE_CSS_VERSION;
    res.locals.hidePlayer = false;
    res.locals.success = req.flash('success');
    res.locals.error = req.flash('error');
    next();
  });

  app.use(validateCsrfTokenForNonMultipart);

  app.use((req, res, next) => {
    if (!req.adminSetupRequired) {
      return next();
    }

    if (req.path === '/setup') {
      return next();
    }

    if (req.path === '/logout') {
      if (req.session) {
        return req.session.destroy((err) => {
          if (err) {
            return next(err);
          }

          return res.redirect('/setup');
        });
      }

      return res.redirect('/setup');
    }

    if (typeof req.flash === 'function') {
      req.flash('error', 'Complete the one-time setup to create the first admin account.');
    }

    return res.redirect('/setup');
  });

  // routes
  app.use('/', publicRoutes);
  app.use('/', authRoutes);
  app.use('/admin', ensureAdmin, adminRoutes);

  // Error handling middleware
  app.use((err, req, res, next) => {
    if (res.headersSent) {
      return next(err);
    }

    const statusCode = getErrorStatusCode(err);
    const adminRequest = isAdminRequest(req);
    const authRequest = isAuthRequest(req);
    const expectsJson = requestExpectsJson(req);
    const userMessage = err && err.name === 'MulterError'
      ? (err.field ? `File upload error in field "${err.field}": ${err.message}` : `File upload error: ${err.message}`)
      : getUserFacingErrorMessage(err, statusCode);

    console.error(`Request error on ${req.method} ${req.originalUrl}:`, err);

    if (expectsJson) {
      return res.status(statusCode).json({ error: userMessage });
    }

    if ((adminRequest || authRequest) && req.method !== 'GET') {
      if (typeof req.flash === 'function') {
        req.flash('error', userMessage);
      }

      const fallbackPath = authRequest
        ? (req.adminSetupRequired ? '/setup' : '/login')
        : '/admin';
      return res.status(statusCode).redirect(req.get('referrer') || fallbackPath);
    }

    if (statusCode === 404) {
      return res.status(404).render('404');
    }

    return res.status(statusCode).render('500', {
      message: userMessage,
      statusCode,
    });
  });

  // 404
  app.use((req, res) => {
    res.status(404).render('404');
  });

  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
  });
})();