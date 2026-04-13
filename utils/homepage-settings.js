const DEFAULT_HOMEPAGE_SETTINGS = Object.freeze({
  headingOverride: '',
  introText: 'A collection of music, media and experimental projects.',
  tagline: '',
  featuredProjectId: null,
  featuredTrackId: null,
  featuredVideoId: null,
  showMusic: true,
  showVideos: true,
  showGallery: true,
  showProjects: true,
});

function normalizeOptionalText(value, maxLength) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().slice(0, maxLength);
}

function normalizeNullableId(value) {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

function normalizeBooleanFlag(value) {
  return value === '1' || value === 'true' || value === 'on' || value === true;
}

function mapHomepageSettingsRow(row = {}) {
  return {
    headingOverride: typeof row.heading_override === 'string' ? row.heading_override : DEFAULT_HOMEPAGE_SETTINGS.headingOverride,
    introText: typeof row.intro_text === 'string' && row.intro_text.trim()
      ? row.intro_text
      : DEFAULT_HOMEPAGE_SETTINGS.introText,
    tagline: typeof row.tagline === 'string' ? row.tagline : DEFAULT_HOMEPAGE_SETTINGS.tagline,
    featuredProjectId: normalizeNullableId(row.featured_project_id),
    featuredTrackId: normalizeNullableId(row.featured_track_id),
    featuredVideoId: normalizeNullableId(row.featured_video_id),
    showMusic: Number(row.show_music) !== 0,
    showVideos: Number(row.show_videos) !== 0,
    showGallery: Number(row.show_gallery) !== 0,
    showProjects: Number(row.show_projects) !== 0,
  };
}

function normalizeHomepageSettingsInput(body = {}) {
  return {
    headingOverride: normalizeOptionalText(body.heading_override, 120),
    introText: normalizeOptionalText(body.intro_text, 1200) || DEFAULT_HOMEPAGE_SETTINGS.introText,
    tagline: normalizeOptionalText(body.tagline, 180),
    featuredProjectId: normalizeNullableId(body.featured_project_id),
    featuredTrackId: normalizeNullableId(body.featured_track_id),
    featuredVideoId: normalizeNullableId(body.featured_video_id),
    showMusic: normalizeBooleanFlag(body.show_music),
    showVideos: normalizeBooleanFlag(body.show_videos),
    showGallery: normalizeBooleanFlag(body.show_gallery),
    showProjects: normalizeBooleanFlag(body.show_projects),
  };
}

async function ensureHomepageSettingsRow(db) {
  await db.run('INSERT OR IGNORE INTO homepage_settings (id) VALUES (1)');
}

async function getHomepageSettings(db) {
  await ensureHomepageSettingsRow(db);
  const row = await db.get('SELECT * FROM homepage_settings WHERE id = 1');
  return mapHomepageSettingsRow(row || DEFAULT_HOMEPAGE_SETTINGS);
}

async function saveHomepageSettings(db, settings) {
  const normalizedSettings = {
    ...DEFAULT_HOMEPAGE_SETTINGS,
    ...settings,
  };

  await ensureHomepageSettingsRow(db);
  await db.run(
    `UPDATE homepage_settings
     SET heading_override = ?,
         intro_text = ?,
         tagline = ?,
         featured_project_id = ?,
         featured_track_id = ?,
         featured_video_id = ?,
         show_music = ?,
         show_videos = ?,
         show_gallery = ?,
         show_projects = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = 1`,
    normalizedSettings.headingOverride || null,
    normalizedSettings.introText,
    normalizedSettings.tagline || null,
    normalizedSettings.featuredProjectId,
    normalizedSettings.featuredTrackId,
    normalizedSettings.featuredVideoId,
    normalizedSettings.showMusic ? 1 : 0,
    normalizedSettings.showVideos ? 1 : 0,
    normalizedSettings.showGallery ? 1 : 0,
    normalizedSettings.showProjects ? 1 : 0
  );

  return normalizedSettings;
}

module.exports = {
  DEFAULT_HOMEPAGE_SETTINGS,
  getHomepageSettings,
  normalizeHomepageSettingsInput,
  saveHomepageSettings,
};