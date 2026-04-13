const { createAsyncRouter } = require('../middleware/async-router');
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const mm = require('music-metadata');
const { DB_FILE_PATH } = require('../database/db-config');
const { validateCsrfToken } = require('../middleware/security');
const { getAnalyticsSummary, resetAnalyticsPageViews } = require('../utils/analytics');
const { UPLOADS_ROOT, createBackupArchive } = require('../utils/backup');
const {
  PUBLICATION_STATUS_OPTIONS,
  PUBLISHED_CONTENT_STATUS,
  SCHEDULED_CONTENT_STATUS,
  formatPublicationStatusLabel,
  normalizePublicationStatus,
  normalizePublicationStatusFilter,
  normalizePublicationTimestamp,
} = require('../utils/content-publication-status');
const {
  loadRelationshipIds,
  syncRelationshipSet,
} = require('../utils/content-relationships');
const {
  HOMEPAGE_SECTION_STYLE_OPTIONS,
  HOMEPAGE_SECTION_TYPE_OPTIONS,
  formatHomepageSectionTypeLabel,
  normalizeHomepageSectionInput,
} = require('../utils/homepage-sections');
const {
  getHomepageSettings,
  normalizeHomepageSettingsInput,
  saveHomepageSettings,
} = require('../utils/homepage-settings');
const { deriveImageUploadTitle } = require('../utils/image-upload-title');
const { generatePreviewToken } = require('../utils/preview-tokens');
const {
  PROJECT_STATUS_OPTIONS,
  formatProjectStatusLabel,
  normalizeProjectStatus,
} = require('../utils/project-status');
const { generateUniqueSlug, resolveOptionalSlug } = require('../utils/slugs');
const { getNextSortOrder } = require('../utils/sort-order');
const { attachTagsToItems, syncContentTags } = require('../utils/tags');

const router = createAsyncRouter();

ffmpeg.setFfmpegPath(ffmpegStatic);

const MUSIC_UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'music');
const WAV_EXTENSIONS = new Set(['.wav', '.wave']);
const WAV_MIME_TYPES = new Set([
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/vnd.wave',
]);
const HOMEPAGE_LINK_SECTIONS = {
  socials: 'Socials',
  other: 'Other Links',
};
const ADMIN_USERNAME_MIN_LENGTH = 3;
const ADMIN_USERNAME_MAX_LENGTH = 50;
const ADMIN_RELATIONSHIP_QUERIES = {
  tracks: `SELECT id, title, artist, publication_status FROM music ORDER BY sort_order ASC, id DESC`,
  videos: `SELECT id, title, publication_status FROM videos WHERE filename IS NOT NULL AND TRIM(filename) != '' ORDER BY sort_order ASC, created_at DESC, id DESC`,
  galleryItems: `SELECT id, title, publication_status FROM gallery ORDER BY sort_order ASC, created_at DESC, id DESC`,
  projects: `SELECT id, title, project_status, publication_status FROM projects ORDER BY sort_order ASC, created_at DESC, id DESC`,
};

const safeDeleteFile = async (filePath) => {
  if (!filePath) return false;

  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    await fs.promises.unlink(filePath);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return false;
    }
    console.error(`Error deleting file ${filePath}:`, err.message);
    return false;
  }
};

const deleteUploadedFile = async (filename, subdir) => {
  if (!filename) return false;
  const filePath = path.join(__dirname, '..', 'uploads', subdir, filename);
  return safeDeleteFile(filePath);
};

async function deriveTitleFromUploadedImage(subdir, file) {
  if (!file || !file.filename) {
    return '';
  }

  const filePath = path.join(__dirname, '..', 'uploads', subdir, file.filename);
  return deriveImageUploadTitle(filePath, file.originalname);
}

const countMusicCoverReferences = async (db, coverFilename, excludeMusicId = null) => {
  if (!coverFilename) return 0;

  let sql = 'SELECT COUNT(*) as count FROM music WHERE cover_image = ?';
  const params = [coverFilename];

  if (excludeMusicId !== null && excludeMusicId !== undefined) {
    sql += ' AND id != ?';
    params.push(excludeMusicId);
  }

  const row = await db.get(sql, ...params);
  return row && Number.isFinite(row.count) ? row.count : 0;
};

const deleteMusicCoverIfUnreferenced = async (db, coverFilename, excludeMusicId = null) => {
  if (!coverFilename) return false;

  const referenceCount = await countMusicCoverReferences(db, coverFilename, excludeMusicId);
  if (referenceCount > 0) {
    return false;
  }

  return deleteUploadedFile(coverFilename, 'music');
};

const deleteMusicFiles = async (db, musicId) => {
  const track = await db.get('SELECT filename, cover_image FROM music WHERE id = ?', musicId);
  if (!track) return;

  await deleteUploadedFile(track.filename, 'music');

  if (track.cover_image) {
    await deleteMusicCoverIfUnreferenced(db, track.cover_image, musicId);
  }
};

const deleteVideoFiles = async (db, videoId) => {
  const video = await db.get('SELECT filename, thumbnail FROM videos WHERE id = ?', videoId);
  if (!video) return;

  if (video.filename) {
    await deleteUploadedFile(video.filename, 'videos');
  }

  if (video.thumbnail) {
    await deleteUploadedFile(video.thumbnail, 'videos');
  }
};

const deleteGalleryFiles = async (db, galleryId) => {
  const img = await db.get('SELECT filename FROM gallery WHERE id = ?', galleryId);
  if (!img) return;

  await deleteUploadedFile(img.filename, 'images');
};

const deleteProjectUpdateFiles = async (db, updateId) => {
  const update = await db.get('SELECT image_filename FROM project_updates WHERE id = ?', updateId);
  if (update && update.image_filename) {
    await deleteUploadedFile(update.image_filename, 'projects');
  }

  const attachments = await db.all('SELECT filename FROM project_update_attachments WHERE update_id = ?', updateId);
  for (const attachment of attachments) {
    await deleteUploadedFile(attachment.filename, 'documents');
  }
};

const deleteProjectFiles = async (db, projectId) => {
  const proj = await db.get('SELECT hero_image FROM projects WHERE id = ?', projectId);
  if (!proj) return;

  if (proj.hero_image) {
    await deleteUploadedFile(proj.hero_image, 'projects');
  }

  const docs = await db.all('SELECT filename FROM project_documents WHERE project_id = ?', projectId);
  for (const doc of docs) {
    await deleteUploadedFile(doc.filename, 'documents');
  }

  const updates = await db.all('SELECT id FROM project_updates WHERE project_id = ?', projectId);
  for (const update of updates) {
    await deleteProjectUpdateFiles(db, update.id);
  }
};

const generateVideoThumbnail = (videoPath, outputPath) => new Promise((resolve, reject) => {
  ffmpeg(videoPath)
    .on('error', reject)
    .screenshot({
      timestamps: ['1%'],
      filename: path.basename(outputPath),
      folder: path.dirname(outputPath),
      size: '320x240',
    })
    .on('end', () => resolve(path.basename(outputPath)));
});

const convertAudioToMp3 = (inputPath, outputPath) => new Promise((resolve, reject) => {
  ffmpeg(inputPath)
    .audioCodec('libmp3lame')
    .audioBitrate('192k')
    .format('mp3')
    .on('error', reject)
    .on('end', () => resolve(path.basename(outputPath)))
    .save(outputPath);
});

function isWavUpload(file) {
  if (!file) return false;

  const extension = path.extname(file.originalname || file.filename || '').toLowerCase();
  const mimeType = (file.mimetype || '').toLowerCase();

  return WAV_EXTENSIONS.has(extension) || WAV_MIME_TYPES.has(mimeType);
}

async function extractEmbeddedCoverFromMetadata(parsed, outputDir) {
  if (!parsed || !parsed.common || !parsed.common.picture || parsed.common.picture.length === 0) {
    return null;
  }

  const picture = parsed.common.picture[0];
  const formatParts = (picture.format || '').split('/');
  const ext = formatParts[1] || 'jpg';
  const coverFilename = `${Date.now()}_embedded.${ext}`;
  const coverPath = path.join(outputDir, coverFilename);

  await fs.promises.writeFile(coverPath, picture.data);
  return coverFilename;
}

function mapParsedMusicMetadata(parsed, originalname = '') {
  const common = parsed && parsed.common ? parsed.common : {};
  const trackNumber = common.track && Number.isFinite(common.track.no) ? common.track.no : null;

  return {
    title: common.title || path.parse(originalname || '').name || '',
    artist: common.artist || '',
    album: common.album || '',
    year: common.year || '',
    track: trackNumber,
  };
}

async function parseMusicUploadFromFile(filePath, originalname = '', options = {}) {
  const { extractCover = false, coverOutputDir = path.join('uploads', 'music') } = options;
  const parsed = await mm.parseFile(filePath);
  const metadata = mapParsedMusicMetadata(parsed, originalname);
  let extractedCoverFilename = null;

  if (extractCover) {
    extractedCoverFilename = await extractEmbeddedCoverFromMetadata(parsed, coverOutputDir);
  }

  return {
    metadata,
    extractedCoverFilename,
    hasEmbeddedCover: !!extractedCoverFilename || !!(parsed.common && parsed.common.picture && parsed.common.picture.length > 0),
  };
}

async function parseMusicUploadFromBuffer(fileBuffer, originalname = '', mimeType = '') {
  const parsed = await mm.parseBuffer(fileBuffer, mimeType ? { mimeType } : undefined, { duration: false });
  const metadata = mapParsedMusicMetadata(parsed, originalname);
  const picture = parsed.common && parsed.common.picture && parsed.common.picture.length > 0
    ? parsed.common.picture[0]
    : null;

  return {
    metadata,
    coverPreview: picture
      ? {
        mimeType: picture.format || 'image/jpeg',
        dataUrl: `data:${picture.format || 'image/jpeg'};base64,${picture.data.toString('base64')}`,
      }
      : null,
  };
}

async function prepareMusicUploadForPlayback(file, options = {}) {
  if (!file) {
    return {
      metadata: {
        title: '',
        artist: '',
        album: '',
        year: '',
        track: null,
      },
      extractedCoverFilename: null,
      hasEmbeddedCover: false,
      playbackFilename: '',
      convertedToMp3: false,
    };
  }

  const { extractCover = false } = options;
  const sourcePath = path.join(MUSIC_UPLOAD_DIR, file.filename);
  const transcodedFilename = `${path.parse(file.filename).name}.transcoded.mp3`;
  const transcodedPath = path.join(MUSIC_UPLOAD_DIR, transcodedFilename);
  const shouldConvert = isWavUpload(file);
  let parsed = {
    metadata: {
      title: '',
      artist: '',
      album: '',
      year: '',
      track: null,
    },
    extractedCoverFilename: null,
    hasEmbeddedCover: false,
  };

  try {
    parsed = await parseMusicUploadFromFile(sourcePath, file.originalname, {
      extractCover,
      coverOutputDir: MUSIC_UPLOAD_DIR,
    });
  } catch (err) {
    console.log('Music metadata extraction failed for', file.originalname, err.message);
  }

  if (shouldConvert) {
    try {
      await convertAudioToMp3(sourcePath, transcodedPath);
      await safeDeleteFile(sourcePath);
    } catch (err) {
      if (parsed.extractedCoverFilename) {
        await deleteUploadedFile(parsed.extractedCoverFilename, 'music');
      }
      await safeDeleteFile(sourcePath);
      await safeDeleteFile(transcodedPath);
      throw new Error(`Failed to convert ${file.originalname} to MP3: ${err.message}`);
    }
  }

  return {
    metadata: parsed.metadata,
    extractedCoverFilename: parsed.extractedCoverFilename,
    hasEmbeddedCover: parsed.hasEmbeddedCover,
    playbackFilename: shouldConvert ? transcodedFilename : file.filename,
    convertedToMp3: shouldConvert,
  };
}

const musicStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/music'),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname)),
});
const videoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/videos'),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname)),
});
const imageStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/images'),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname)),
});
const projectStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/projects'),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname)),
});

const uploadImage = multer({ storage: imageStorage });
const uploadMusicPreview = multer({ storage: multer.memoryStorage() });

const documentStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/documents'),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname)),
});
const uploadDocument = multer({ storage: documentStorage });
const uploadDocumentFields = multer({ storage: documentStorage }).fields([
  { name: 'documents', maxCount: 10 },
]);

const uploadMusicFields = multer({ storage: musicStorage }).fields([
  { name: 'file', maxCount: 1 },
  { name: 'cover', maxCount: 1 },
]);
const uploadBatchMusic = multer({ storage: musicStorage }).fields([
  { name: 'files', maxCount: 50 },
  { name: 'shared_cover', maxCount: 1 },
]);
const uploadVideoFields = multer({ storage: videoStorage }).fields([
  { name: 'file', maxCount: 1 },
]);
const uploadProjectCreate = multer({ storage: projectStorage }).fields([
  { name: 'hero_image', maxCount: 1 },
]);
const uploadProjectWithDocs = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      if (file.fieldname === 'hero_image') {
        cb(null, 'uploads/projects');
        return;
      }
      if (file.fieldname === 'documents') {
        cb(null, 'uploads/documents');
        return;
      }
      cb(new Error(`Unsupported project upload field: ${file.fieldname}`));
    },
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname)),
  }),
}).fields([
  { name: 'hero_image', maxCount: 1 },
  { name: 'documents', maxCount: 10 },
]);
const uploadUpdateWithDocs = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      if (file.fieldname === 'image') {
        cb(null, 'uploads/projects');
        return;
      }
      if (file.fieldname === 'documents') {
        cb(null, 'uploads/documents');
        return;
      }
      cb(new Error(`Unsupported project update upload field: ${file.fieldname}`));
    },
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname)),
  }),
}).fields([
  { name: 'image', maxCount: 1 },
  { name: 'documents', maxCount: 10 },
]);

async function cleanupUploadedRequestFiles(filesByField, fieldDirectories = {}) {
  if (!filesByField || typeof filesByField !== 'object') return;

  const entries = Object.entries(fieldDirectories);
  for (const [fieldName, subdir] of entries) {
    const files = Array.isArray(filesByField[fieldName]) ? filesByField[fieldName] : [];
    for (const file of files) {
      if (file && file.filename) {
        await deleteUploadedFile(file.filename, subdir);
      }
    }
  }
}

async function createMusicPlaylist(db, title, description = '') {
  const playlistTitle = String(title || '').trim();
  if (!playlistTitle) {
    return null;
  }

  const playlistSlug = await generateUniqueSlug(db, {
    tableName: 'music_playlists',
    title: playlistTitle,
    fallbackPrefix: 'playlist',
    allowNumericOnly: false,
  });

  const result = await db.run(
    'INSERT INTO music_playlists (title, slug, description) VALUES (?,?,?)',
    playlistTitle,
    playlistSlug,
    String(description || '').trim() || null
  );

  return result.lastID;
}

async function assignTrackToPlaylist(db, playlistId, musicId, orderIndexHint = null) {
  const normalizedPlaylistId = parseInt(playlistId, 10);
  const normalizedMusicId = parseInt(musicId, 10);

  if (Number.isNaN(normalizedPlaylistId) || Number.isNaN(normalizedMusicId)) {
    return false;
  }

  const existing = await db.get(
    'SELECT 1 FROM music_playlist_items WHERE playlist_id = ? AND music_id = ?',
    normalizedPlaylistId,
    normalizedMusicId
  );
  if (existing) {
    return false;
  }

  const parsedOrderIndex = parseInt(orderIndexHint, 10);
  let nextOrderIndex = !Number.isNaN(parsedOrderIndex) && parsedOrderIndex > 0
    ? parsedOrderIndex
    : null;

  if (nextOrderIndex !== null) {
    const conflictingOrder = await db.get(
      'SELECT 1 FROM music_playlist_items WHERE playlist_id = ? AND order_index = ?',
      normalizedPlaylistId,
      nextOrderIndex
    );

    if (conflictingOrder) {
      nextOrderIndex = null;
    }
  }

  if (nextOrderIndex === null) {
    const maxOrder = await db.get(
      'SELECT MAX(order_index) AS max_order FROM music_playlist_items WHERE playlist_id = ?',
      normalizedPlaylistId
    );
    nextOrderIndex = (maxOrder && Number.isFinite(maxOrder.max_order) ? maxOrder.max_order : 0) + 1;
  }

  await db.run(
    'INSERT INTO music_playlist_items (playlist_id, music_id, order_index) VALUES (?,?,?)',
    normalizedPlaylistId,
    normalizedMusicId,
    nextOrderIndex
  );

  return true;
}

function normalizeSelectedIds(rawIds) {
  const values = Array.isArray(rawIds) ? rawIds : [rawIds];
  return [...new Set(values
    .map((value) => parseInt(value, 10))
    .filter((value) => !Number.isNaN(value) && value > 0))];
}

function normalizeReleaseDate(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return null;
  }

  return /^\d{4}-\d{2}-\d{2}$/.test(trimmedValue) ? trimmedValue : null;
}

function getScheduledPublicationValidationError(publicationStatus, publishedAt) {
  if (publicationStatus === SCHEDULED_CONTENT_STATUS && !publishedAt) {
    return 'Choose a publish time for scheduled content.';
  }

  return '';
}

function getSafeAdminReturnTarget(value, fallbackPath) {
  const fallback = typeof fallbackPath === 'string' && fallbackPath.trim()
    ? fallbackPath.trim()
    : '/admin';
  const requested = typeof value === 'string' ? value.trim() : '';

  if (!requested || !requested.startsWith('/admin/')) {
    return fallback;
  }

  return requested;
}

async function getAdminRelationshipOptions(db) {
  const [tracks, videos, galleryItems, projects] = await Promise.all([
    db.all(ADMIN_RELATIONSHIP_QUERIES.tracks),
    db.all(ADMIN_RELATIONSHIP_QUERIES.videos),
    db.all(ADMIN_RELATIONSHIP_QUERIES.galleryItems),
    db.all(ADMIN_RELATIONSHIP_QUERIES.projects),
  ]);

  tracks.forEach((track) => {
    track.publicationStatusLabel = formatPublicationStatusLabel(track.publication_status);
  });
  videos.forEach((video) => {
    video.publicationStatusLabel = formatPublicationStatusLabel(video.publication_status);
  });
  galleryItems.forEach((image) => {
    image.publicationStatusLabel = formatPublicationStatusLabel(image.publication_status);
  });
  projects.forEach((project) => {
    project.publicationStatusLabel = formatPublicationStatusLabel(project.publication_status);
    project.projectStatusLabel = formatProjectStatusLabel(project.project_status);
  });

  return { tracks, videos, galleryItems, projects };
}

async function getMusicSelectionState(db, musicId) {
  return {
    relatedVideoIds: await loadRelationshipIds(db, 'musicVideos', musicId),
    relatedProjectIds: await loadRelationshipIds(db, 'musicProjects', musicId),
  };
}

async function getVideoSelectionState(db, videoId) {
  return {};
}

async function getGallerySelectionState(db, galleryId) {
  return {
    relatedProjectIds: await loadRelationshipIds(db, 'galleryProjects', galleryId),
  };
}

async function getProjectSelectionState(db, projectId) {
  return {
    relatedTrackIds: await loadRelationshipIds(db, 'projectMusic', projectId),
    relatedVideoIds: await loadRelationshipIds(db, 'projectVideos', projectId),
    relatedGalleryIds: await loadRelationshipIds(db, 'projectGallery', projectId),
  };
}

async function syncMusicSelections(db, musicId, body = {}) {
  await syncRelationshipSet(db, 'musicVideos', musicId, body.related_video_ids);
  await syncRelationshipSet(db, 'musicProjects', musicId, body.related_project_ids);
}

async function syncVideoSelections(db, videoId, body = {}) {
  // Videos do not own any relationship direction; linked from music and projects instead.
}

async function syncGallerySelections(db, galleryId, body = {}) {
  await syncRelationshipSet(db, 'galleryProjects', galleryId, body.related_project_ids);
}

async function syncProjectSelections(db, projectId, body = {}) {
  await syncRelationshipSet(db, 'projectMusic', projectId, body.related_track_ids);
  await syncRelationshipSet(db, 'projectVideos', projectId, body.related_video_ids);
  await syncRelationshipSet(db, 'projectGallery', projectId, body.related_gallery_ids);
}

async function deleteMusicRecord(db, musicId) {
  const track = await db.get('SELECT id FROM music WHERE id = ?', musicId);
  if (!track) return false;

  await deleteMusicFiles(db, musicId);
  await db.run('DELETE FROM music WHERE id = ?', musicId);
  return true;
}

async function deleteVideoRecord(db, videoId) {
  const video = await db.get('SELECT id FROM videos WHERE id = ?', videoId);
  if (!video) return false;

  await deleteVideoFiles(db, videoId);
  await db.run('DELETE FROM videos WHERE id = ?', videoId);
  return true;
}

async function deleteGalleryRecord(db, galleryId) {
  const galleryItem = await db.get('SELECT id FROM gallery WHERE id = ?', galleryId);
  if (!galleryItem) return false;

  await deleteGalleryFiles(db, galleryId);
  await db.run('DELETE FROM gallery WHERE id = ?', galleryId);
  return true;
}

async function deleteProjectRecord(db, projectId) {
  const project = await db.get('SELECT id FROM projects WHERE id = ?', projectId);
  if (!project) return false;

  await deleteProjectFiles(db, projectId);
  await db.run('DELETE FROM projects WHERE id = ?', projectId);
  return true;
}

async function bulkDeleteRecords(ids, deleteRecord) {
  let deleted = 0;
  let failed = 0;
  let missing = 0;

  for (const id of ids) {
    try {
      const removed = await deleteRecord(id);
      if (removed) {
        deleted += 1;
      } else {
        missing += 1;
      }
    } catch (err) {
      failed += 1;
      console.error(`Bulk delete failed for record ${id}:`, err);
    }
  }

  return { deleted, failed, missing };
}

function buildBulkDeleteMessage(result, singularLabel, pluralLabel) {
  const parts = [];

  if (result.deleted > 0) {
    parts.push(`Deleted ${result.deleted} ${result.deleted === 1 ? singularLabel : pluralLabel}`);
  }
  if (result.missing > 0) {
    parts.push(`${result.missing} already missing`);
  }
  if (result.failed > 0) {
    parts.push(`${result.failed} failed`);
  }

  return parts.join('. ');
}

function getHomepageLinkSections() {
  return Object.entries(HOMEPAGE_LINK_SECTIONS).map(([value, label]) => ({ value, label }));
}

function isValidHomepageLinkSection(section) {
  return Object.prototype.hasOwnProperty.call(HOMEPAGE_LINK_SECTIONS, section);
}

function normalizeHomepageLinkInput(body = {}) {
  return {
    title: (body.title || '').trim(),
    url: (body.url || '').trim(),
    section: (body.section || '').trim(),
    description: (body.description || '').trim(),
    orderIndex: (body.order_index || '').toString().trim(),
  };
}

function parseHomepageLinkOrderIndex(rawOrderIndex) {
  if (!rawOrderIndex) return null;
  const parsed = parseInt(rawOrderIndex, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function isValidHomepageLinkUrl(url) {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(parsed.protocol);
  } catch (err) {
    return false;
  }
}

function normalizeOptionalDate(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return null;
  }

  return /^\d{4}-\d{2}-\d{2}$/.test(trimmedValue) ? trimmedValue : null;
}

function normalizeBooleanFlag(value) {
  return value === '1' || value === 'true' || value === 'on' || value === true;
}

function buildAbsoluteShareUrl(req, pathname) {
  if (!pathname) {
    return '';
  }

  const normalizedPathname = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const protocol = req && req.protocol ? req.protocol : '';
  const host = req && typeof req.get === 'function' ? req.get('host') : '';

  if (protocol && host) {
    return `${protocol}://${host}${normalizedPathname}`;
  }

  return normalizedPathname;
}

function buildPublicUrl(req, pathname) {
  return buildAbsoluteShareUrl(req, pathname);
}

function buildPreviewUrl(pathname, previewToken, req = null) {
  if (!pathname || !previewToken) {
    return '';
  }

  const normalizedPathname = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return buildAbsoluteShareUrl(req, `${normalizedPathname}?preview=${encodeURIComponent(previewToken)}`);
}

async function ensurePreviewTokenForRecord(db, tableName, record) {
  if (!record || !record.id) {
    return '';
  }

  if (record.preview_token) {
    return record.preview_token;
  }

  const previewToken = generatePreviewToken();
  await db.run(`UPDATE ${tableName} SET preview_token = ? WHERE id = ?`, previewToken, record.id);
  record.preview_token = previewToken;
  return previewToken;
}

function normalizeHomepageSectionLimit(value) {
  const parsed = parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    return null;
  }

  return Math.max(1, Math.min(parsed, 24));
}

function normalizeHomepageSectionSourceGroup(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ['socials', 'other'].includes(normalized) ? normalized : '';
}

async function getHomepageSectionEditorOptions(db) {
  const relationshipOptions = await getAdminRelationshipOptions(db);
  return {
    ...relationshipOptions,
    homepageLinkSections: getHomepageLinkSections(),
  };
}

async function loadHomepageSectionsForAdmin(db) {
  const sections = await db.all(
    `SELECT hs.*, m.title AS linked_track_title,
            v.title AS linked_video_title, g.title AS linked_gallery_title
     FROM homepage_sections hs
     LEFT JOIN music m ON m.id = hs.linked_track_id
     LEFT JOIN videos v ON v.id = hs.linked_video_id
     LEFT JOIN gallery g ON g.id = hs.linked_gallery_id
     ORDER BY hs.sort_order ASC, hs.id ASC`
  );

  sections.forEach((section) => {
    section.sectionTypeLabel = formatHomepageSectionTypeLabel(section.section_type);
  });

  return sections;
}

async function getHomepageFeatureOptions(db) {
  const [projects, tracks, videos] = await Promise.all([
    db.all(
      `SELECT id, title, project_status
       FROM projects
       WHERE COALESCE(publication_status, ?) = ?
       ORDER BY sort_order ASC, created_at DESC, id DESC`,
      PUBLISHED_CONTENT_STATUS,
      PUBLISHED_CONTENT_STATUS
    ),
    db.all(
      `SELECT id, title, artist, album
       FROM music
       WHERE COALESCE(publication_status, ?) = ?
       ORDER BY sort_order ASC, id DESC`,
      PUBLISHED_CONTENT_STATUS,
      PUBLISHED_CONTENT_STATUS
    ),
    db.all(
      `SELECT id, title
       FROM videos
       WHERE COALESCE(publication_status, ?) = ?
         AND filename IS NOT NULL
         AND TRIM(filename) != ''
       ORDER BY sort_order ASC, created_at DESC, id DESC`,
      PUBLISHED_CONTENT_STATUS,
      PUBLISHED_CONTENT_STATUS
    ),
  ]);

  return { projects, tracks, videos };
}

async function getUnavailableHomepageSelections(db, settings, featureOptions) {
  const unavailableSelections = [];

  if (settings.featuredProjectId && !featureOptions.projects.some((project) => project.id === settings.featuredProjectId)) {
    unavailableSelections.push('The saved featured project is no longer published or no longer exists.');
  }
  if (settings.featuredTrackId && !featureOptions.tracks.some((track) => track.id === settings.featuredTrackId)) {
    unavailableSelections.push('The saved featured track is no longer published or no longer exists.');
  }
  if (settings.featuredVideoId && !featureOptions.videos.some((video) => video.id === settings.featuredVideoId)) {
    unavailableSelections.push('The saved featured video is no longer published or no longer exists.');
  }

  return unavailableSelections;
}

function validateHomepageSelection(settings, featureOptions) {
  if (settings.featuredProjectId && !featureOptions.projects.some((project) => project.id === settings.featuredProjectId)) {
    return 'Choose a published featured project or leave it blank.';
  }
  if (settings.featuredTrackId && !featureOptions.tracks.some((track) => track.id === settings.featuredTrackId)) {
    return 'Choose a published featured track or leave it blank.';
  }
  if (settings.featuredVideoId && !featureOptions.videos.some((video) => video.id === settings.featuredVideoId)) {
    return 'Choose a published featured video or leave it blank.';
  }

  return '';
}

function isAjaxRequest(req) {
  const requestedWith = (req.get('X-Requested-With') || '').toLowerCase();
  const accept = (req.get('Accept') || '').toLowerCase();
  return requestedWith === 'xmlhttprequest' || accept.includes('application/json');
}

function respondWithUploadSuccess(req, res, redirectTo, message) {
  req.flash('success', message);

  if (isAjaxRequest(req)) {
    return res.status(200).json({
      ok: true,
      redirectTo,
      message,
    });
  }

  return res.redirect(redirectTo);
}

function respondWithUploadError(req, res, options) {
  const {
    redirectTo,
    message,
    statusCode = 400,
    flashMessage = message,
  } = options;

  if (isAjaxRequest(req)) {
    return res.status(statusCode).json({
      ok: false,
      error: message,
      redirectTo,
    });
  }

  req.flash('error', flashMessage);
  return res.redirect(redirectTo);
}


// dashboard overview
router.get('/', async (req, res) => {
  const db = req.app.locals.db;
  const counts = {};
  counts.music = (await db.get('SELECT COUNT(*) as c FROM music')).c;
  counts.videos = (await db.get('SELECT COUNT(*) as c FROM videos')).c;
  counts.gallery = (await db.get('SELECT COUNT(*) as c FROM gallery')).c;
  counts.projects = (await db.get('SELECT COUNT(*) as c FROM projects')).c;
  counts.homepageLinks = (await db.get('SELECT COUNT(*) as c FROM homepage_links')).c;
  counts.analyticsViews = (await db.get('SELECT COUNT(*) as c FROM analytics_page_views')).c;
  res.render('admin/dashboard', { counts });
});

router.get('/analytics', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const analytics = await getAnalyticsSummary(db);
    return res.render('admin/analytics', { analytics });
  } catch (err) {
    console.error('Analytics page load error:', err);
    req.flash('error', 'Failed to load analytics.');
    return res.redirect('/admin');
  }
});

router.post('/analytics/reset', async (req, res) => {
  try {
    const db = req.app.locals.db;
    await resetAnalyticsPageViews(db);
    req.flash('success', 'Analytics data cleared.');
  } catch (err) {
    console.error('Analytics reset error:', err);
    req.flash('error', 'Failed to reset analytics.');
  }

  return res.redirect('/admin/analytics');
});

router.get('/maintenance', async (req, res) => {
  return res.render('admin/maintenance', {
    dbPath: DB_FILE_PATH,
    uploadsPath: UPLOADS_ROOT,
  });
});

router.post('/maintenance/backup', async (req, res) => {
  const db = req.app.locals.db;

  try {
    const backup = await createBackupArchive({
      db,
      dbPath: DB_FILE_PATH,
      uploadsPath: UPLOADS_ROOT,
    });

    res.setHeader('Cache-Control', 'no-store');
    return res.download(backup.archivePath, backup.archiveFilename, (err) => {
      fs.rm(backup.tempRoot, { recursive: true, force: true }, () => {});

      if (err && !res.headersSent) {
        console.error('Backup download error:', err);
        req.flash('error', 'Failed to download backup.');
        return res.redirect('/admin/maintenance');
      }

      return undefined;
    });
  } catch (err) {
    console.error('Backup creation error:', err);
    req.flash('error', 'Failed to create backup.');
    return res.redirect('/admin/maintenance');
  }
});

router.get('/homepage-links', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const links = await db.all(
      `SELECT *
       FROM homepage_links
       ORDER BY section, COALESCE(order_index, 999999), title, id`
    );

    return res.render('admin/homepage-links/index', {
      links,
      sections: getHomepageLinkSections(),
      sectionLabels: HOMEPAGE_LINK_SECTIONS,
    });
  } catch (err) {
    console.error('Homepage links load error:', err);
    req.flash('error', 'Failed to load homepage links.');
    return res.render('admin/homepage-links/index', {
      links: [],
      sections: getHomepageLinkSections(),
      sectionLabels: HOMEPAGE_LINK_SECTIONS,
    });
  }
});

router.get('/homepage', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const [settings, featureOptions, homepageSections] = await Promise.all([
      getHomepageSettings(db),
      getHomepageFeatureOptions(db),
      loadHomepageSectionsForAdmin(db),
    ]);
    const unavailableSelections = await getUnavailableHomepageSelections(db, settings, featureOptions);

    return res.render('admin/homepage', {
      settings,
      featureOptions,
      unavailableSelections,
      homepageSections,
    });
  } catch (err) {
    console.error('Homepage settings load error:', err);
    req.flash('error', 'Failed to load homepage settings.');
    return res.redirect('/admin');
  }
});

router.get('/homepage-sections/new', async (req, res) => {
  const db = req.app.locals.db;
  const options = await getHomepageSectionEditorOptions(db);
  return res.render('admin/homepage-sections/new', {
    homepageSection: {
      section_type: 'manifesto_block',
      title_override: '',
      body_text: '',
      item_limit: 6,
      enabled: 1,
      linked_track_id: null,
      linked_video_id: null,
      linked_gallery_id: null,
      source_group: '',
      filter_tag: '',
      accent_colour: '',
      style_mode: 'default',
    },
    sectionTypeOptions: HOMEPAGE_SECTION_TYPE_OPTIONS,
    styleOptions: HOMEPAGE_SECTION_STYLE_OPTIONS,
    options,
  });
});

router.post('/homepage-sections', validateCsrfToken, async (req, res) => {
  try {
    const db = req.app.locals.db;
    const payload = normalizeHomepageSectionInput(req.body);
    const nextSortOrder = await getNextSortOrder(db, 'homepageSections');

    await db.run(
      `INSERT INTO homepage_sections (
        section_type, title_override, body_text, item_limit, enabled,
        linked_track_id, linked_video_id, linked_gallery_id,
        source_group, filter_tag, accent_colour, style_mode, sort_order
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      payload.sectionType,
      payload.titleOverride || null,
      payload.bodyText || null,
      normalizeHomepageSectionLimit(payload.itemLimit),
      payload.enabled ? 1 : 0,
      payload.linkedTrackId,
      payload.linkedVideoId,
      payload.linkedGalleryId,
      normalizeHomepageSectionSourceGroup(payload.sourceGroup) || null,
      payload.filterTag || null,
      payload.accentColour || null,
      payload.styleMode,
      nextSortOrder
    );

    req.flash('success', 'Homepage section created.');
    return res.redirect('/admin/homepage');
  } catch (err) {
    console.error('Homepage section creation error:', err);
    req.flash('error', 'Failed to create homepage section.');
    return res.redirect('/admin/homepage');
  }
});

router.get('/homepage-sections/:id/edit', async (req, res) => {
  const db = req.app.locals.db;
  const homepageSection = await db.get('SELECT * FROM homepage_sections WHERE id = ?', req.params.id);
  if (!homepageSection) {
    req.flash('error', 'Homepage section not found.');
    return res.redirect('/admin/homepage');
  }

  const options = await getHomepageSectionEditorOptions(db);
  return res.render('admin/homepage-sections/edit', {
    homepageSection,
    sectionTypeOptions: HOMEPAGE_SECTION_TYPE_OPTIONS,
    styleOptions: HOMEPAGE_SECTION_STYLE_OPTIONS,
    options,
  });
});

router.put('/homepage-sections/:id', validateCsrfToken, async (req, res) => {
  try {
    const db = req.app.locals.db;
    const payload = normalizeHomepageSectionInput(req.body);
    const homepageSection = await db.get('SELECT id FROM homepage_sections WHERE id = ?', req.params.id);

    if (!homepageSection) {
      req.flash('error', 'Homepage section not found.');
      return res.redirect('/admin/homepage');
    }

    await db.run(
      `UPDATE homepage_sections
       SET section_type = ?,
           title_override = ?,
           body_text = ?,
           item_limit = ?,
           enabled = ?,
           linked_track_id = ?,
           linked_video_id = ?,
           linked_gallery_id = ?,
           source_group = ?,
           filter_tag = ?,
           accent_colour = ?,
           style_mode = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      payload.sectionType,
      payload.titleOverride || null,
      payload.bodyText || null,
      normalizeHomepageSectionLimit(payload.itemLimit),
      payload.enabled ? 1 : 0,
      payload.linkedTrackId,
      payload.linkedVideoId,
      payload.linkedGalleryId,
      normalizeHomepageSectionSourceGroup(payload.sourceGroup) || null,
      payload.filterTag || null,
      payload.accentColour || null,
      payload.styleMode,
      req.params.id
    );

    req.flash('success', 'Homepage section updated.');
    return res.redirect('/admin/homepage');
  } catch (err) {
    console.error('Homepage section update error:', err);
    req.flash('error', 'Failed to update homepage section.');
    return res.redirect(`/admin/homepage-sections/${req.params.id}/edit`);
  }
});

router.delete('/homepage-sections/:id', validateCsrfToken, async (req, res) => {
  try {
    const db = req.app.locals.db;
    await db.run('DELETE FROM homepage_sections WHERE id = ?', req.params.id);
    req.flash('success', 'Homepage section deleted.');
    return res.redirect('/admin/homepage');
  } catch (err) {
    console.error('Homepage section deletion error:', err);
    req.flash('error', 'Failed to delete homepage section.');
    return res.redirect('/admin/homepage');
  }
});

router.post('/homepage', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const settings = normalizeHomepageSettingsInput(req.body);
    const featureOptions = await getHomepageFeatureOptions(db);
    const validationError = validateHomepageSelection(settings, featureOptions);

    if (validationError) {
      req.flash('error', validationError);
      return res.redirect('/admin/homepage');
    }

    await saveHomepageSettings(db, settings);
    req.flash('success', 'Homepage settings updated.');
    return res.redirect('/admin/homepage');
  } catch (err) {
    console.error('Homepage settings update error:', err);
    req.flash('error', 'Failed to update homepage settings.');
    return res.redirect('/admin/homepage');
  }
});

router.post('/homepage-links', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const payload = normalizeHomepageLinkInput(req.body);

    if (!payload.title) {
      req.flash('error', 'Link title is required.');
      return res.redirect('/admin/homepage-links');
    }

    if (!payload.url || !isValidHomepageLinkUrl(payload.url)) {
      req.flash('error', 'Enter a valid link URL using http, https, mailto, or tel.');
      return res.redirect('/admin/homepage-links');
    }

    if (!isValidHomepageLinkSection(payload.section)) {
      req.flash('error', 'Choose a valid homepage section.');
      return res.redirect('/admin/homepage-links');
    }

    await db.run(
      'INSERT INTO homepage_links (title, url, section, description, order_index) VALUES (?,?,?,?,?)',
      payload.title,
      payload.url,
      payload.section,
      payload.description || null,
      parseHomepageLinkOrderIndex(payload.orderIndex)
    );

    req.flash('success', 'Homepage link created.');
    return res.redirect('/admin/homepage-links');
  } catch (err) {
    console.error('Homepage link creation error:', err);
    req.flash('error', 'Failed to create homepage link.');
    return res.redirect('/admin/homepage-links');
  }
});

router.get('/homepage-links/:id/edit', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const link = await db.get('SELECT * FROM homepage_links WHERE id = ?', req.params.id);
    if (!link) {
      req.flash('error', 'Homepage link not found.');
      return res.redirect('/admin/homepage-links');
    }

    return res.render('admin/homepage-links/edit', {
      link,
      sections: getHomepageLinkSections(),
    });
  } catch (err) {
    console.error('Homepage link edit load error:', err);
    req.flash('error', 'Failed to load homepage link.');
    return res.redirect('/admin/homepage-links');
  }
});

router.put('/homepage-links/:id', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const payload = normalizeHomepageLinkInput(req.body);
    const link = await db.get('SELECT id FROM homepage_links WHERE id = ?', req.params.id);

    if (!link) {
      req.flash('error', 'Homepage link not found.');
      return res.redirect('/admin/homepage-links');
    }

    if (!payload.title) {
      req.flash('error', 'Link title is required.');
      return res.redirect(`/admin/homepage-links/${req.params.id}/edit`);
    }

    if (!payload.url || !isValidHomepageLinkUrl(payload.url)) {
      req.flash('error', 'Enter a valid link URL using http, https, mailto, or tel.');
      return res.redirect(`/admin/homepage-links/${req.params.id}/edit`);
    }

    if (!isValidHomepageLinkSection(payload.section)) {
      req.flash('error', 'Choose a valid homepage section.');
      return res.redirect(`/admin/homepage-links/${req.params.id}/edit`);
    }

    await db.run(
      'UPDATE homepage_links SET title = ?, url = ?, section = ?, description = ?, order_index = ? WHERE id = ?',
      payload.title,
      payload.url,
      payload.section,
      payload.description || null,
      parseHomepageLinkOrderIndex(payload.orderIndex),
      req.params.id
    );

    req.flash('success', 'Homepage link updated.');
    return res.redirect('/admin/homepage-links');
  } catch (err) {
    console.error('Homepage link update error:', err);
    req.flash('error', 'Failed to update homepage link.');
    return res.redirect(`/admin/homepage-links/${req.params.id}/edit`);
  }
});

router.delete('/homepage-links/:id', async (req, res) => {
  try {
    const db = req.app.locals.db;
    await db.run('DELETE FROM homepage_links WHERE id = ?', req.params.id);
    req.flash('success', 'Homepage link deleted.');
    return res.redirect('/admin/homepage-links');
  } catch (err) {
    console.error('Homepage link deletion error:', err);
    req.flash('error', 'Failed to delete homepage link.');
    return res.redirect('/admin/homepage-links');
  }
});

router.post('/reorder/:contentType', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const config = getSortableContentConfig(req.params.contentType);
    if (!config) {
      return res.status(404).json({ error: 'Unknown content type.' });
    }

    const rawIds = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
    const orderedIds = normalizeSelectedIds(rawIds);
    if (!rawIds.length || orderedIds.length !== rawIds.length) {
      return res.status(400).json({ error: 'Invalid reorder payload.' });
    }

    const existingRows = await db.all(`SELECT id FROM ${config.tableName} ORDER BY sort_order ASC, id DESC`);
    const existingIds = existingRows.map((row) => row.id);
    if (existingIds.length !== orderedIds.length) {
      return res.status(400).json({ error: 'Reorder payload is incomplete. Reload the page and try again.' });
    }

    const existingIdSet = new Set(existingIds);
    if (orderedIds.some((id) => !existingIdSet.has(id))) {
      return res.status(400).json({ error: 'Reorder payload contains unknown items.' });
    }

    await saveSortedIds(db, config.tableName, orderedIds);
    return res.json({ ok: true, message: `${config.label} reordered.` });
  } catch (err) {
    console.error('Content reorder error:', err);
    return res.status(500).json({ error: 'Failed to save the new order.' });
  }
});

// music management
router.get('/music', async (req, res) => {
  const db = req.app.locals.db;
  const publicationStatusFilter = normalizePublicationStatusFilter(req.query.publication_status);
  const trackQueryParams = [];
  let trackQuery = 'SELECT * FROM music';
  if (publicationStatusFilter) {
    trackQuery += ' WHERE publication_status = ?';
    trackQueryParams.push(publicationStatusFilter);
  }
  trackQuery += ' ORDER BY sort_order ASC, id DESC';
  const tracks = await db.all(trackQuery, ...trackQueryParams);
  await attachTagsToItems(db, 'music', tracks);
  const playlists = await db.all('SELECT id, title FROM music_playlists ORDER BY title');
  // build map of track->playlist titles
  const mapping = {};
  const rows = await db.all('SELECT mpi.music_id, mp.id as pid, mp.title FROM music_playlist_items mpi JOIN music_playlists mp ON mp.id = mpi.playlist_id');
  rows.forEach(r => {
    if (!mapping[r.music_id]) mapping[r.music_id] = [];
    mapping[r.music_id].push({ id: r.pid, title: r.title });
  });
  res.render('admin/music/index', {
    tracks,
    playlists,
    trackPlaylists: mapping,
    publicationStatusFilter,
    publicationStatusOptions: PUBLICATION_STATUS_OPTIONS,
  });
});

router.get('/music/new', async (req, res) => {
  const db = req.app.locals.db;
  const playlists = await db.all('SELECT id, title FROM music_playlists ORDER BY title');
  const relationshipOptions = await getAdminRelationshipOptions(db);
  res.render('admin/music/new', {
    playlists,
    publicationStatusOptions: PUBLICATION_STATUS_OPTIONS,
    relationshipOptions,
    relationshipSelections: {
      releaseIds: [],
      relatedVideoIds: [],
      relatedProjectIds: [],
    },
  });
});

router.post('/music/metadata-preview', uploadMusicPreview.single('file'), validateCsrfToken, async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'No audio file provided' });
    }

    const parsed = await parseMusicUploadFromBuffer(req.file.buffer, req.file.originalname, req.file.mimetype);
    return res.json({
      metadata: parsed.metadata,
      coverPreview: parsed.coverPreview,
    });
  } catch (err) {
    console.error('Single upload metadata preview error:', err);
    return res.status(200).json({
      metadata: {
        title: '',
        artist: '',
        album: '',
        year: '',
        track: null,
      },
      coverPreview: null,
    });
  }
});

router.post('/music', uploadMusicFields, validateCsrfToken, async (req, res) => {
  const db = req.app.locals.db;
  const { title, artist, album, year, description, playlist_id, new_playlist_title, tags, slug: rawSlug } = req.body;
  const publicationStatus = normalizePublicationStatus(req.body.publication_status);
  const publishedAt = normalizePublicationTimestamp(req.body.published_at);
  const audioFile = req.files && req.files.file ? req.files.file[0] : null;
  const manualCover = req.files && req.files.cover ? req.files.cover[0] : null;

  let preparedUpload = null;
  let cover = manualCover ? manualCover.filename : '';

  try {
    if (!audioFile) {
      return respondWithUploadError(req, res, {
        redirectTo: '/admin/music/new',
        message: 'Select an audio file to upload.',
      });
    }

    const publicationValidationError = getScheduledPublicationValidationError(publicationStatus, publishedAt);
    if (publicationValidationError) {
      if (manualCover) {
        await deleteUploadedFile(manualCover.filename, 'music');
      }
      if (audioFile && audioFile.filename) {
        await safeDeleteFile(path.join(MUSIC_UPLOAD_DIR, audioFile.filename));
      }
      return respondWithUploadError(req, res, {
        redirectTo: '/admin/music/new',
        message: publicationValidationError,
      });
    }

    preparedUpload = await prepareMusicUploadForPlayback(audioFile, {
      extractCover: !manualCover,
    });

    if (!manualCover && preparedUpload.extractedCoverFilename) {
      cover = preparedUpload.extractedCoverFilename;
    }

    const finalTitle = (title || '').trim() || preparedUpload.metadata.title || (audioFile ? path.parse(audioFile.originalname).name : '');
    const finalArtist = (artist || '').trim() || preparedUpload.metadata.artist || null;
    const finalAlbum = (album || '').trim() || preparedUpload.metadata.album || null;
    const finalYear = (year || '').toString().trim() || preparedUpload.metadata.year || null;
    const { slug, error: slugError } = await resolveOptionalSlug(db, {
      tableName: 'music',
      title: finalTitle,
      rawSlug,
      fallbackPrefix: 'track',
      allowNumericOnly: false,
    });
    if (slugError) {
      if (manualCover) {
        await deleteUploadedFile(manualCover.filename, 'music');
      }
      if (preparedUpload && preparedUpload.playbackFilename) {
        await deleteUploadedFile(preparedUpload.playbackFilename, 'music');
      }
      if (preparedUpload && preparedUpload.extractedCoverFilename && preparedUpload.extractedCoverFilename !== cover) {
        await deleteUploadedFile(preparedUpload.extractedCoverFilename, 'music');
      }
      return respondWithUploadError(req, res, {
        redirectTo: '/admin/music/new',
        message: slugError,
      });
    }
    const nextSortOrder = await getNextSortOrder(db, 'music');
    const finalOrderIndex = preparedUpload.metadata.track || null;

    await db.exec('BEGIN TRANSACTION');
    try {
      let targetPlaylistId = (playlist_id || '').trim();
      if (new_playlist_title && new_playlist_title.trim()) {
        targetPlaylistId = await createMusicPlaylist(db, new_playlist_title, description || null);
      }

      const result = await db.run(
        'INSERT INTO music (title, slug, artist, album, year, description, publication_status, published_at, sort_order, filename, cover_image, order_index, preview_token) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        finalTitle,
        slug,
        finalArtist,
        finalAlbum,
        finalYear,
        description,
        publicationStatus,
        publicationStatus === SCHEDULED_CONTENT_STATUS ? publishedAt : null,
        nextSortOrder,
        preparedUpload.playbackFilename,
        cover,
        finalOrderIndex,
        generatePreviewToken()
      );
      const musicId = result.lastID;

      if (musicId && targetPlaylistId) {
        await assignTrackToPlaylist(db, targetPlaylistId, musicId, preparedUpload.metadata.track || null);
      }

      if (musicId) {
        await syncContentTags(db, 'music', musicId, tags);
        await syncMusicSelections(db, musicId, req.body);
      }

      await db.exec('COMMIT');
    } catch (txErr) {
      await db.exec('ROLLBACK');
      throw txErr;
    }

    return respondWithUploadSuccess(
      req,
      res,
      '/admin/music',
      preparedUpload.convertedToMp3 ? 'Music uploaded and converted to MP3 for faster playback' : 'Music uploaded'
    );
  } catch (err) {
    console.error('Single music upload error:', err);
    if (manualCover) {
      await deleteUploadedFile(manualCover.filename, 'music');
    }
    if (preparedUpload && preparedUpload.playbackFilename) {
      await deleteUploadedFile(preparedUpload.playbackFilename, 'music');
    } else if (audioFile && audioFile.filename) {
      await safeDeleteFile(path.join(MUSIC_UPLOAD_DIR, audioFile.filename));
    }
    if (preparedUpload && preparedUpload.extractedCoverFilename && preparedUpload.extractedCoverFilename !== cover) {
      await deleteUploadedFile(preparedUpload.extractedCoverFilename, 'music');
    }
    return respondWithUploadError(req, res, {
      redirectTo: '/admin/music/new',
      statusCode: 500,
      message: `Failed to upload music: ${err.message || 'Unknown error'}`,
    });
  }
});

// batch music upload
router.get('/music/batch', async (req, res) => {
  const db = req.app.locals.db;
  const playlists = await db.all('SELECT id, title FROM music_playlists ORDER BY title');
  res.render('admin/music/batch', {
    playlists,
    publicationStatusOptions: PUBLICATION_STATUS_OPTIONS,
  });
});

router.post('/music/batch', uploadBatchMusic, validateCsrfToken, async (req, res) => {
  const db = req.app.locals.db;
  const { default_artist, default_album, default_year, shared_description, playlist_id, new_playlist_title } = req.body;
  const publicationStatus = normalizePublicationStatus(req.body.publication_status);
  const publishedAt = normalizePublicationTimestamp(req.body.published_at);
  const files = req.files.files || [];
  const sharedCoverFile = req.files.shared_cover ? req.files.shared_cover[0] : null;

  let targetPlaylistId = playlist_id;
  const preparedTracks = [];

  try {
    if (!files.length) {
      return respondWithUploadError(req, res, {
        redirectTo: '/admin/music/batch',
        message: 'Select at least one audio file to upload.',
      });
    }

    const publicationValidationError = getScheduledPublicationValidationError(publicationStatus, publishedAt);
    if (publicationValidationError) {
      for (const file of files) {
        if (file && file.filename) {
          await safeDeleteFile(path.join(MUSIC_UPLOAD_DIR, file.filename));
        }
      }
      if (sharedCoverFile) {
        await deleteUploadedFile(sharedCoverFile.filename, 'music');
      }
      return respondWithUploadError(req, res, {
        redirectTo: '/admin/music/batch',
        message: publicationValidationError,
      });
    }

    for (const file of files) {
      const prepared = await prepareMusicUploadForPlayback(file, {
        extractCover: !sharedCoverFile,
      });

      preparedTracks.push({
        file,
        prepared,
        coverFilename: sharedCoverFile ? sharedCoverFile.filename : prepared.extractedCoverFilename,
      });
    }

    await db.exec('BEGIN TRANSACTION');
    try {
      if (new_playlist_title && new_playlist_title.trim()) {
        targetPlaylistId = await createMusicPlaylist(db, new_playlist_title, shared_description || null);
      }

      let nextSortOrder = await getNextSortOrder(db, 'music');

      for (const track of preparedTracks) {
        const metadata = track.prepared.metadata;
        const title = metadata.title || path.parse(track.file.originalname).name;
        const artist = metadata.artist || default_artist || null;
        const album = metadata.album || default_album || null;
        const year = metadata.year || default_year || null;
        const orderIndex = metadata.track || null;
        const { slug } = await resolveOptionalSlug(db, {
          tableName: 'music',
          title,
          rawSlug: '',
          fallbackPrefix: 'track',
          allowNumericOnly: false,
        });

        const result = await db.run(
          'INSERT INTO music (title, slug, artist, album, year, publication_status, published_at, sort_order, filename, cover_image, order_index, preview_token) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          title,
          slug,
          artist,
          album,
          year,
          publicationStatus,
          publicationStatus === SCHEDULED_CONTENT_STATUS ? publishedAt : null,
          nextSortOrder,
          track.prepared.playbackFilename,
          track.coverFilename,
          orderIndex,
          generatePreviewToken()
        );
        const musicId = result.lastID;
        nextSortOrder += 1;

        if (targetPlaylistId) {
          await assignTrackToPlaylist(db, targetPlaylistId, musicId, metadata.track || null);
        }
      }
      await db.exec('COMMIT');
    } catch (txErr) {
      await db.exec('ROLLBACK');
      throw txErr;
    }

    const convertedCount = preparedTracks.filter(track => track.prepared.convertedToMp3).length;
    const successMessage = convertedCount > 0
      ? `Batch uploaded ${preparedTracks.length} tracks (${convertedCount} WAV file${convertedCount === 1 ? '' : 's'} converted to MP3)`
      : `Batch uploaded ${preparedTracks.length} tracks`;

    return respondWithUploadSuccess(req, res, '/admin/music', successMessage);
  } catch (err) {
    console.error('Batch music upload error:', err);
    for (const track of preparedTracks) {
      if (track.prepared && track.prepared.playbackFilename) {
        await deleteUploadedFile(track.prepared.playbackFilename, 'music');
      } else if (track.file && track.file.filename) {
        await safeDeleteFile(path.join(MUSIC_UPLOAD_DIR, track.file.filename));
      }
      if (!sharedCoverFile && track.prepared && track.prepared.extractedCoverFilename) {
        await deleteUploadedFile(track.prepared.extractedCoverFilename, 'music');
      }
    }
    if (sharedCoverFile) {
      await deleteUploadedFile(sharedCoverFile.filename, 'music');
    }
    return respondWithUploadError(req, res, {
      redirectTo: '/admin/music/batch',
      statusCode: 500,
      message: `Batch upload failed: ${err.message || 'Unknown error'}`,
    });
  }
});

router.get('/music/:id/edit', async (req, res) => {
  const db = req.app.locals.db;
  const track = await db.get('SELECT * FROM music WHERE id = ?', req.params.id);
  if (!track) return res.redirect('/admin/music');
  await ensurePreviewTokenForRecord(db, 'music', track);
  await attachTagsToItems(db, 'music', [track]);
  const playlists = await db.all('SELECT id, title FROM music_playlists ORDER BY title');
  const existing = await db.all('SELECT playlist_id FROM music_playlist_items WHERE music_id = ?', req.params.id);
  const selected = existing.map(e => e.playlist_id);
  const relationshipOptions = await getAdminRelationshipOptions(db);
  const relationshipSelections = await getMusicSelectionState(db, req.params.id);
  const publicUrl = buildPublicUrl(req, `/music/${track.slug}`);
  res.render('admin/music/edit', {
    track,
    publicUrl,
    previewUrl: buildPreviewUrl(`/music/${track.slug}`, track.preview_token, req),
    playlists,
    selectedPlaylists: selected,
    publicationStatusOptions: PUBLICATION_STATUS_OPTIONS,
    relationshipOptions,
    relationshipSelections,
  });
});

router.put('/music/:id', uploadMusicFields, validateCsrfToken, async (req, res) => {
  const db = req.app.locals.db;
  const { title, artist, album, year, description, playlists, tags, slug: rawSlug } = req.body;
  const publicationStatus = normalizePublicationStatus(req.body.publication_status);
  const publishedAt = normalizePublicationTimestamp(req.body.published_at);
  const audioFile = req.files && req.files.file ? req.files.file[0] : null;
  const cover = req.files && req.files.cover ? req.files.cover[0].filename : null;
  const track = await db.get('SELECT * FROM music WHERE id = ?', req.params.id);
  const trackId = parseInt(req.params.id, 10);

  let preparedAudio = null;

  try {
    const publicationValidationError = getScheduledPublicationValidationError(publicationStatus, publishedAt);
    if (publicationValidationError) {
      if (cover) {
        await deleteUploadedFile(cover, 'music');
      }
      if (audioFile && audioFile.filename) {
        await deleteUploadedFile(audioFile.filename, 'music');
      }
      req.flash('error', publicationValidationError);
      return res.redirect(`/admin/music/${req.params.id}/edit`);
    }

    if (audioFile) {
      preparedAudio = await prepareMusicUploadForPlayback(audioFile, { extractCover: false });
    }

    const filename = preparedAudio ? preparedAudio.playbackFilename : track.filename;
    const coverImage = cover || track.cover_image;
    const { slug, error: slugError } = await resolveOptionalSlug(db, {
      tableName: 'music',
      title,
      rawSlug,
      fallbackPrefix: 'track',
      allowNumericOnly: false,
      ignoreId: req.params.id,
      idForFallback: req.params.id,
    });
    if (slugError) {
      if (cover) {
        await deleteUploadedFile(cover, 'music');
      }
      if (preparedAudio && preparedAudio.playbackFilename) {
        await deleteUploadedFile(preparedAudio.playbackFilename, 'music');
      } else if (audioFile && audioFile.filename) {
        await safeDeleteFile(path.join(MUSIC_UPLOAD_DIR, audioFile.filename));
      }
      req.flash('error', slugError);
      return res.redirect(`/admin/music/${req.params.id}/edit`);
    }
    await db.exec('BEGIN TRANSACTION');
    try {
      await db.run(
        'UPDATE music SET title=?, slug=?, artist=?, album=?, year=?, description=?, publication_status=?, published_at=?, filename=?, cover_image=?, order_index=? WHERE id=?',
        title, slug, artist, album, year, description, publicationStatus, publicationStatus === SCHEDULED_CONTENT_STATUS ? publishedAt : null, filename, coverImage, track.order_index || null, req.params.id
      );

      await db.run('DELETE FROM music_playlist_items WHERE music_id = ?', req.params.id);
      if (playlists) {
        const arr = Array.isArray(playlists) ? playlists : [playlists];
        for (const pid of arr) {
          const maxOrder = await db.get('SELECT MAX(order_index) as max_order FROM music_playlist_items WHERE playlist_id = ?', pid);
          const nextOrder = (maxOrder.max_order || 0) + 1;
          await db.run('INSERT INTO music_playlist_items (playlist_id, music_id, order_index) VALUES (?,?,?)', pid, req.params.id, nextOrder);
        }
      }

      await syncContentTags(db, 'music', req.params.id, tags);
  await syncMusicSelections(db, req.params.id, req.body);
      await db.exec('COMMIT');
    } catch (txErr) {
      await db.exec('ROLLBACK');
      throw txErr;
    }

    if (preparedAudio && track.filename && filename !== track.filename) {
      await deleteUploadedFile(track.filename, 'music');
    }
    if (cover && track.cover_image && cover !== track.cover_image) {
      await deleteMusicCoverIfUnreferenced(db, track.cover_image, trackId);
    }

    req.flash('success', preparedAudio && preparedAudio.convertedToMp3 ? 'Track updated and converted to MP3 for faster playback' : 'Track updated');
    res.redirect('/admin/music');
  } catch (err) {
    console.error('Track update error:', err);
    if (cover) {
      await deleteUploadedFile(cover, 'music');
    }
    if (preparedAudio && preparedAudio.playbackFilename) {
      await deleteUploadedFile(preparedAudio.playbackFilename, 'music');
    } else if (audioFile && audioFile.filename) {
      await safeDeleteFile(path.join(MUSIC_UPLOAD_DIR, audioFile.filename));
    }
    req.flash('error', `Failed to update track: ${err.message || 'Unknown error'}`);
    res.redirect(`/admin/music/${req.params.id}/edit`);
  }
});

router.delete('/music/:id', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const musicId = parseInt(req.params.id);
    await deleteMusicRecord(db, musicId);
    
    req.flash('success', 'Track deleted');
    res.redirect('/admin/music');
  } catch (err) {
    console.error('Music deletion error:', err);
    req.flash('error', 'Failed to delete track');
    res.redirect('/admin/music');
  }
});

router.post('/music/bulk-delete', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const ids = normalizeSelectedIds(req.body.selected_ids);
    if (!ids.length) {
      req.flash('error', 'Select at least one track to delete.');
      return res.redirect('/admin/music');
    }

    const result = await bulkDeleteRecords(ids, (musicId) => deleteMusicRecord(db, musicId));
    if (result.deleted > 0 && result.failed === 0) {
      req.flash('success', buildBulkDeleteMessage(result, 'track', 'tracks'));
    } else {
      req.flash('error', buildBulkDeleteMessage(result, 'track', 'tracks') || 'Failed to delete selected tracks.');
    }
    return res.redirect('/admin/music');
  } catch (err) {
    console.error('Bulk music deletion error:', err);
    req.flash('error', 'Failed to delete selected tracks.');
    return res.redirect('/admin/music');
  }
});

router.post('/music/bulk-playlist-add', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const playlistId = parseInt(req.body.playlist_id, 10);
    const trackIds = normalizeSelectedIds(req.body.selected_ids);

    if (Number.isNaN(playlistId) || playlistId <= 0) {
      req.flash('error', 'Choose a playlist before adding tracks.');
      return res.redirect('/admin/music');
    }

    if (!trackIds.length) {
      req.flash('error', 'Select at least one track to add to a playlist.');
      return res.redirect('/admin/music');
    }

    const playlist = await db.get('SELECT id, title FROM music_playlists WHERE id = ?', playlistId);
    if (!playlist) {
      req.flash('error', 'Playlist not found.');
      return res.redirect('/admin/music');
    }

    const validTracks = await db.all(
      `SELECT id
       FROM music
       WHERE id IN (${trackIds.map(() => '?').join(',')})`,
      ...trackIds
    );
    const validTrackIds = validTracks.map((track) => track.id);

    if (!validTrackIds.length) {
      req.flash('error', 'No valid tracks were selected.');
      return res.redirect('/admin/music');
    }

    let addedCount = 0;
    let skippedCount = 0;

    await db.exec('BEGIN TRANSACTION');
    try {
      for (const trackId of validTrackIds) {
        const wasAdded = await assignTrackToPlaylist(db, playlistId, trackId);
        if (wasAdded) {
          addedCount += 1;
        } else {
          skippedCount += 1;
        }
      }
      await db.exec('COMMIT');
    } catch (txErr) {
      await db.exec('ROLLBACK');
      throw txErr;
    }

    if (addedCount > 0) {
      const skipMessage = skippedCount > 0 ? ` ${skippedCount} already existed.` : '';
      req.flash('success', `Added ${addedCount} ${addedCount === 1 ? 'track' : 'tracks'} to ${playlist.title}.${skipMessage}`);
    } else {
      req.flash('info', `All selected tracks are already in ${playlist.title}.`);
    }

    return res.redirect('/admin/music');
  } catch (err) {
    console.error('Bulk music playlist add error:', err);
    req.flash('error', 'Failed to add selected tracks to the playlist.');
    return res.redirect('/admin/music');
  }
});

// video management
router.get('/videos', async (req, res) => {
  const db = req.app.locals.db;
  const publicationStatusFilter = normalizePublicationStatusFilter(req.query.publication_status);
  const videoQueryParams = [];
  let videoQuery = 'SELECT * FROM videos';
  if (publicationStatusFilter) {
    videoQuery += ' WHERE publication_status = ?';
    videoQueryParams.push(publicationStatusFilter);
  }
  videoQuery += ' ORDER BY sort_order ASC, id DESC';
  const videos = await db.all(videoQuery, ...videoQueryParams);
  await attachTagsToItems(db, 'videos', videos);
  const playlists = await db.all('SELECT id, title FROM video_playlists ORDER BY title');
  const mapping = {};
  const rows = await db.all('SELECT vpi.video_id, vp.id as pid, vp.title FROM video_playlist_items vpi JOIN video_playlists vp ON vp.id = vpi.playlist_id');
  rows.forEach(r => {
    if (!mapping[r.video_id]) mapping[r.video_id] = [];
    mapping[r.video_id].push({ id: r.pid, title: r.title });
  });
  res.render('admin/videos/index', {
    videos,
    playlists,
    videoPlaylists: mapping,
    publicationStatusFilter,
    publicationStatusOptions: PUBLICATION_STATUS_OPTIONS,
  });
});

router.get('/videos/new', async (req, res) => {
  const db = req.app.locals.db;
  const playlists = await db.all('SELECT id, title FROM video_playlists ORDER BY title');
  const relationshipOptions = await getAdminRelationshipOptions(db);
  res.render('admin/videos/new', {
    playlists,
    publicationStatusOptions: PUBLICATION_STATUS_OPTIONS,
    relationshipOptions,
    relationshipSelections: {
      releaseIds: [],
    },
  });
});

router.post('/videos', uploadVideoFields, validateCsrfToken, async (req, res) => {
  const db = req.app.locals.db;
  const { title, description, category, playlists, tags, slug: rawSlug } = req.body;
  const publicationStatus = normalizePublicationStatus(req.body.publication_status);
  const publishedAt = normalizePublicationTimestamp(req.body.published_at);
  const filename = req.files && req.files.file ? req.files.file[0].filename : null;

  if (!filename) {
    req.flash('error', 'A local video file is required. External embeds are no longer supported.');
    return res.redirect('/admin/videos/new');
  }

  const publicationValidationError = getScheduledPublicationValidationError(publicationStatus, publishedAt);
  if (publicationValidationError) {
    if (filename) {
      await deleteUploadedFile(filename, 'videos');
    }
    req.flash('error', publicationValidationError);
    return res.redirect('/admin/videos/new');
  }

  let thumbnail = null;
  const nextSortOrder = await getNextSortOrder(db, 'videos');
  const { slug, error: slugError } = await resolveOptionalSlug(db, {
    tableName: 'videos',
    title,
    rawSlug,
    fallbackPrefix: 'video',
    allowNumericOnly: false,
  });

  if (slugError) {
    if (filename) {
      await deleteUploadedFile(filename, 'videos');
    }
    req.flash('error', slugError);
    return res.redirect('/admin/videos/new');
  }
  
  // generate thumbnail from video if provided
  if (filename) {
    try {
      const videoPath = path.join('uploads/videos', filename);
      const thumbFilename = Date.now() + '.jpg';
      const thumbnailPath = path.join('uploads/videos', thumbFilename);
      await generateVideoThumbnail(videoPath, thumbnailPath);
      thumbnail = thumbFilename;
    } catch (err) {
      console.error('Thumbnail generation failed:', err);
      // continue without thumbnail
    }
  }
  
  const result = await db.run(
    'INSERT INTO videos (title, slug, description, publication_status, published_at, sort_order, filename, thumbnail, category, preview_token) VALUES (?,?,?,?,?,?,?,?,?,?)',
    title, slug, description, publicationStatus, publicationStatus === SCHEDULED_CONTENT_STATUS ? publishedAt : null, nextSortOrder, filename, thumbnail, category, generatePreviewToken()
  );
  const videoId = result.lastID;
  if (videoId && playlists) {
    const arr = Array.isArray(playlists) ? playlists : [playlists];
    for (const pid of arr) {
      const maxOrder = await db.get('SELECT MAX(order_index) as max_order FROM video_playlist_items WHERE playlist_id = ?', pid);
      const nextOrder = (maxOrder.max_order || 0) + 1;
      await db.run('INSERT OR IGNORE INTO video_playlist_items (playlist_id, video_id, order_index) VALUES (?,?,?)', pid, videoId, nextOrder);
    }
  }
  if (videoId) {
    await syncContentTags(db, 'videos', videoId, tags);
    await syncVideoSelections(db, videoId, req.body);
  }
  req.flash('success', 'Video added');
  res.redirect('/admin/videos');
});

router.get('/videos/:id/edit', async (req, res) => {
  const db = req.app.locals.db;
  const video = await db.get('SELECT * FROM videos WHERE id = ?', req.params.id);
  if (!video) return res.redirect('/admin/videos');
  await ensurePreviewTokenForRecord(db, 'videos', video);
  await attachTagsToItems(db, 'videos', [video]);
  const playlists = await db.all('SELECT id, title FROM video_playlists ORDER BY title');
  const existing = await db.all('SELECT playlist_id FROM video_playlist_items WHERE video_id = ?', req.params.id);
  const selected = existing.map(e => e.playlist_id);
  const relationshipOptions = await getAdminRelationshipOptions(db);
  const relationshipSelections = await getVideoSelectionState(db, req.params.id);
  const publicUrl = buildPublicUrl(req, `/videos/${video.slug}`);
  res.render('admin/videos/edit', {
    video,
    publicUrl,
    previewUrl: buildPreviewUrl(`/videos/${video.slug}`, video.preview_token, req),
    playlists,
    selectedPlaylists: selected,
    publicationStatusOptions: PUBLICATION_STATUS_OPTIONS,
    relationshipOptions,
    relationshipSelections,
  });
});

router.put('/videos/:id', uploadVideoFields, validateCsrfToken, async (req, res) => {
  const db = req.app.locals.db;
  const { title, description, category, playlists, tags, slug: rawSlug } = req.body;
  const publicationStatus = normalizePublicationStatus(req.body.publication_status);
  const publishedAt = normalizePublicationTimestamp(req.body.published_at);
  const file = req.files && req.files.file ? req.files.file[0].filename : null;
  const video = await db.get('SELECT * FROM videos WHERE id = ?', req.params.id);

  if (!video) {
    req.flash('error', 'Video not found');
    return res.redirect('/admin/videos');
  }

  if (!file && !video.filename) {
    req.flash('error', 'This legacy embedded video no longer has a playable local file. Upload a video file to keep it.');
    return res.redirect(`/admin/videos/${req.params.id}/edit`);
  }

  const { slug, error: slugError } = await resolveOptionalSlug(db, {
    tableName: 'videos',
    title,
    rawSlug,
    fallbackPrefix: 'video',
    allowNumericOnly: false,
    ignoreId: req.params.id,
    idForFallback: req.params.id,
  });

  if (slugError) {
    if (file && file !== video.filename) {
      await deleteUploadedFile(file, 'videos');
    }
    req.flash('error', slugError);
    return res.redirect(`/admin/videos/${req.params.id}/edit`);
  }

  const publicationValidationError = getScheduledPublicationValidationError(publicationStatus, publishedAt);
  if (publicationValidationError) {
    if (file && file !== video.filename) {
      await deleteUploadedFile(file, 'videos');
    }
    req.flash('error', publicationValidationError);
    return res.redirect(`/admin/videos/${req.params.id}/edit`);
  }
  
  // Delete old video file if being replaced
  if (file && video.filename && file !== video.filename) {
    await deleteUploadedFile(video.filename, 'videos');
  }
  
  const filename = file || video.filename;
  let thumbnail = video.thumbnail;
  
  // if new video file provided, regenerate thumbnail
  if (file) {
    try {
      const videoPath = path.join('uploads/videos', filename);
      const thumbFilename = Date.now() + '.jpg';
      const thumbnailPath = path.join('uploads/videos', thumbFilename);
      await generateVideoThumbnail(videoPath, thumbnailPath);
      
      // Delete old thumbnail if we generated a new one
      if (thumbnail && thumbnail !== thumbFilename) {
        await deleteUploadedFile(thumbnail, 'videos');
      }
      
      thumbnail = thumbFilename;
    } catch (err) {
      console.error('Thumbnail generation failed:', err);
      // keep existing thumbnail
    }
  }
  
  const cat = category || video.category;
  await db.run(
    'UPDATE videos SET title=?, slug=?, description=?, publication_status=?, published_at=?, filename=?, thumbnail=?, category=? WHERE id=?',
    title, slug, description, publicationStatus, publicationStatus === SCHEDULED_CONTENT_STATUS ? publishedAt : null, filename, thumbnail, cat, req.params.id
  );
  // update playlist items
  await db.run('DELETE FROM video_playlist_items WHERE video_id = ?', req.params.id);
  if (playlists) {
    const arr = Array.isArray(playlists) ? playlists : [playlists];
    for (const pid of arr) {
      const maxOrder = await db.get('SELECT MAX(order_index) as max_order FROM video_playlist_items WHERE playlist_id = ?', pid);
      const nextOrder = (maxOrder.max_order || 0) + 1;
      await db.run('INSERT INTO video_playlist_items (playlist_id, video_id, order_index) VALUES (?,?,?)', pid, req.params.id, nextOrder);
    }
  }
  await syncContentTags(db, 'videos', req.params.id, tags);
  await syncVideoSelections(db, req.params.id, req.body);
  req.flash('success', 'Video updated');
  res.redirect('/admin/videos');
});

router.delete('/videos/:id', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const videoId = parseInt(req.params.id);
    await deleteVideoRecord(db, videoId);
    
    req.flash('success', 'Video deleted');
    res.redirect('/admin/videos');
  } catch (err) {
    console.error('Video deletion error:', err);
    req.flash('error', 'Failed to delete video');
    res.redirect('/admin/videos');
  }
});

router.post('/videos/bulk-delete', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const ids = normalizeSelectedIds(req.body.selected_ids);
    if (!ids.length) {
      req.flash('error', 'Select at least one video to delete.');
      return res.redirect('/admin/videos');
    }

    const result = await bulkDeleteRecords(ids, (videoId) => deleteVideoRecord(db, videoId));
    if (result.deleted > 0 && result.failed === 0) {
      req.flash('success', buildBulkDeleteMessage(result, 'video', 'videos'));
    } else {
      req.flash('error', buildBulkDeleteMessage(result, 'video', 'videos') || 'Failed to delete selected videos.');
    }
    return res.redirect('/admin/videos');
  } catch (err) {
    console.error('Bulk video deletion error:', err);
    req.flash('error', 'Failed to delete selected videos.');
    return res.redirect('/admin/videos');
  }
});

// gallery management
router.get('/gallery', async (req, res) => {
  const db = req.app.locals.db;
  const publicationStatusFilter = normalizePublicationStatusFilter(req.query.publication_status);
  const galleryQueryParams = [];
  let galleryQuery = 'SELECT * FROM gallery';
  if (publicationStatusFilter) {
    galleryQuery += ' WHERE publication_status = ?';
    galleryQueryParams.push(publicationStatusFilter);
  }
  galleryQuery += ' ORDER BY sort_order ASC, id DESC';
  const images = await db.all(galleryQuery, ...galleryQueryParams);
  await attachTagsToItems(db, 'gallery', images);
  const collections = await db.all('SELECT id, title FROM gallery_collections ORDER BY title');
  const mapping = {};
  const rows = await db.all('SELECT gci.gallery_id, gc.id as cid, gc.title FROM gallery_collection_items gci JOIN gallery_collections gc ON gc.id = gci.collection_id');
  rows.forEach(r => {
    if (!mapping[r.gallery_id]) mapping[r.gallery_id] = [];
    mapping[r.gallery_id].push({ id: r.cid, title: r.title });
  });
  res.render('admin/gallery/index', {
    images,
    collections,
    imageCollections: mapping,
    publicationStatusFilter,
    publicationStatusOptions: PUBLICATION_STATUS_OPTIONS,
  });
});

router.get('/gallery/new', async (req, res) => {
  const db = req.app.locals.db;
  const collections = await db.all('SELECT id, title FROM gallery_collections ORDER BY title');
  const relationshipOptions = await getAdminRelationshipOptions(db);
  res.render('admin/gallery/new', {
    collections,
    publicationStatusOptions: PUBLICATION_STATUS_OPTIONS,
    relationshipOptions,
    relationshipSelections: {
      releaseIds: [],
      relatedProjectIds: [],
    },
  });
});

router.post('/gallery', uploadImage.single('file'), validateCsrfToken, async (req, res) => {
  const db = req.app.locals.db;
  const { title, caption, category, collections, tags, slug: rawSlug } = req.body;
  const publicationStatus = normalizePublicationStatus(req.body.publication_status);
  const publishedAt = normalizePublicationTimestamp(req.body.published_at);
  const nextSortOrder = await getNextSortOrder(db, 'gallery');
  const uploadedImage = req.file || null;
  const filename = uploadedImage ? uploadedImage.filename : null;
  const publicationValidationError = getScheduledPublicationValidationError(publicationStatus, publishedAt);
  if (publicationValidationError) {
    if (filename) {
      await deleteUploadedFile(filename, 'images');
    }
    req.flash('error', publicationValidationError);
    return res.redirect('/admin/gallery/new');
  }
  const finalTitle = (title || '').trim() || await deriveTitleFromUploadedImage('images', uploadedImage);
  if (!finalTitle) {
    if (filename) {
      await deleteUploadedFile(filename, 'images');
    }
    req.flash('error', 'Image title is required');
    return res.redirect('/admin/gallery/new');
  }
  const { slug, error: slugError } = await resolveOptionalSlug(db, {
    tableName: 'gallery',
    title: finalTitle,
    rawSlug,
    fallbackPrefix: 'image',
    allowNumericOnly: false,
  });
  if (slugError) {
    if (filename) {
      await deleteUploadedFile(filename, 'images');
    }
    req.flash('error', slugError);
    return res.redirect('/admin/gallery/new');
  }
  const result = await db.run(
    'INSERT INTO gallery (title, slug, caption, publication_status, published_at, sort_order, filename, category, preview_token) VALUES (?,?,?,?,?,?,?,?,?)',
    finalTitle, slug, caption, publicationStatus, publicationStatus === SCHEDULED_CONTENT_STATUS ? publishedAt : null, nextSortOrder, filename, category, generatePreviewToken()
  );
  const imageId = result.lastID;
  if (imageId && collections) {
    const arr = Array.isArray(collections) ? collections : [collections];
    for (const cid of arr) {
      const maxOrder = await db.get('SELECT MAX(order_index) as max_order FROM gallery_collection_items WHERE collection_id = ?', cid);
      const nextOrder = (maxOrder.max_order || 0) + 1;
      await db.run('INSERT OR IGNORE INTO gallery_collection_items (collection_id, gallery_id, order_index) VALUES (?,?,?)', cid, imageId, nextOrder);
    }
  }
  if (imageId) {
    await syncContentTags(db, 'gallery', imageId, tags);
    await syncGallerySelections(db, imageId, req.body);
  }
  req.flash('success', 'Image uploaded');
  res.redirect('/admin/gallery');
});

router.get('/gallery/:id/edit', async (req, res) => {
  const db = req.app.locals.db;
  const img = await db.get('SELECT * FROM gallery WHERE id = ?', req.params.id);
  if (!img) return res.redirect('/admin/gallery');
  await ensurePreviewTokenForRecord(db, 'gallery', img);
  await attachTagsToItems(db, 'gallery', [img]);
  const collections = await db.all('SELECT id, title FROM gallery_collections ORDER BY title');
  const existing = await db.all('SELECT collection_id FROM gallery_collection_items WHERE gallery_id = ?', req.params.id);
  const selected = existing.map(e => e.collection_id);
  const relationshipOptions = await getAdminRelationshipOptions(db);
  const relationshipSelections = await getGallerySelectionState(db, req.params.id);
  const publicUrl = buildPublicUrl(req, `/gallery/${img.slug}`);
  res.render('admin/gallery/edit', {
    img,
    publicUrl,
    previewUrl: buildPreviewUrl(`/gallery/${img.slug}`, img.preview_token, req),
    collections,
    collectionIds: selected,
    publicationStatusOptions: PUBLICATION_STATUS_OPTIONS,
    relationshipOptions,
    relationshipSelections,
  });
});

router.put('/gallery/:id', uploadImage.single('file'), validateCsrfToken, async (req, res) => {
  const db = req.app.locals.db;
  const { title, caption, category, collections, tags, slug: rawSlug } = req.body;
  const publicationStatus = normalizePublicationStatus(req.body.publication_status);
  const publishedAt = normalizePublicationTimestamp(req.body.published_at);
  const uploadedImage = req.file || null;
  const file = uploadedImage ? uploadedImage.filename : null;
  const img = await db.get('SELECT * FROM gallery WHERE id = ?', req.params.id);
  if (!img) {
    if (file) {
      await deleteUploadedFile(file, 'images');
    }
    req.flash('error', 'Image not found');
    return res.redirect('/admin/gallery');
  }
  const finalTitle = (title || '').trim() || await deriveTitleFromUploadedImage('images', uploadedImage) || (img.title || '').trim();
  const publicationValidationError = getScheduledPublicationValidationError(publicationStatus, publishedAt);
  if (publicationValidationError) {
    if (file && file !== img.filename) {
      await deleteUploadedFile(file, 'images');
    }
    req.flash('error', publicationValidationError);
    return res.redirect(`/admin/gallery/${req.params.id}/edit`);
  }
  const { slug, error: slugError } = await resolveOptionalSlug(db, {
    tableName: 'gallery',
    title: finalTitle,
    rawSlug,
    fallbackPrefix: 'image',
    allowNumericOnly: false,
    ignoreId: req.params.id,
    idForFallback: req.params.id,
  });
  if (slugError) {
    if (file && file !== img.filename) {
      await deleteUploadedFile(file, 'images');
    }
    req.flash('error', slugError);
    return res.redirect(`/admin/gallery/${req.params.id}/edit`);
  }
  
  // Delete old image file if being replaced
  if (file && img.filename && file !== img.filename) {
    await deleteUploadedFile(img.filename, 'images');
  }
  
  const filename = file || img.filename;
  await db.run(
    'UPDATE gallery SET title=?, slug=?, caption=?, publication_status=?, published_at=?, category=?, filename=? WHERE id=?',
    finalTitle, slug, caption, publicationStatus, publicationStatus === SCHEDULED_CONTENT_STATUS ? publishedAt : null, category, filename, req.params.id
  );
  // update collection assignments only when the field is explicitly submitted
  if (Object.prototype.hasOwnProperty.call(req.body, 'collections')) {
    await db.run('DELETE FROM gallery_collection_items WHERE gallery_id = ?', req.params.id);
  }
  if (collections) {
    const arr = Array.isArray(collections) ? collections : [collections];
    for (const cid of arr) {
      const maxOrder = await db.get('SELECT MAX(order_index) as max_order FROM gallery_collection_items WHERE collection_id = ?', cid);
      const nextOrder = (maxOrder.max_order || 0) + 1;
      await db.run('INSERT INTO gallery_collection_items (collection_id, gallery_id, order_index) VALUES (?,?,?)', cid, req.params.id, nextOrder);
    }
  }
  await syncContentTags(db, 'gallery', req.params.id, tags);
  await syncGallerySelections(db, req.params.id, req.body);
  req.flash('success', 'Image updated');
  res.redirect('/admin/gallery');
});

router.delete('/gallery/:id', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const galleryId = parseInt(req.params.id);
    await deleteGalleryRecord(db, galleryId);
    
    req.flash('success', 'Image deleted');
    res.redirect('/admin/gallery');
  } catch (err) {
    console.error('Gallery deletion error:', err);
    req.flash('error', 'Failed to delete image');
    res.redirect('/admin/gallery');
  }
});

router.post('/gallery/bulk-delete', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const ids = normalizeSelectedIds(req.body.selected_ids);
    if (!ids.length) {
      req.flash('error', 'Select at least one image to delete.');
      return res.redirect('/admin/gallery');
    }

    const result = await bulkDeleteRecords(ids, (galleryId) => deleteGalleryRecord(db, galleryId));
    if (result.deleted > 0 && result.failed === 0) {
      req.flash('success', buildBulkDeleteMessage(result, 'image', 'images'));
    } else {
      req.flash('error', buildBulkDeleteMessage(result, 'image', 'images') || 'Failed to delete selected images.');
    }
    return res.redirect('/admin/gallery');
  } catch (err) {
    console.error('Bulk gallery deletion error:', err);
    req.flash('error', 'Failed to delete selected images.');
    return res.redirect('/admin/gallery');
  }
});

// projects management
router.get('/projects', async (req, res) => {
  const db = req.app.locals.db;
  const publicationStatusFilter = normalizePublicationStatusFilter(req.query.publication_status);
  const projectQueryParams = [];
  let projectQuery = 'SELECT * FROM projects';
  if (publicationStatusFilter) {
    projectQuery += ' WHERE publication_status = ?';
    projectQueryParams.push(publicationStatusFilter);
  }
  projectQuery += ' ORDER BY sort_order ASC, id DESC';
  const projects = await db.all(projectQuery, ...projectQueryParams);
  await attachTagsToItems(db, 'projects', projects);
  projects.forEach((project) => {
    project.projectStatusLabel = formatProjectStatusLabel(project.project_status);
  });
  const collections = await db.all('SELECT id, title FROM project_collections ORDER BY title');
  const mapping = {};
  const rows = await db.all('SELECT pci.project_id, pc.id as cid, pc.title FROM project_collection_items pci JOIN project_collections pc ON pc.id = pci.collection_id');
  rows.forEach(r => {
    if (!mapping[r.project_id]) mapping[r.project_id] = [];
    mapping[r.project_id].push({ id: r.cid, title: r.title });
  });
  const updateCounts = {};
  const updateCountRows = await db.all('SELECT project_id, COUNT(*) AS count FROM project_updates GROUP BY project_id');
  updateCountRows.forEach((row) => {
    updateCounts[row.project_id] = Number(row.count) || 0;
  });
  res.render('admin/projects/index', {
    projects,
    collections,
    projectCollections: mapping,
    projectUpdateCounts: updateCounts,
    publicationStatusFilter,
    publicationStatusOptions: PUBLICATION_STATUS_OPTIONS,
  });
});

router.get('/projects/new', async (req, res) => {
  const db = req.app.locals.db;
  const collections = await db.all('SELECT id, title FROM project_collections ORDER BY title');
  const relationshipOptions = await getAdminRelationshipOptions(db);
  res.render('admin/projects/new', {
    collections,
    publicationStatusOptions: PUBLICATION_STATUS_OPTIONS,
    projectStatusOptions: PROJECT_STATUS_OPTIONS,
    relationshipOptions,
    relationshipSelections: {
      releaseIds: [],
      relatedTrackIds: [],
      relatedVideoIds: [],
      relatedGalleryIds: [],
    },
  });
});

router.post('/projects', uploadProjectWithDocs, validateCsrfToken, async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { title, summary, description, tags, slug: rawSlug } = req.body;
    const publicationStatus = normalizePublicationStatus(req.body.publication_status);
    const publishedAt = publicationStatus === SCHEDULED_CONTENT_STATUS
      ? normalizePublicationTimestamp(req.body.published_at)
      : null;
    const projectStatus = normalizeProjectStatus(req.body.project_status);
    const heroFile = req.files && req.files.hero_image ? req.files.hero_image[0] : null;
    const finalTitle = (title || '').trim() || await deriveTitleFromUploadedImage('projects', heroFile);
    
    if (!finalTitle) {
      await cleanupUploadedRequestFiles(req.files, {
        hero_image: 'projects',
        documents: 'documents',
      });
      req.flash('error', 'Project title is required');
      return res.redirect('/admin/projects/new');
    }

    const publicationValidationError = getScheduledPublicationValidationError(publicationStatus, publishedAt);
    if (publicationValidationError) {
      await cleanupUploadedRequestFiles(req.files, {
        hero_image: 'projects',
        documents: 'documents',
      });
      req.flash('error', publicationValidationError);
      return res.redirect('/admin/projects/new');
    }
    
    const { slug, error: slugError } = await resolveOptionalSlug(db, {
      tableName: 'projects',
      title: finalTitle,
      rawSlug,
      fallbackPrefix: 'project',
      allowNumericOnly: true,
    });
    if (slugError) {
      if (req.files && req.files.hero_image) {
        for (const file of req.files.hero_image) {
          await deleteUploadedFile(file.filename, 'projects');
        }
      }
      if (req.files && req.files.documents) {
        for (const file of req.files.documents) {
          await deleteUploadedFile(file.filename, 'documents');
        }
      }
      req.flash('error', slugError);
      return res.redirect('/admin/projects/new');
    }
    const nextSortOrder = await getNextSortOrder(db, 'projects');
    const hero = heroFile ? heroFile.filename : null;
    // Create project
    const result = await db.run(
      `INSERT INTO projects (
        title, slug, summary, description, project_status, publication_status, published_at,
        sort_order, tags, hero_image, preview_token
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      finalTitle,
      slug,
      summary,
      description,
      projectStatus,
      publicationStatus,
      publicationStatus === SCHEDULED_CONTENT_STATUS ? publishedAt : null,
      nextSortOrder,
      tags,
      hero,
      generatePreviewToken()
    );
    const projectId = result.lastID;
    
    // Add documents if provided
    if (projectId && req.files && req.files.documents && Array.isArray(req.files.documents)) {
      for (const file of req.files.documents) {
        await db.run('INSERT INTO project_documents (project_id, filename, original_name) VALUES (?,?,?)', projectId, file.filename, file.originalname);
      }
    }
    // assign to collections if any
    if (projectId && req.body.collections) {
      const arr = Array.isArray(req.body.collections) ? req.body.collections : [req.body.collections];
      for (const cid of arr) {
        const maxOrder = await db.get('SELECT MAX(order_index) as max_order FROM project_collection_items WHERE collection_id = ?', cid);
        const nextOrder = (maxOrder.max_order || 0) + 1;
        await db.run('INSERT OR IGNORE INTO project_collection_items (collection_id, project_id, order_index) VALUES (?,?,?)', cid, projectId, nextOrder);
      }
    }

    if (projectId) {
      await syncContentTags(db, 'projects', projectId, tags);
      await syncProjectSelections(db, projectId, req.body);
    }
    
    req.flash('success', 'Project created');
    res.redirect('/admin/projects');
  } catch (err) {
    console.error('Project creation error:', err);
    req.flash('error', 'Failed to create project: ' + (err.message || 'Unknown error'));
    res.redirect('/admin/projects/new');
  }
});

router.get('/projects/:id/edit', async (req, res) => {
  const db = req.app.locals.db;
  const projId = parseInt(req.params.id);
  const proj = await db.get('SELECT * FROM projects WHERE id = ?', projId);
  if (!proj) return res.redirect('/admin/projects');
  await ensurePreviewTokenForRecord(db, 'projects', proj);
  await attachTagsToItems(db, 'projects', [proj]);
  proj.projectStatusLabel = formatProjectStatusLabel(proj.project_status);
  
  const updates = await db.all(
    `SELECT pu.*
     FROM project_updates pu
     WHERE pu.project_id = ?
     ORDER BY pu.is_pinned DESC, pu.created_at DESC, pu.id DESC`,
    projId
  );
  
  // Load attachments for each update
  for (const update of updates) {
    update.attachments = await db.all('SELECT * FROM project_update_attachments WHERE update_id = ?', update.id);
  }
  // fetch collection memberships
  const existingCols = await db.all('SELECT collection_id FROM project_collection_items WHERE project_id = ?', projId);
  const colIds = existingCols.map(r => r.collection_id);
  const collections = await db.all('SELECT id, title FROM project_collections ORDER BY title');
  const relationshipOptions = await getAdminRelationshipOptions(db);
  const relationshipSelections = await getProjectSelectionState(db, projId);
  const publicUrl = buildPublicUrl(req, `/projects/${proj.slug}`);
  res.render('admin/projects/edit', {
    proj,
    updates,
    collectionIds: colIds,
    collections,
    publicUrl,
    previewUrl: buildPreviewUrl(`/projects/${proj.slug}`, proj.preview_token, req),
    publicationStatusOptions: PUBLICATION_STATUS_OPTIONS,
    projectStatusOptions: PROJECT_STATUS_OPTIONS,
    relationshipOptions,
    relationshipSelections,
  });
});

router.put('/projects/:id', uploadProjectWithDocs, validateCsrfToken, async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { title, summary, description, tags, slug: rawSlug } = req.body;
    const publicationStatus = normalizePublicationStatus(req.body.publication_status);
    const publishedAt = publicationStatus === SCHEDULED_CONTENT_STATUS
      ? normalizePublicationTimestamp(req.body.published_at)
      : null;
    const projectStatus = normalizeProjectStatus(req.body.project_status);
    const projId = parseInt(req.params.id);
    const proj = await db.get('SELECT * FROM projects WHERE id = ?', projId);
    if (!proj) {
      if (req.files && req.files.hero_image) {
        for (const file of req.files.hero_image) {
          await deleteUploadedFile(file.filename, 'projects');
        }
      }
      if (req.files && req.files.documents) {
        for (const file of req.files.documents) {
          await deleteUploadedFile(file.filename, 'documents');
        }
      }
      req.flash('error', 'Project not found');
      return res.redirect('/admin/projects');
    }
    const heroFile = req.files && req.files.hero_image ? req.files.hero_image[0] : null;
    const finalTitle = (title || '').trim() || await deriveTitleFromUploadedImage('projects', heroFile) || (proj.title || '').trim();
    
    if (!finalTitle) {
      await cleanupUploadedRequestFiles(req.files, {
        hero_image: 'projects',
        documents: 'documents',
      });
      req.flash('error', 'Project title is required');
      return res.redirect(`/admin/projects/${projId}/edit`);
    }

    const publicationValidationError = getScheduledPublicationValidationError(publicationStatus, publishedAt);
    if (publicationValidationError) {
      await cleanupUploadedRequestFiles(req.files, {
        hero_image: 'projects',
        documents: 'documents',
      });
      req.flash('error', publicationValidationError);
      return res.redirect(`/admin/projects/${projId}/edit`);
    }
    
    const { slug, error: slugError } = await resolveOptionalSlug(db, {
      tableName: 'projects',
      title: finalTitle,
      rawSlug,
      fallbackPrefix: 'project',
      allowNumericOnly: true,
      ignoreId: projId,
      idForFallback: projId,
    });
    if (slugError) {
      if (req.files && req.files.hero_image) {
        for (const file of req.files.hero_image) {
          await deleteUploadedFile(file.filename, 'projects');
        }
      }
      if (req.files && req.files.documents) {
        for (const file of req.files.documents) {
          await deleteUploadedFile(file.filename, 'documents');
        }
      }
      req.flash('error', slugError);
      return res.redirect(`/admin/projects/${projId}/edit`);
    }
    
    // Handle hero image replacement
    let hero = proj.hero_image;
    if (req.files && req.files.hero_image) {
      const newHero = req.files.hero_image[0].filename;
      // Delete old hero image if being replaced
      if (proj.hero_image && newHero !== proj.hero_image) {
        await deleteUploadedFile(proj.hero_image, 'projects');
      }
      hero = newHero;
    }
    
    // Update project
    await db.run(
      `UPDATE projects
       SET title = ?,
           slug = ?,
           summary = ?,
           description = ?,
           project_status = ?,
           publication_status = ?,
           published_at = ?,
           tags = ?,
           hero_image = ?
       WHERE id = ?`,
      finalTitle,
      slug,
      summary,
      description,
      projectStatus,
      publicationStatus,
      publicationStatus === SCHEDULED_CONTENT_STATUS ? publishedAt : null,
      tags,
      hero,
      projId
    );
    
    // Add new documents if provided
    if (req.files && req.files.documents && Array.isArray(req.files.documents)) {
      for (const file of req.files.documents) {
        await db.run('INSERT INTO project_documents (project_id, filename, original_name) VALUES (?,?,?)', projId, file.filename, file.originalname);
      }
    }
    // update collection assignments only when the field is explicitly submitted
    if (Object.prototype.hasOwnProperty.call(req.body, 'collections')) {
      await db.run('DELETE FROM project_collection_items WHERE project_id = ?', projId);
    }
    if (req.body.collections) {
      const arr = Array.isArray(req.body.collections) ? req.body.collections : [req.body.collections];
      for (const cid of arr) {
        const maxOrder = await db.get('SELECT MAX(order_index) as max_order FROM project_collection_items WHERE collection_id = ?', cid);
        const nextOrder = (maxOrder.max_order || 0) + 1;
        await db.run('INSERT OR IGNORE INTO project_collection_items (collection_id, project_id, order_index) VALUES (?,?,?)', cid, projId, nextOrder);
      }
    }

    await syncContentTags(db, 'projects', projId, tags);
  await syncProjectSelections(db, projId, req.body);
    
    req.flash('success', 'Project updated');
    res.redirect('/admin/projects');
  } catch (err) {
    console.error('Project update error:', err);
    req.flash('error', 'Failed to update project: ' + (err.message || 'Unknown error'));
    res.redirect(`/admin/projects/${req.params.id}/edit`);
  }
});

router.delete('/projects/:id', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const projId = parseInt(req.params.id);
    const removed = await deleteProjectRecord(db, projId);
    if (!removed) {
      req.flash('error', 'Project not found');
      return res.redirect('/admin/projects');
    }
    
    req.flash('success', 'Project deleted');
    res.redirect('/admin/projects');
  } catch (err) {
    console.error('Project deletion error:', err);
    req.flash('error', 'Failed to delete project: ' + (err.message || 'Unknown error'));
    res.redirect('/admin/projects');
  }
});

router.post('/projects/bulk-delete', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const ids = normalizeSelectedIds(req.body.selected_ids);
    if (!ids.length) {
      req.flash('error', 'Select at least one project to delete.');
      return res.redirect('/admin/projects');
    }

    const result = await bulkDeleteRecords(ids, (projectId) => deleteProjectRecord(db, projectId));
    if (result.deleted > 0 && result.failed === 0) {
      req.flash('success', buildBulkDeleteMessage(result, 'project', 'projects'));
    } else {
      req.flash('error', buildBulkDeleteMessage(result, 'project', 'projects') || 'Failed to delete selected projects.');
    }
    return res.redirect('/admin/projects');
  } catch (err) {
    console.error('Bulk project deletion error:', err);
    req.flash('error', 'Failed to delete selected projects.');
    return res.redirect('/admin/projects');
  }
});

router.get('/collections/gallery', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const collections = await db.all(
      `SELECT gc.*, COUNT(g.id) AS item_count
       FROM gallery_collections gc
       LEFT JOIN gallery_collection_items gci ON gci.collection_id = gc.id
       LEFT JOIN gallery g ON g.id = gci.gallery_id
       GROUP BY gc.id
       ORDER BY LOWER(gc.title) ASC, gc.id ASC`
    );
    return res.render('admin/collections/gallery', { collections });
  } catch (err) {
    console.error('Gallery collections load error:', err);
    req.flash('error', 'Failed to load gallery collections.');
    return res.render('admin/collections/gallery', { collections: [] });
  }
});

router.post('/collections/gallery', validateCsrfToken, async (req, res) => {
  try {
    const db = req.app.locals.db;
    const title = (req.body.title || '').trim();
    const description = (req.body.description || '').trim();

    if (!title) {
      req.flash('error', 'Collection title is required.');
      return res.redirect('/admin/collections/gallery');
    }

    await db.run(
      'INSERT INTO gallery_collections (title, description) VALUES (?, ?)',
      title,
      description || null
    );
    req.flash('success', 'Gallery collection created.');
    return res.redirect('/admin/collections/gallery');
  } catch (err) {
    console.error('Gallery collection creation error:', err);
    req.flash('error', 'Failed to create gallery collection.');
    return res.redirect('/admin/collections/gallery');
  }
});

router.get('/collections/gallery/:id/edit', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const collection = await db.get('SELECT * FROM gallery_collections WHERE id = ?', req.params.id);
    if (!collection) {
      req.flash('error', 'Gallery collection not found.');
      return res.redirect('/admin/collections/gallery');
    }

    return res.render('admin/collections/gallery_edit', { collection });
  } catch (err) {
    console.error('Gallery collection edit load error:', err);
    req.flash('error', 'Failed to load gallery collection.');
    return res.redirect('/admin/collections/gallery');
  }
});

router.put('/collections/gallery/:id', validateCsrfToken, async (req, res) => {
  try {
    const db = req.app.locals.db;
    const title = (req.body.title || '').trim();
    const description = (req.body.description || '').trim();
    const collection = await db.get('SELECT id FROM gallery_collections WHERE id = ?', req.params.id);

    if (!collection) {
      req.flash('error', 'Gallery collection not found.');
      return res.redirect('/admin/collections/gallery');
    }

    if (!title) {
      req.flash('error', 'Collection title is required.');
      return res.redirect(`/admin/collections/gallery/${req.params.id}/edit`);
    }

    await db.run(
      'UPDATE gallery_collections SET title = ?, description = ? WHERE id = ?',
      title,
      description || null,
      req.params.id
    );
    req.flash('success', 'Gallery collection updated.');
    return res.redirect('/admin/collections/gallery');
  } catch (err) {
    console.error('Gallery collection update error:', err);
    req.flash('error', 'Failed to update gallery collection.');
    return res.redirect(`/admin/collections/gallery/${req.params.id}/edit`);
  }
});

router.delete('/collections/gallery/:id', validateCsrfToken, async (req, res) => {
  try {
    const db = req.app.locals.db;
    await db.run('DELETE FROM gallery_collection_items WHERE collection_id = ?', req.params.id);
    await db.run('DELETE FROM gallery_collections WHERE id = ?', req.params.id);
    req.flash('success', 'Gallery collection deleted.');
    return res.redirect('/admin/collections/gallery');
  } catch (err) {
    console.error('Gallery collection deletion error:', err);
    req.flash('error', 'Failed to delete gallery collection.');
    return res.redirect('/admin/collections/gallery');
  }
});

router.post('/gallery/:id/collections', validateCsrfToken, async (req, res) => {
  try {
    const db = req.app.locals.db;
    const galleryId = parseInt(req.params.id, 10);
    const galleryItem = await db.get('SELECT id FROM gallery WHERE id = ?', galleryId);
    if (!galleryItem) {
      req.flash('error', 'Image not found.');
      return res.redirect('/admin/gallery');
    }

    await db.run('DELETE FROM gallery_collection_items WHERE gallery_id = ?', galleryId);
    const collections = req.body.collections;
    if (collections) {
      const selectedIds = Array.isArray(collections) ? collections : [collections];
      for (const cid of selectedIds) {
        const maxOrder = await db.get('SELECT MAX(order_index) as max_order FROM gallery_collection_items WHERE collection_id = ?', cid);
        const nextOrder = (maxOrder.max_order || 0) + 1;
        await db.run(
          'INSERT OR IGNORE INTO gallery_collection_items (collection_id, gallery_id, order_index) VALUES (?,?,?)',
          cid,
          galleryId,
          nextOrder
        );
      }
    }

    req.flash('success', 'Gallery collections updated.');
    return res.redirect('/admin/gallery');
  } catch (err) {
    console.error('Gallery collection assignment error:', err);
    req.flash('error', 'Failed to update gallery collections.');
    return res.redirect('/admin/gallery');
  }
});

router.get('/collections/projects', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const collections = await db.all(
      `SELECT pc.*, COUNT(p.id) AS item_count
       FROM project_collections pc
       LEFT JOIN project_collection_items pci ON pci.collection_id = pc.id
       LEFT JOIN projects p ON p.id = pci.project_id
       GROUP BY pc.id
       ORDER BY LOWER(pc.title) ASC, pc.id ASC`
    );
    return res.render('admin/collections/projects', { collections });
  } catch (err) {
    console.error('Project collections load error:', err);
    req.flash('error', 'Failed to load project collections.');
    return res.render('admin/collections/projects', { collections: [] });
  }
});

router.post('/collections/projects', validateCsrfToken, async (req, res) => {
  try {
    const db = req.app.locals.db;
    const title = (req.body.title || '').trim();
    const description = (req.body.description || '').trim();

    if (!title) {
      req.flash('error', 'Collection title is required.');
      return res.redirect('/admin/collections/projects');
    }

    await db.run(
      'INSERT INTO project_collections (title, description) VALUES (?, ?)',
      title,
      description || null
    );
    req.flash('success', 'Project collection created.');
    return res.redirect('/admin/collections/projects');
  } catch (err) {
    console.error('Project collection creation error:', err);
    req.flash('error', 'Failed to create project collection.');
    return res.redirect('/admin/collections/projects');
  }
});

router.get('/collections/projects/:id/edit', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const collection = await db.get('SELECT * FROM project_collections WHERE id = ?', req.params.id);
    if (!collection) {
      req.flash('error', 'Project collection not found.');
      return res.redirect('/admin/collections/projects');
    }

    return res.render('admin/collections/project_edit', { collection });
  } catch (err) {
    console.error('Project collection edit load error:', err);
    req.flash('error', 'Failed to load project collection.');
    return res.redirect('/admin/collections/projects');
  }
});

router.put('/collections/projects/:id', validateCsrfToken, async (req, res) => {
  try {
    const db = req.app.locals.db;
    const title = (req.body.title || '').trim();
    const description = (req.body.description || '').trim();
    const collection = await db.get('SELECT id FROM project_collections WHERE id = ?', req.params.id);

    if (!collection) {
      req.flash('error', 'Project collection not found.');
      return res.redirect('/admin/collections/projects');
    }

    if (!title) {
      req.flash('error', 'Collection title is required.');
      return res.redirect(`/admin/collections/projects/${req.params.id}/edit`);
    }

    await db.run(
      'UPDATE project_collections SET title = ?, description = ? WHERE id = ?',
      title,
      description || null,
      req.params.id
    );
    req.flash('success', 'Project collection updated.');
    return res.redirect('/admin/collections/projects');
  } catch (err) {
    console.error('Project collection update error:', err);
    req.flash('error', 'Failed to update project collection.');
    return res.redirect(`/admin/collections/projects/${req.params.id}/edit`);
  }
});

router.delete('/collections/projects/:id', validateCsrfToken, async (req, res) => {
  try {
    const db = req.app.locals.db;
    await db.run('DELETE FROM project_collection_items WHERE collection_id = ?', req.params.id);
    await db.run('DELETE FROM project_collections WHERE id = ?', req.params.id);
    req.flash('success', 'Project collection deleted.');
    return res.redirect('/admin/collections/projects');
  } catch (err) {
    console.error('Project collection deletion error:', err);
    req.flash('error', 'Failed to delete project collection.');
    return res.redirect('/admin/collections/projects');
  }
});

router.post('/projects/:id/collections', validateCsrfToken, async (req, res) => {
  try {
    const db = req.app.locals.db;
    const projectId = parseInt(req.params.id, 10);
    const project = await db.get('SELECT id FROM projects WHERE id = ?', projectId);
    if (!project) {
      req.flash('error', 'Project not found.');
      return res.redirect('/admin/projects');
    }

    await db.run('DELETE FROM project_collection_items WHERE project_id = ?', projectId);
    const collections = req.body.collections;
    if (collections) {
      const selectedIds = Array.isArray(collections) ? collections : [collections];
      for (const cid of selectedIds) {
        const maxOrder = await db.get('SELECT MAX(order_index) as max_order FROM project_collection_items WHERE collection_id = ?', cid);
        const nextOrder = (maxOrder.max_order || 0) + 1;
        await db.run(
          'INSERT OR IGNORE INTO project_collection_items (collection_id, project_id, order_index) VALUES (?,?,?)',
          cid,
          projectId,
          nextOrder
        );
      }
    }

    req.flash('success', 'Project collections updated.');
    return res.redirect('/admin/projects');
  } catch (err) {
    console.error('Project collection assignment error:', err);
    req.flash('error', 'Failed to update project collections.');
    return res.redirect('/admin/projects');
  }
});

router.use('/releases', (req, res) => {
  req.flash('info', 'Release management has been retired from PARACAUSAL.');
  return res.redirect('/admin');
});

router.use('/curated-collections', (req, res) => {
  req.flash('info', 'Curated collections have been retired from PARACAUSAL.');
  return res.redirect('/admin');
});

router.use('/collections', (req, res) => {
  req.flash('info', 'Only gallery and project collections remain in PARACAUSAL.');
  return res.redirect('/admin');
});

// project updates
router.post('/projects/:id/updates', uploadUpdateWithDocs, validateCsrfToken, async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { content, title } = req.body;
    const projId = parseInt(req.params.id, 10);
    const returnTarget = getSafeAdminReturnTarget(req.body.return_to, `/admin/projects/${projId}/edit`);
    const isPinned = normalizeBooleanFlag(req.body.is_pinned);
    const updateImage = req.files && req.files.image ? req.files.image[0] : null;
    
    // Validate project exists
    const proj = await db.get('SELECT id FROM projects WHERE id = ?', projId);
    if (!proj) {
      req.flash('error', 'Project not found');
      return res.redirect('/admin/projects');
    }
    
    // Validate content
    if (!content || content.trim() === '') {
      if (updateImage && updateImage.filename) {
        await deleteUploadedFile(updateImage.filename, 'projects');
      }
      req.flash('error', 'Update content cannot be empty');
      return res.redirect(returnTarget);
    }

    if (isPinned) {
      await db.run('UPDATE project_updates SET is_pinned = 0 WHERE project_id = ?', projId);
    }
    
    // Create update first
    const result = await db.run(
      `INSERT INTO project_updates (
        project_id, title, content, is_pinned, image_filename
      ) VALUES (?,?,?,?,?)`,
      projId,
      (title || '').trim() || null,
      content,
      isPinned ? 1 : 0,
      updateImage ? updateImage.filename : null
    );
    const updateId = result.lastID;
    
    // Then add attachments if files were provided
    if (updateId && req.files && req.files.documents && Array.isArray(req.files.documents)) {
      for (const file of req.files.documents) {
        await db.run('INSERT INTO project_update_attachments (update_id, filename, original_name) VALUES (?,?,?)', updateId, file.filename, file.originalname);
      }
    }
    
    req.flash('success', 'Update added');
    res.redirect(returnTarget);
  } catch (err) {
    console.error('Project update creation error:', err);
    if (req.files && req.files.image && req.files.image[0] && req.files.image[0].filename) {
      await deleteUploadedFile(req.files.image[0].filename, 'projects');
    }
    req.flash('error', 'Failed to add update: ' + (err.message || 'Unknown error'));
    const projId = parseInt(req.params.id, 10);
    const returnTarget = getSafeAdminReturnTarget(req.body.return_to, `/admin/projects/${projId}/edit`);
    res.redirect(returnTarget);
  }
});

router.delete('/projects/:projId/updates/:updateId', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const updateId = parseInt(req.params.updateId);
    const projId = parseInt(req.params.projId);
    
    // Verify update belongs to project
    const update = await db.get('SELECT * FROM project_updates WHERE id = ? AND project_id = ?', updateId, projId);
    if (!update) {
      req.flash('error', 'Update not found');
      return res.redirect(`/admin/projects/${projId}/edit`);
    }
    
    // Delete attachment files first
    await deleteProjectUpdateFiles(db, updateId);
    
    // Delete attachment DB records
    await db.run('DELETE FROM project_update_attachments WHERE update_id = ?', updateId);
    
    // Then delete the update
    await db.run('DELETE FROM project_updates WHERE id = ?', updateId);
    
    req.flash('success', 'Update removed');
    res.redirect(`/admin/projects/${projId}/edit`);
  } catch (err) {
    console.error('Project update deletion error:', err);
    req.flash('error', 'Failed to remove update: ' + (err.message || 'Unknown error'));
    res.redirect(`/admin/projects/${req.params.projId}/edit`);
  }
});

// music playlists
router.get('/playlists/music', async (req, res) => {
  const db = req.app.locals.db;
  const playlists = await db.all('SELECT * FROM music_playlists ORDER BY created_at DESC');
  res.render('admin/playlists/music', { playlists });
});

router.post('/playlists/music', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { title, description } = req.body;
    const trimmedTitle = String(title || '').trim();
    if (!trimmedTitle) {
      req.flash('error', 'Playlist title is required');
      return res.redirect('/admin/playlists/music');
    }

    const slug = await generateUniqueSlug(db, {
      tableName: 'music_playlists',
      title: trimmedTitle,
      fallbackPrefix: 'playlist',
      allowNumericOnly: false,
    });

    await db.run(
      'INSERT INTO music_playlists (title, slug, description) VALUES (?,?,?)',
      trimmedTitle,
      slug,
      String(description || '').trim() || null
    );
    req.flash('success', 'Playlist created');
    res.redirect('/admin/playlists/music');
  } catch (err) {
    console.error('Playlist creation error:', err);
    req.flash('error', 'Failed to create playlist');
    res.redirect('/admin/playlists/music');
  }
});

router.get('/playlists/music/:id/edit', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const playlist = await db.get('SELECT * FROM music_playlists WHERE id = ?', req.params.id);
    if (!playlist) {
      req.flash('error', 'Playlist not found');
      return res.redirect('/admin/playlists/music');
    }
    res.render('admin/playlists/edit', { playlist });
  } catch (err) {
    console.error('Playlist edit error:', err);
    req.flash('error', 'Failed to load playlist');
    res.redirect('/admin/playlists/music');
  }
});

router.put('/playlists/music/:id', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { title, description } = req.body;
    const trimmedTitle = String(title || '').trim();
    if (!trimmedTitle) {
      req.flash('error', 'Playlist title is required');
      return res.redirect(`/admin/playlists/music/${req.params.id}/edit`);
    }

    const playlist = await db.get('SELECT id FROM music_playlists WHERE id = ?', req.params.id);
    if (!playlist) {
      req.flash('error', 'Playlist not found');
      return res.redirect('/admin/playlists/music');
    }

    const slug = await generateUniqueSlug(db, {
      tableName: 'music_playlists',
      title: trimmedTitle,
      fallbackPrefix: 'playlist',
      allowNumericOnly: false,
      ignoreId: req.params.id,
      idForFallback: req.params.id,
    });

    await db.run(
      'UPDATE music_playlists SET title = ?, slug = ?, description = ? WHERE id = ?',
      trimmedTitle,
      slug,
      String(description || '').trim() || null,
      req.params.id
    );
    req.flash('success', 'Playlist updated');
    res.redirect('/admin/playlists/music');
  } catch (err) {
    console.error('Playlist update error:', err);
    req.flash('error', 'Failed to update playlist');
    res.redirect(`/admin/playlists/music/${req.params.id}/edit`);
  }
});

router.get('/playlists/music/:id/tracks', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const playlist = await db.get('SELECT * FROM music_playlists WHERE id = ?', req.params.id);
    if (!playlist) {
      req.flash('error', 'Playlist not found');
      return res.redirect('/admin/playlists/music');
    }
    const tracks = await db.all(`
      SELECT m.*, mpi.order_index, mpi.id as mpi_id
      FROM music m
      JOIN music_playlist_items mpi ON mpi.music_id = m.id
      WHERE mpi.playlist_id = ?
      ORDER BY mpi.order_index, m.id
    `, req.params.id);
    res.render('admin/playlists/tracks', { playlist, tracks });
  } catch (err) {
    console.error('Playlist tracks error:', err);
    req.flash('error', 'Failed to load playlist tracks');
    res.redirect('/admin/playlists/music');
  }
});

router.post('/playlists/music/:id/order', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const playlistId = parseInt(req.params.id, 10);
    if (Number.isNaN(playlistId)) {
      req.flash('error', 'Invalid playlist id');
      return res.redirect('/admin/playlists/music');
    }

    const currentRows = await db.all(
      `SELECT music_id, order_index
       FROM music_playlist_items
       WHERE playlist_id = ?
       ORDER BY order_index, music_id`,
      playlistId
    );

    if (!currentRows.length) {
      req.flash('info', 'No tracks to reorder in this playlist');
      return res.redirect(`/admin/playlists/music/${playlistId}/tracks`);
    }

    const trackIdsRaw = req.body.track_ids || [];
    const orderValuesRaw = req.body.order_values || [];
    const trackIds = Array.isArray(trackIdsRaw) ? trackIdsRaw : [trackIdsRaw];
    const orderValues = Array.isArray(orderValuesRaw) ? orderValuesRaw : [orderValuesRaw];

    const requestedOrderByTrack = new Map();
    trackIds.forEach((id, idx) => {
      const parsedTrackId = parseInt(id, 10);
      const parsedOrder = parseInt(orderValues[idx], 10);
      if (!Number.isNaN(parsedTrackId)) {
        const safeOrder = Number.isNaN(parsedOrder) || parsedOrder < 1 ? null : parsedOrder;
        requestedOrderByTrack.set(parsedTrackId, safeOrder);
      }
    });

    // Deterministic conflict resolution:
    // 1) requested numeric order ascending
    // 2) current order ascending
    // 3) music_id ascending
    const normalized = currentRows
      .map((row, idx) => ({
        music_id: row.music_id,
        current_order: row.order_index == null ? idx + 1 : row.order_index,
        requested_order: requestedOrderByTrack.has(row.music_id)
          ? requestedOrderByTrack.get(row.music_id)
          : null,
      }))
      .sort((a, b) => {
        const aReq = a.requested_order == null ? Number.MAX_SAFE_INTEGER : a.requested_order;
        const bReq = b.requested_order == null ? Number.MAX_SAFE_INTEGER : b.requested_order;
        if (aReq !== bReq) return aReq - bReq;
        if (a.current_order !== b.current_order) return a.current_order - b.current_order;
        return a.music_id - b.music_id;
      });

    await db.exec('BEGIN TRANSACTION');
    try {
      for (let i = 0; i < normalized.length; i += 1) {
        await db.run(
          'UPDATE music_playlist_items SET order_index = ? WHERE playlist_id = ? AND music_id = ?',
          i + 1,
          playlistId,
          normalized[i].music_id
        );
      }
      await db.exec('COMMIT');
    } catch (txErr) {
      await db.exec('ROLLBACK');
      throw txErr;
    }

    req.flash('success', 'Playlist order saved');
    return res.redirect(`/admin/playlists/music/${playlistId}/tracks`);
  } catch (err) {
    console.error('Save playlist order error:', err);
    req.flash('error', 'Failed to save playlist order');
    return res.redirect(`/admin/playlists/music/${req.params.id}/tracks`);
  }
});

router.post('/playlists/music/:id/move', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { track_id, direction } = req.body;
    const playlistId = parseInt(req.params.id);
    const trackId = parseInt(track_id);
    
    // Get current order of this track
    const current = await db.get(
      'SELECT order_index FROM music_playlist_items WHERE playlist_id = ? AND music_id = ?',
      playlistId, trackId
    );
    if (!current) {
      req.flash('error', 'Track not found in playlist');
      return res.redirect(`/admin/playlists/music/${playlistId}/tracks`);
    }
    
    const currentOrder = current.order_index;
    let newOrder;
    
    if (direction === 'up') {
      // Find the track with order_index just below current
      const swapTrack = await db.get(`
        SELECT music_id, order_index FROM music_playlist_items
        WHERE playlist_id = ? AND order_index < ?
        ORDER BY order_index DESC LIMIT 1
      `, playlistId, currentOrder);
      if (!swapTrack) {
        req.flash('error', 'Cannot move up - already at top');
        return res.redirect(`/admin/playlists/music/${playlistId}/tracks`);
      }
      newOrder = swapTrack.order_index;
      // Swap order indices
      await db.run(
        'UPDATE music_playlist_items SET order_index = ? WHERE playlist_id = ? AND music_id = ?',
        swapTrack.order_index, playlistId, trackId
      );
      await db.run(
        'UPDATE music_playlist_items SET order_index = ? WHERE playlist_id = ? AND music_id = ?',
        currentOrder, playlistId, swapTrack.music_id
      );
    } else if (direction === 'down') {
      // Find the track with order_index just above current
      const swapTrack = await db.get(`
        SELECT music_id, order_index FROM music_playlist_items
        WHERE playlist_id = ? AND order_index > ?
        ORDER BY order_index ASC LIMIT 1
      `, playlistId, currentOrder);
      if (!swapTrack) {
        req.flash('error', 'Cannot move down - already at bottom');
        return res.redirect(`/admin/playlists/music/${playlistId}/tracks`);
      }
      newOrder = swapTrack.order_index;
      // Swap order indices
      await db.run(
        'UPDATE music_playlist_items SET order_index = ? WHERE playlist_id = ? AND music_id = ?',
        swapTrack.order_index, playlistId, trackId
      );
      await db.run(
        'UPDATE music_playlist_items SET order_index = ? WHERE playlist_id = ? AND music_id = ?',
        currentOrder, playlistId, swapTrack.music_id
      );
    }
    
    req.flash('success', 'Track order updated');
    res.redirect(`/admin/playlists/music/${playlistId}/tracks`);
  } catch (err) {
    console.error('Move track error:', err);
    req.flash('error', 'Failed to move track');
    res.redirect(`/admin/playlists/music/${req.params.id}/tracks`);
  }
});

router.delete('/playlists/music/:id', async (req, res) => {
  try {
    const db = req.app.locals.db;
    await db.run('DELETE FROM music_playlists WHERE id = ?', req.params.id);
    req.flash('success', 'Playlist deleted');
    res.redirect('/admin/playlists/music');
  } catch (err) {
    console.error('Playlist deletion error:', err);
    req.flash('error', 'Failed to delete playlist');
    res.redirect('/admin/playlists/music');
  }
});

// add music to playlist (legacy add-only, avoids duplicates)
router.post('/playlists/music/add', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { playlist_id, music_id } = req.body;
    const wasAdded = await assignTrackToPlaylist(db, playlist_id, music_id);
    if (wasAdded) {
      req.flash('success', 'Track added to playlist');
    } else {
      req.flash('info', 'Track already in that playlist');
    }
    res.redirect('/admin/music');
  } catch (err) {
    console.error('Add to playlist error:', err);
    req.flash('error', 'Failed to add track');
    res.redirect('/admin/music');
  }
});

// manage playlists for a specific track
router.post('/music/:id/playlists', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const trackId = parseInt(req.params.id);
    // clear existing memberships
    await db.run('DELETE FROM music_playlist_items WHERE music_id = ?', trackId);
    const playlists = req.body.playlists;
    if (playlists) {
      const arr = Array.isArray(playlists) ? playlists : [playlists];
      for (const pid of arr) {
        const maxOrder = await db.get('SELECT MAX(order_index) as max_order FROM music_playlist_items WHERE playlist_id = ?', pid);
        const nextOrder = (maxOrder.max_order || 0) + 1;
        await db.run('INSERT OR IGNORE INTO music_playlist_items (playlist_id, music_id, order_index) VALUES (?,?,?)', pid, trackId, nextOrder);
      }
    }
    req.flash('success', 'Playlist assignments updated');
    res.redirect('/admin/music');
  } catch (err) {
    console.error('Update track playlists error:', err);
    req.flash('error', 'Failed to update playlists');
    res.redirect('/admin/music');
  }
});

// video playlists
router.get('/playlists/videos', async (req, res) => {
  const db = req.app.locals.db;
  const playlists = await db.all('SELECT * FROM video_playlists ORDER BY created_at DESC');
  res.render('admin/playlists/videos', { playlists });
});

router.get('/playlists/videos/:id/edit', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const playlist = await db.get('SELECT * FROM video_playlists WHERE id = ?', req.params.id);
    if (!playlist) {
      req.flash('error', 'Playlist not found');
      return res.redirect('/admin/playlists/videos');
    }
    return res.render('admin/playlists/video_edit', { playlist });
  } catch (err) {
    console.error('Video playlist edit error:', err);
    req.flash('error', 'Failed to load playlist');
    return res.redirect('/admin/playlists/videos');
  }
});

router.post('/playlists/videos', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { title, description } = req.body;
    if (!title || title.trim() === '') {
      req.flash('error', 'Playlist title is required');
      return res.redirect('/admin/playlists/videos');
    }
    await db.run('INSERT INTO video_playlists (title, description) VALUES (?,?)', title, description);
    req.flash('success', 'Playlist created');
    res.redirect('/admin/playlists/videos');
  } catch (err) {
    console.error('Playlist creation error:', err);
    req.flash('error', 'Failed to create playlist');
    res.redirect('/admin/playlists/videos');
  }
});

router.put('/playlists/videos/:id', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { title, description } = req.body;
    if (!title || title.trim() === '') {
      req.flash('error', 'Playlist title is required');
      return res.redirect(`/admin/playlists/videos/${req.params.id}/edit`);
    }
    const playlist = await db.get('SELECT id FROM video_playlists WHERE id = ?', req.params.id);
    if (!playlist) {
      req.flash('error', 'Playlist not found');
      return res.redirect('/admin/playlists/videos');
    }
    await db.run('UPDATE video_playlists SET title=?, description=? WHERE id=?', title.trim(), description || null, req.params.id);
    req.flash('success', 'Playlist updated');
    return res.redirect('/admin/playlists/videos');
  } catch (err) {
    console.error('Playlist update error:', err);
    req.flash('error', 'Failed to update playlist');
    return res.redirect(`/admin/playlists/videos/${req.params.id}/edit`);
  }
});

router.delete('/playlists/videos/:id', async (req, res) => {
  try {
    const db = req.app.locals.db;
    await db.run('DELETE FROM video_playlists WHERE id = ?', req.params.id);
    req.flash('success', 'Playlist deleted');
    res.redirect('/admin/playlists/videos');
  } catch (err) {
    console.error('Playlist deletion error:', err);
    req.flash('error', 'Failed to delete playlist');
    res.redirect('/admin/playlists/videos');
  }
});

// add video to playlist via parameters
router.post('/playlists/videos/:id/add/:videoId', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const playlistId = parseInt(req.params.id);
    const videoId = parseInt(req.params.videoId);
    const maxOrder = await db.get('SELECT MAX(order_index) as max_order FROM video_playlist_items WHERE playlist_id = ?', playlistId);
    const nextOrder = (maxOrder.max_order || 0) + 1;
    await db.run('INSERT INTO video_playlist_items (playlist_id, video_id, order_index) VALUES (?,?,?)', playlistId, videoId, nextOrder);
    req.flash('success', 'Video added to playlist');
    res.redirect('/admin/playlists/videos');
  } catch (err) {
    console.error('Add to playlist error:', err);
    req.flash('error', 'Failed to add video');
    res.redirect('/admin/playlists/videos');
  }
});

// add video to playlist via form (legacy, avoid duplicates)
router.post('/playlists/videos/add', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { playlist_id, video_id } = req.body;
    const exists = await db.get('SELECT 1 FROM video_playlist_items WHERE playlist_id=? AND video_id=?', playlist_id, video_id);
    if (!exists) {
      const maxOrder = await db.get('SELECT MAX(order_index) as max_order FROM video_playlist_items WHERE playlist_id = ?', playlist_id);
      const nextOrder = (maxOrder.max_order || 0) + 1;
      await db.run('INSERT INTO video_playlist_items (playlist_id, video_id, order_index) VALUES (?,?,?)', playlist_id, video_id, nextOrder);
      req.flash('success', 'Video added to playlist');
    } else {
      req.flash('info', 'Video already in that playlist');
    }
    res.redirect('/admin/videos');
  } catch (err) {
    console.error('Add to playlist error:', err);
    req.flash('error', 'Failed to add video');
    res.redirect('/admin/videos');
  }
});

// manage playlists for a specific video
router.post('/videos/:id/playlists', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const videoId = parseInt(req.params.id);
    await db.run('DELETE FROM video_playlist_items WHERE video_id = ?', videoId);
    const playlists = req.body.playlists;
    if (playlists) {
      const arr = Array.isArray(playlists) ? playlists : [playlists];
      for (const pid of arr) {
        const maxOrder = await db.get('SELECT MAX(order_index) as max_order FROM video_playlist_items WHERE playlist_id = ?', pid);
        const nextOrder = (maxOrder.max_order || 0) + 1;
        await db.run('INSERT OR IGNORE INTO video_playlist_items (playlist_id, video_id, order_index) VALUES (?,?,?)', pid, videoId, nextOrder);
      }
    }
    req.flash('success', 'Playlist assignments updated');
    res.redirect('/admin/videos');
  } catch (err) {
    console.error('Update video playlists error:', err);
    req.flash('error', 'Failed to update playlists');
    res.redirect('/admin/videos');
  }
});

// logout route if not in auth
router.post('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// ============================================================================
// USERNAME CHANGE
// ============================================================================

// GET change username page
router.get('/change-username', (req, res) => {
  res.render('admin/change-username');
});

// POST change username
router.post('/change-username', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { currentPassword, newUsername, confirmUsername } = req.body;

    if (!req.session || !req.session.admin) {
      req.flash('error', 'Session expired. Please log in again.');
      return res.redirect('/login');
    }

    const adminId = req.session.admin.id;
    const admin = await db.get('SELECT * FROM admins WHERE id = ?', adminId);

    if (!admin) {
      req.flash('error', 'Admin account not found.');
      return res.redirect('/admin');
    }

    const currentPasswordValid = await bcrypt.compare(currentPassword, admin.password);
    if (!currentPasswordValid) {
      req.flash('error', 'Current password is incorrect.');
      return res.redirect('/admin/change-username');
    }

    const trimmedUsername = typeof newUsername === 'string' ? newUsername.trim() : '';
    const trimmedConfirmation = typeof confirmUsername === 'string' ? confirmUsername.trim() : '';

    if (!trimmedUsername) {
      req.flash('error', 'New username is required.');
      return res.redirect('/admin/change-username');
    }

    if (trimmedUsername.length < ADMIN_USERNAME_MIN_LENGTH || trimmedUsername.length > ADMIN_USERNAME_MAX_LENGTH) {
      req.flash('error', `New username must be between ${ADMIN_USERNAME_MIN_LENGTH} and ${ADMIN_USERNAME_MAX_LENGTH} characters long.`);
      return res.redirect('/admin/change-username');
    }

    if (trimmedUsername !== trimmedConfirmation) {
      req.flash('error', 'New username and confirmation do not match.');
      return res.redirect('/admin/change-username');
    }

    if (trimmedUsername === admin.username) {
      req.flash('error', 'New username must be different from the current username.');
      return res.redirect('/admin/change-username');
    }

    const existingAdmin = await db.get('SELECT id FROM admins WHERE username = ? AND id != ?', trimmedUsername, adminId);
    if (existingAdmin) {
      req.flash('error', 'That username is already in use.');
      return res.redirect('/admin/change-username');
    }

    await db.run('UPDATE admins SET username = ? WHERE id = ?', trimmedUsername, adminId);
    req.session.admin.username = trimmedUsername;

    req.flash('success', 'Username changed successfully.');
    return res.redirect('/admin');
  } catch (err) {
    if (err && err.code === 'SQLITE_CONSTRAINT') {
      req.flash('error', 'That username is already in use.');
      return res.redirect('/admin/change-username');
    }

    console.error('Username change error:', err);
    req.flash('error', 'Failed to change username. Please try again.');
    return res.redirect('/admin/change-username');
  }
});

// ============================================================================
// PASSWORD CHANGE
// ============================================================================

// GET change password page
router.get('/change-password', (req, res) => {
  res.render('admin/change-password');
});

router.get('/two-factor', async (req, res) => {
  const db = req.app.locals.db;
  const adminId = req.session && req.session.admin ? req.session.admin.id : null;
  const admin = await db.get('SELECT * FROM admins WHERE id = ?', adminId);
  if (!admin) {
    req.flash('error', 'Admin account not found.');
    return res.redirect('/admin');
  }

  let setup = null;
  if (!isTwoFactorEnabled(admin)) {
    if (!req.session[TWO_FACTOR_SETUP_SESSION_KEY] || !req.session[TWO_FACTOR_SETUP_SESSION_KEY].secret) {
      req.session[TWO_FACTOR_SETUP_SESSION_KEY] = await buildTwoFactorSetup(admin.username);
    }
    setup = req.session[TWO_FACTOR_SETUP_SESSION_KEY];
  } else {
    clearPendingTwoFactorSetup(req.session);
  }

  return res.render('admin/two-factor', {
    twoFactorEnabled: isTwoFactorEnabled(admin),
    setup,
    recoveryCodes: null,
    recoveryCodeCount: parseStoredRecoveryCodeHashes(admin.two_factor_recovery_codes).length,
  });
});

router.post('/two-factor/enable', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const adminId = req.session && req.session.admin ? req.session.admin.id : null;
    const admin = await db.get('SELECT * FROM admins WHERE id = ?', adminId);
    const setup = req.session && req.session[TWO_FACTOR_SETUP_SESSION_KEY];
    const { currentPassword, code } = req.body;

    if (!admin) {
      req.flash('error', 'Admin account not found.');
      return res.redirect('/admin');
    }

    if (isTwoFactorEnabled(admin)) {
      req.flash('error', 'Two-factor authentication is already enabled.');
      return res.redirect('/admin/two-factor');
    }

    if (!setup || !setup.secret || !Array.isArray(setup.recoveryCodes) || !setup.recoveryCodes.length) {
      req.flash('error', 'Two-factor setup expired. Reload the page and scan the new code.');
      return res.redirect('/admin/two-factor');
    }

    const currentPasswordValid = await bcrypt.compare(currentPassword, admin.password);
    if (!currentPasswordValid) {
      req.flash('error', 'Current password is incorrect.');
      return res.redirect('/admin/two-factor');
    }

    if (!verifyTotpToken(setup.secret, code)) {
      req.flash('error', 'Enter a valid authenticator code to enable 2FA.');
      return res.redirect('/admin/two-factor');
    }

    await db.run(
      'UPDATE admins SET two_factor_secret = ?, two_factor_enabled = 1, two_factor_recovery_codes = ? WHERE id = ?',
      setup.secret,
      serializeRecoveryCodeHashes(hashRecoveryCodes(setup.recoveryCodes)),
      admin.id
    );

    const recoveryCodes = [...setup.recoveryCodes];
    clearPendingTwoFactorSetup(req.session);

    return res.render('admin/two-factor', {
      twoFactorEnabled: true,
      setup: null,
      recoveryCodes,
      recoveryCodeCount: recoveryCodes.length,
      success: 'Two-factor authentication enabled.',
      error: '',
      currentUser: res.locals.currentUser,
      adminSetupRequired: res.locals.adminSetupRequired,
      csrfToken: res.locals.csrfToken,
      hidePlayer: res.locals.hidePlayer,
    });
  } catch (err) {
    console.error('Two-factor enable error:', err);
    req.flash('error', 'Failed to enable two-factor authentication.');
    return res.redirect('/admin/two-factor');
  }
});

router.post('/two-factor/disable', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const adminId = req.session && req.session.admin ? req.session.admin.id : null;
    const admin = await db.get('SELECT * FROM admins WHERE id = ?', adminId);
    const { currentPassword, code } = req.body;

    if (!admin) {
      req.flash('error', 'Admin account not found.');
      return res.redirect('/admin');
    }

    if (!isTwoFactorEnabled(admin)) {
      req.flash('error', 'Two-factor authentication is not enabled.');
      return res.redirect('/admin/two-factor');
    }

    const currentPasswordValid = await bcrypt.compare(currentPassword, admin.password);
    if (!currentPasswordValid) {
      req.flash('error', 'Current password is incorrect.');
      return res.redirect('/admin/two-factor');
    }

    let verified = verifyTotpToken(admin.two_factor_secret, code);
    if (!verified) {
      const recoveryCodeResult = verifyRecoveryCode(code, parseStoredRecoveryCodeHashes(admin.two_factor_recovery_codes));
      if (recoveryCodeResult.valid) {
        verified = true;
      }
    }

    if (!verified) {
      req.flash('error', 'Enter a valid authenticator or recovery code to disable 2FA.');
      return res.redirect('/admin/two-factor');
    }

    await db.run(
      'UPDATE admins SET two_factor_secret = NULL, two_factor_enabled = 0, two_factor_recovery_codes = NULL WHERE id = ?',
      admin.id
    );
    clearPendingTwoFactorSetup(req.session);
    req.flash('success', 'Two-factor authentication disabled.');
    return res.redirect('/admin');
  } catch (err) {
    console.error('Two-factor disable error:', err);
    req.flash('error', 'Failed to disable two-factor authentication.');
    return res.redirect('/admin/two-factor');
  }
});

// POST change password
router.post('/change-password', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { currentPassword, newPassword, confirmPassword } = req.body;
    
    // Get current admin from session
    if (!req.session || !req.session.admin) {
      req.flash('error', 'Session expired. Please log in again.');
      return res.redirect('/login');
    }
    
    const adminId = req.session.admin.id;
    const admin = await db.get('SELECT * FROM admins WHERE id = ?', adminId);
    
    if (!admin) {
      req.flash('error', 'Admin account not found.');
      return res.redirect('/admin');
    }
    
    // Validate current password
    const currentPasswordValid = await bcrypt.compare(currentPassword, admin.password);
    if (!currentPasswordValid) {
      req.flash('error', 'Current password is incorrect.');
      return res.redirect('/admin/change-password');
    }
    
    // Validate new password is not empty
    if (!newPassword || newPassword.trim() === '') {
      req.flash('error', 'New password cannot be empty.');
      return res.redirect('/admin/change-password');
    }
    
    // Validate minimum password length
    if (newPassword.length < 8) {
      req.flash('error', 'New password must be at least 8 characters long.');
      return res.redirect('/admin/change-password');
    }
    
    // Validate new password and confirm password match
    if (newPassword !== confirmPassword) {
      req.flash('error', 'New password and confirmation do not match.');
      return res.redirect('/admin/change-password');
    }
    
    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    
    // Update password in database
    await db.run('UPDATE admins SET password = ? WHERE id = ?', hashedPassword, adminId);
    
    // Success - user remains logged in
    req.flash('success', 'Password changed successfully.');
    res.redirect('/admin');
    
  } catch (err) {
    console.error('Password change error:', err);
    req.flash('error', 'Failed to change password. Please try again.');
    res.redirect('/admin/change-password');
  }
});

module.exports = router;