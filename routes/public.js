const { createAsyncRouter } = require('../middleware/async-router');
const path = require('path');
const mm = require('music-metadata');
const { recordAnalyticsPageView } = require('../utils/analytics');
const {
  getPublicDirectVisibilityClause,
  getPublicListingVisibilityClause,
} = require('../utils/content-publication-status');
const { DEFAULT_HOMEPAGE_SETTINGS, getHomepageSettings } = require('../utils/homepage-settings');
const {
  CLOSED_PROJECT_STATUS,
  ONGOING_PROJECT_STATUS,
  formatProjectStatusLabel,
  normalizeProjectStatusFilter,
} = require('../utils/project-status');
const {
  attachTagsToItems,
  getTagByNormalizedName,
  getTagMatchExistsClause,
} = require('../utils/tags');

const router = createAsyncRouter();

const TAG_CONTEXT_LINKS = {
  music: { label: 'Back to music', href: '/music' },
  videos: { label: 'Back to videos', href: '/videos' },
  gallery: { label: 'Back to gallery', href: '/gallery' },
  projects: { label: 'Back to projects', href: '/projects' },
};

function buildGalleryPath(item) {
  if (!item) return '/gallery';

  const rawIdentifier = item.slug || item.id;
  if (rawIdentifier === null || typeof rawIdentifier === 'undefined') {
    return '/gallery';
  }

  const identifier = String(rawIdentifier).trim();
  return identifier ? `/gallery/${encodeURIComponent(identifier)}` : '/gallery';
}

function getNormalizedTagContext(value) {
  const context = String(value || '').trim().toLowerCase();
  return TAG_CONTEXT_LINKS[context] ? context : '';
}

function getTagBackLink(results, requestedContext) {
  const normalizedContext = getNormalizedTagContext(requestedContext);
  if (normalizedContext) {
    return TAG_CONTEXT_LINKS[normalizedContext];
  }

  const sectionKeys = Object.keys(TAG_CONTEXT_LINKS);
  const matchingSections = sectionKeys.filter((key) => Array.isArray(results[key]) && results[key].length > 0);

  if (matchingSections.length === 1) {
    return TAG_CONTEXT_LINKS[matchingSections[0]];
  }

  return {
    label: 'Back to home',
    href: '/',
  };
}

function normalizeComparableTrackValue(value) {
  return String(value || '').trim().toLowerCase();
}

function formatTrackDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return '';
  }

  const roundedSeconds = Math.round(seconds);
  const hours = Math.floor(roundedSeconds / 3600);
  const minutes = Math.floor((roundedSeconds % 3600) / 60);
  const remainderSeconds = roundedSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainderSeconds).padStart(2, '0')}`;
  }

  return `${minutes}:${String(remainderSeconds).padStart(2, '0')}`;
}

async function getMusicTrackDurationDetails(filename) {
  if (!filename) {
    return {
      durationSeconds: null,
      durationFormatted: '',
    };
  }

  const filePath = path.join(__dirname, '..', 'uploads', 'music', filename);
  try {
    const metadata = await mm.parseFile(filePath, { duration: true });
    const durationSeconds = metadata && metadata.format && Number.isFinite(metadata.format.duration)
      ? Math.round(metadata.format.duration)
      : null;

    return {
      durationSeconds,
      durationFormatted: formatTrackDuration(durationSeconds),
    };
  } catch (err) {
    return {
      durationSeconds: null,
      durationFormatted: '',
    };
  }
}

function getSharedTrackTagCount(track, normalizedCurrentTagNames) {
  if (!Array.isArray(track.tags) || !normalizedCurrentTagNames.size) {
    return 0;
  }

  return track.tags.reduce((count, tag) => {
    const normalizedTagName = normalizeComparableTrackValue(tag && (tag.normalizedName || tag.name));
    return normalizedTagName && normalizedCurrentTagNames.has(normalizedTagName)
      ? count + 1
      : count;
  }, 0);
}

function chooseRelatedTracks(currentTrack, candidates, limit = 4) {
  const currentAlbum = normalizeComparableTrackValue(currentTrack && currentTrack.album);
  const normalizedCurrentTagNames = new Set(
    Array.isArray(currentTrack && currentTrack.tags)
      ? currentTrack.tags
          .map((tag) => normalizeComparableTrackValue(tag && (tag.normalizedName || tag.name)))
          .filter(Boolean)
      : []
  );

  return (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => {
      const sameAlbum = !!currentAlbum && normalizeComparableTrackValue(candidate.album) === currentAlbum;
      const sharedTagCount = getSharedTrackTagCount(candidate, normalizedCurrentTagNames);

      return {
        ...candidate,
        sharedTagCount,
        hasSharedTags: sharedTagCount > 0,
        sameAlbum,
      };
    })
    .sort((left, right) => {
      if (left.hasSharedTags !== right.hasSharedTags) {
        return left.hasSharedTags ? -1 : 1;
      }
      if (left.sharedTagCount !== right.sharedTagCount) {
        return right.sharedTagCount - left.sharedTagCount;
      }
      if (left.sameAlbum !== right.sameAlbum) {
        return left.sameAlbum ? -1 : 1;
      }
      if ((left.sort_order || 0) !== (right.sort_order || 0)) {
        return (left.sort_order || 0) - (right.sort_order || 0);
      }
      return right.id - left.id;
    })
    .slice(0, limit);
}

function trackPublicPageView(req, event) {
  recordAnalyticsPageView(req, event).catch((err) => {
    console.error('Analytics tracking error:', err);
  });
}

function buildAbsoluteUrl(req, value = '') {
  if (!value) {
    return '';
  }

  if (/^https?:\/\//i.test(value)) {
    return value;
  }

  return `${req.protocol}://${req.get('host')}${value.startsWith('/') ? value : `/${value}`}`;
}

function buildPageMeta(req, {
  title,
  description = '',
  image = '',
  type = 'website',
  canonicalPath = '',
} = {}) {
  const pageTitle = title ? `${title} | PARACAUSAL` : 'PARACAUSAL';
  const canonicalUrl = canonicalPath ? buildAbsoluteUrl(req, canonicalPath) : buildAbsoluteUrl(req, req.originalUrl || '/');
  const imageUrl = image ? buildAbsoluteUrl(req, image) : '';

  return {
    title: pageTitle,
    description: description || 'PARACAUSAL brings together music, videos, images and projects in one place.',
    image: imageUrl,
    type,
    canonicalUrl,
  };
}

async function loadConnectedMusicItems(db, projectId) {
  const tracks = await db.all(
    `SELECT m.*
     FROM music m
     JOIN project_music_links pml ON pml.music_id = m.id
     WHERE pml.project_id = ?
       AND ${getPublicDirectVisibilityClause('m')}
       AND m.filename IS NOT NULL
       AND TRIM(m.filename) != ''
     ORDER BY m.sort_order ASC, m.id DESC`,
    projectId
  );
  await attachTagsToItems(db, 'music', tracks);
  return tracks;
}

async function loadConnectedVideoItems(db, projectId) {
  const videos = await db.all(
    `SELECT v.*
     FROM videos v
     JOIN project_video_links pvl ON pvl.video_id = v.id
     WHERE pvl.project_id = ?
       AND ${getPublicDirectVisibilityClause('v')}
       AND v.filename IS NOT NULL
       AND TRIM(v.filename) != ''
     ORDER BY v.sort_order ASC, v.created_at DESC, v.id DESC`,
    projectId
  );
  await attachTagsToItems(db, 'videos', videos);
  return videos;
}

async function loadConnectedGalleryItems(db, projectId) {
  const images = await db.all(
    `SELECT g.*
     FROM gallery g
     JOIN project_gallery_links pgl ON pgl.gallery_id = g.id
     WHERE pgl.project_id = ?
       AND ${getPublicDirectVisibilityClause('g')}
     ORDER BY g.sort_order ASC, g.created_at DESC, g.id DESC`,
    projectId
  );
  await attachTagsToItems(db, 'gallery', images);
  return images;
}

async function loadTrackConnections(db, musicId) {
  const [relatedVideos, relatedProjects] = await Promise.all([
    db.all(
      `SELECT v.*
       FROM videos v
       JOIN music_video_links mvl ON mvl.video_id = v.id
       WHERE mvl.music_id = ?
         AND ${getPublicDirectVisibilityClause('v')}
         AND v.filename IS NOT NULL
         AND TRIM(v.filename) != ''
       ORDER BY v.sort_order ASC, v.created_at DESC, v.id DESC`,
      musicId
    ),
    db.all(
      `SELECT p.*
       FROM projects p
       JOIN music_project_links mpl ON mpl.project_id = p.id
       WHERE mpl.music_id = ?
         AND ${getPublicDirectVisibilityClause('p')}
       ORDER BY p.sort_order ASC, p.created_at DESC, p.id DESC`,
      musicId
    ),
  ]);

  await attachTagsToItems(db, 'videos', relatedVideos);
  await attachTagsToItems(db, 'projects', relatedProjects);
  relatedProjects.forEach((project) => {
    project.projectStatusLabel = formatProjectStatusLabel(project.project_status);
  });

  return { relatedVideos, relatedProjects };
}

async function loadGalleryConnections(db, galleryId) {
  const relatedProjects = await db.all(
    `SELECT p.*
     FROM projects p
     JOIN gallery_project_links gpl ON gpl.project_id = p.id
     WHERE gpl.gallery_id = ?
       AND ${getPublicDirectVisibilityClause('p')}
     ORDER BY p.sort_order ASC, p.created_at DESC, p.id DESC`,
    galleryId
  );
  await attachTagsToItems(db, 'projects', relatedProjects);
  relatedProjects.forEach((project) => {
    project.projectStatusLabel = formatProjectStatusLabel(project.project_status);
  });
  return { relatedProjects };
}

function getRequestedPreviewToken(req) {
  return String((req.query && req.query.preview) || '').trim();
}

function normalizeProjectUpdatesSort(value) {
  return String(value || '').trim().toLowerCase() === 'oldest'
    ? 'oldest'
    : 'newest';
}

function getProjectUpdatesOrderClause(sortValue) {
  const normalizedSort = normalizeProjectUpdatesSort(sortValue);
  const createdAtExpression = "COALESCE(datetime(pu.created_at), '1970-01-01 00:00:00')";

  return normalizedSort === 'oldest'
    ? `ORDER BY pu.is_pinned DESC, ${createdAtExpression} ASC, pu.id ASC`
    : `ORDER BY pu.is_pinned DESC, ${createdAtExpression} DESC, pu.id DESC`;
}

async function resolveMusicPlaylistFilter(db, rawPlaylistValue) {
  const requestedPlaylist = String(rawPlaylistValue || '').trim();
  if (!requestedPlaylist) {
    return null;
  }

  const normalizedSlug = requestedPlaylist.toLowerCase();
  let playlist = await db.get('SELECT * FROM music_playlists WHERE slug = ?', normalizedSlug);

  if (!playlist && /^\d+$/.test(requestedPlaylist)) {
    playlist = await db.get('SELECT * FROM music_playlists WHERE id = ?', parseInt(requestedPlaylist, 10));
  }

  return playlist || null;
}

async function loadPreviewableContentBySlug(db, tableName, slug, previewToken, options = {}) {
  const { alias = '', extraWhere = '' } = options;
  const aliasPrefix = alias ? `${alias}.` : '';
  const visibilityClause = getPublicDirectVisibilityClause(alias || undefined);
  const extraClause = extraWhere ? `\n       ${extraWhere}` : '';

  let record = await db.get(
    `SELECT *
     FROM ${tableName}${alias ? ` ${alias}` : ''}
     WHERE ${aliasPrefix}slug = ?
       AND ${visibilityClause}${extraClause}`,
    slug
  );

  if (!record && previewToken) {
    record = await db.get(
      `SELECT *
       FROM ${tableName}${alias ? ` ${alias}` : ''}
       WHERE ${aliasPrefix}slug = ?
         AND ${aliasPrefix}preview_token = ?${extraClause}`,
      slug,
      previewToken
    );
  }

  return record;
}

async function buildHomepageEditorialSections(db, appLocals) {
  const sections = await db.all(
    `SELECT *
     FROM homepage_sections
     WHERE enabled = 1
     ORDER BY sort_order ASC, id ASC`
  );

  const resolvedSections = [];

  for (const section of sections) {
    const base = {
      ...section,
      title: section.title_override || '',
      bodyText: section.body_text || '',
      accentColour: section.accent_colour || '',
      styleMode: section.style_mode || 'default',
    };

    if (section.section_type === 'manifesto_block') {
      resolvedSections.push({ ...base, renderType: 'manifesto' });
      continue;
    }

    if (section.section_type === 'external_links_block') {
      const group = section.source_group || 'socials';
      const links = await db.all(
        `SELECT *
         FROM homepage_links
         WHERE section = ?
         ORDER BY COALESCE(order_index, 999999), title, id`,
        group
      );
      resolvedSections.push({ ...base, renderType: 'links', title: base.title || (group === 'socials' ? 'Socials' : 'Elsewhere'), links });
      continue;
    }

    if (section.section_type === 'featured_track' && section.linked_track_id) {
      const track = await db.get(
        `SELECT * FROM music WHERE id = ? AND ${getPublicDirectVisibilityClause()} AND filename IS NOT NULL AND TRIM(filename) != ''`,
        section.linked_track_id
      );
      if (track) {
        await attachTagsToItems(db, 'music', [track]);
        resolvedSections.push({
          ...base,
          renderType: 'feature-card',
          title: base.title || 'Featured track',
          item: {
            eyebrow: 'Track',
            title: track.title,
            meta: [track.artist, track.album].filter(Boolean).join(' / '),
            description: track.description || '',
            href: `/music/${track.slug}`,
            actionLabel: 'Play track',
            imageUrl: track.cover_image ? appLocals.getOriginalImageUrl('music', track.cover_image) : '',
          },
        });
      }
      continue;
    }

    if (section.section_type === 'featured_video' && section.linked_video_id) {
      const video = await db.get(
        `SELECT * FROM videos WHERE id = ? AND ${getPublicDirectVisibilityClause()} AND filename IS NOT NULL AND TRIM(filename) != ''`,
        section.linked_video_id
      );
      if (video) {
        resolvedSections.push({
          ...base,
          renderType: 'feature-card',
          title: base.title || 'Featured video',
          item: {
            eyebrow: 'Video',
            title: video.title,
            meta: 'Video',
            description: video.description || '',
            href: `/videos/${video.slug}`,
            actionLabel: 'Watch video',
            imageUrl: video.thumbnail ? `/uploads/videos/${video.thumbnail}` : '',
          },
        });
      }
      continue;
    }

    if (section.section_type === 'featured_gallery_image' && section.linked_gallery_id) {
      const galleryItem = await db.get(
        `SELECT * FROM gallery WHERE id = ? AND ${getPublicDirectVisibilityClause()}`,
        section.linked_gallery_id
      );
      if (galleryItem) {
        resolvedSections.push({
          ...base,
          renderType: 'feature-card',
          title: base.title || 'Featured image',
          item: {
            eyebrow: 'Gallery',
            title: galleryItem.title || 'Untitled image',
            meta: galleryItem.category || 'Image',
            description: galleryItem.caption || '',
            href: buildGalleryPath(galleryItem),
            actionLabel: 'View image',
            imageUrl: galleryItem.filename ? appLocals.getOriginalImageUrl('images', galleryItem.filename) : '',
          },
        });
      }
      continue;
    }

    if (
      section.section_type === 'hero_release'
      || section.section_type === 'featured_collection'
      || section.section_type === 'latest_releases'
    ) {
      continue;
    }

    if (section.section_type === 'ongoing_projects') {
      const params = [ONGOING_PROJECT_STATUS, section.item_limit || 6];
      let query =
        `SELECT * FROM projects
         WHERE ${getPublicListingVisibilityClause()}
           AND project_status = ?`;

      if (section.filter_tag) {
        query += ` AND EXISTS (
          SELECT 1 FROM tags t
          JOIN content_tags ct ON ct.tag_id = t.id
          WHERE ct.content_type = 'projects'
            AND ct.content_id = projects.id
            AND t.normalized_name = ?
        )`;
        params.splice(1, 0, String(section.filter_tag).trim().toLowerCase());
      }

      query += ' ORDER BY sort_order ASC, created_at DESC, id DESC LIMIT ?';
      const items = await db.all(query, ...params);
      items.forEach((project) => {
        project.projectStatusLabel = formatProjectStatusLabel(project.project_status);
      });
      resolvedSections.push({ ...base, renderType: 'project-grid', title: base.title || 'Ongoing projects', items });
      continue;
    }

    if (section.section_type === 'latest_updates') {
      const items = await db.all(
        `SELECT pu.*, p.title AS project_title, p.slug AS project_slug, p.hero_image AS project_hero_image
         FROM project_updates pu
         JOIN projects p ON p.id = pu.project_id
         WHERE ${getPublicDirectVisibilityClause('p')}
         ORDER BY pu.is_pinned DESC, pu.created_at DESC, pu.id DESC
         LIMIT ?`,
        section.item_limit || 6
      );
      resolvedSections.push({ ...base, renderType: 'updates-list', title: base.title || 'Latest updates', items });
      continue;
    }

    if (section.section_type === 'gallery_strip') {
      const params = [section.item_limit || 6];
      let query = `SELECT * FROM gallery WHERE ${getPublicListingVisibilityClause()}`;
      if (section.filter_tag) {
        query += ` AND EXISTS (
          SELECT 1 FROM tags t
          JOIN content_tags ct ON ct.tag_id = t.id
          WHERE ct.content_type = 'gallery'
            AND ct.content_id = gallery.id
            AND t.normalized_name = ?
        )`;
        params.unshift(String(section.filter_tag).trim().toLowerCase());
      }
      query += ' ORDER BY sort_order ASC, created_at DESC, id DESC LIMIT ?';
      const items = await db.all(query, ...params);
      resolvedSections.push({ ...base, renderType: 'gallery-strip', title: base.title || 'Gallery strip', items });
    }
  }

  return resolvedSections;
}
const DEFAULT_HOMEPAGE_SECTIONS = [
  {
    key: 'music',
    title: 'Music',
    description: 'Listen to tracks and albums.',
    href: '/music',
  },
  {
    key: 'videos',
    title: 'Videos',
    description: 'Watch a curated selection of video work.',
    href: '/videos',
  },
  {
    key: 'gallery',
    title: 'Gallery',
    description: 'Browse images and visual pieces.',
    href: '/gallery',
  },
  {
    key: 'projects',
    title: 'Projects',
    description: 'Explore ongoing and past projects.',
    href: '/projects',
  },
];

// home
router.get('/', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const homepageSettings = await getHomepageSettings(db);
    const editorialSections = await buildHomepageEditorialSections(db, req.app.locals);
    const rows = await db.all(
      `SELECT *
       FROM homepage_links
       ORDER BY section, COALESCE(order_index, 999999), title, id`
    );

    const featuredProject = homepageSettings.showProjects && homepageSettings.featuredProjectId
      ? await db.get(
        `SELECT id, title, slug, summary, project_status, hero_image
         FROM projects
         WHERE id = ?
           AND ${getPublicListingVisibilityClause()}`,
        homepageSettings.featuredProjectId
      )
      : null;
    const featuredTrack = homepageSettings.showMusic && homepageSettings.featuredTrackId
      ? await db.get(
        `SELECT id, slug, title, artist, album, description, cover_image
         FROM music
         WHERE id = ?
           AND ${getPublicListingVisibilityClause()}`,
        homepageSettings.featuredTrackId
      )
      : null;
    const featuredVideo = homepageSettings.showVideos && homepageSettings.featuredVideoId
      ? await db.get(
        `SELECT id, slug, title, description, thumbnail
         FROM videos
         WHERE id = ?
           AND ${getPublicListingVisibilityClause()}
           AND filename IS NOT NULL
           AND TRIM(filename) != ''`,
        homepageSettings.featuredVideoId
      )
      : null;

    const getOriginalImageUrl = req.app.locals.getOriginalImageUrl;
    const featuredItems = [
      featuredProject
        ? {
          type: 'Project',
          title: featuredProject.title,
          description: featuredProject.summary || 'A highlighted project from PARACAUSAL.',
          meta: formatProjectStatusLabel(featuredProject.project_status),
          href: `/projects/${featuredProject.slug}`,
          actionLabel: 'Open Project',
          imageUrl: featuredProject.hero_image ? getOriginalImageUrl('projects', featuredProject.hero_image) : '',
        }
        : null,
      featuredTrack
        ? {
          type: 'Track',
          title: featuredTrack.title,
          description: featuredTrack.description || 'A selected track from PARACAUSAL.',
          meta: [featuredTrack.artist, featuredTrack.album].filter(Boolean).join(' / '),
          href: `/music/${featuredTrack.slug}`,
          actionLabel: 'Open Track',
          imageUrl: featuredTrack.cover_image ? getOriginalImageUrl('music', featuredTrack.cover_image) : '',
        }
        : null,
      featuredVideo
        ? {
          type: 'Video',
          title: featuredVideo.title,
          description: featuredVideo.description || 'A selected video from PARACAUSAL.',
          meta: 'Video',
          href: `/videos/${featuredVideo.slug}`,
          actionLabel: 'Watch Video',
          imageUrl: featuredVideo.thumbnail ? `/uploads/videos/${featuredVideo.thumbnail}` : '',
        }
        : null,
    ].filter(Boolean);

    const homepageLinks = {
      socials: rows.filter((row) => row.section === 'socials'),
      other: rows.filter((row) => row.section === 'other'),
    };

    const homepageSections = DEFAULT_HOMEPAGE_SECTIONS.filter((section) => {
      if (section.key === 'music') return homepageSettings.showMusic;
      if (section.key === 'videos') return homepageSettings.showVideos;
      if (section.key === 'gallery') return homepageSettings.showGallery;
      if (section.key === 'projects') return homepageSettings.showProjects;
      return true;
    });

    trackPublicPageView(req, {
      requestPath: '/',
      pageType: 'home',
      contentType: 'home',
    });

    res.render('home', {
      homepageLinks,
      homepageSettings,
      homepageSections,
      editorialSections,
      featuredItems,
    });
  } catch (err) {
    console.error('Home route error:', err);
    res.render('home', {
      homepageSettings: DEFAULT_HOMEPAGE_SETTINGS,
      homepageSections: DEFAULT_HOMEPAGE_SECTIONS,
      editorialSections: [],
      featuredItems: [],
      homepageLinks: {
        socials: [],
        other: [],
      },
    });
  }
});

router.get('/music', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const resolvedPlaylist = await resolveMusicPlaylistFilter(db, req.query.playlist);
    // fetch playlists and optionally their items for sidebar
    const playlists = await db.all('SELECT * FROM music_playlists ORDER BY title');
    for (const pl of playlists) {
      pl.items = await db.all(
        `SELECT m.*
         FROM music m
         JOIN music_playlist_items mpi ON mpi.music_id = m.id
         WHERE mpi.playlist_id = ?
           AND ${getPublicListingVisibilityClause('m')}
         ORDER BY mpi.order_index`,
        pl.id
      );
    }

    let sql = `SELECT music.* FROM music WHERE ${getPublicListingVisibilityClause()}`;
    let params = [];

    // if filtering by playlist we will join, but keep search
    if (resolvedPlaylist) {
      sql = `SELECT m.* FROM music m
             JOIN music_playlist_items mpi ON mpi.music_id = m.id
             WHERE mpi.playlist_id = ?`;
      params = [resolvedPlaylist.id];
      sql += ` AND ${getPublicListingVisibilityClause('m')}`;
      if (req.query.search) {
        sql += ` AND (m.title LIKE ? OR m.artist LIKE ? OR m.album LIKE ? OR ${getTagMatchExistsClause('music', 'm.id')})`;
        const term = `%${req.query.search}%`;
        const normalizedTerm = `%${String(req.query.search).trim().toLowerCase()}%`;
        params.push(term, term, term, term, normalizedTerm);
      }
      sql += ' ORDER BY mpi.order_index, m.id';
    } else {
      if (req.query.search) {
        sql += ` AND (title LIKE ? OR artist LIKE ? OR album LIKE ? OR ${getTagMatchExistsClause('music', 'music.id')})`;
        const term = `%${req.query.search}%`;
        const normalizedTerm = `%${String(req.query.search).trim().toLowerCase()}%`;
        params.push(term, term, term, term, normalizedTerm);
      }
      sql += ' ORDER BY sort_order ASC, id DESC';
    }
    const tracks = await db.all(sql, ...params);
    await attachTagsToItems(db, 'music', tracks);
    trackPublicPageView(req, {
      requestPath: '/music',
      pageType: 'music',
      contentType: 'music',
    });
    res.render('music', {
      tracks,
      search: req.query.search || '',
      playlists,
      selectedPlaylist: resolvedPlaylist,
      pageMeta: buildPageMeta(req, {
        title: 'Music',
        description: 'Listen through music on PARACAUSAL.',
        canonicalPath: '/music',
      }),
    });
  } catch (err) {
    console.error('Music route error:', err.message);
    res.status(500).send('Error loading music: ' + err.message);
  }
});

router.get('/music/:slug', async (req, res) => {
  const db = req.app.locals.db;
  const getOriginalImageUrl = req.app.locals.getOriginalImageUrl;
  const requestedSlug = String(req.params.slug || '').trim();
  const previewToken = getRequestedPreviewToken(req);

  const track = await loadPreviewableContentBySlug(db, 'music', requestedSlug, previewToken, {
    extraWhere: "AND filename IS NOT NULL AND TRIM(filename) != ''",
  });

  if (!track) {
    return res.status(404).render('404');
  }

  const visibleTracks = await db.all(
    `SELECT *
     FROM music
     WHERE ${getPublicListingVisibilityClause()}
       AND filename IS NOT NULL
       AND TRIM(filename) != ''
     ORDER BY sort_order ASC, id DESC`
  );

  await attachTagsToItems(db, 'music', [track]);
  await attachTagsToItems(db, 'music', visibleTracks);

  const { durationSeconds, durationFormatted } = await getMusicTrackDurationDetails(track.filename);
  track.durationSeconds = durationSeconds;
  track.durationFormatted = durationFormatted;

  const currentTrackIndex = visibleTracks.findIndex((candidate) => candidate.id === track.id);
  const previousTrack = currentTrackIndex > 0
    ? visibleTracks[currentTrackIndex - 1]
    : null;
  const nextTrack = currentTrackIndex >= 0 && currentTrackIndex < visibleTracks.length - 1
    ? visibleTracks[currentTrackIndex + 1]
    : null;
  const relatedTracks = chooseRelatedTracks(
    track,
    visibleTracks.filter((candidate) => candidate.id !== track.id),
    4
  );
  const playerQueue = visibleTracks.map((candidate) => ({
    id: candidate.id,
    filename: candidate.filename,
    slug: candidate.slug || '',
    title: candidate.title,
    artist: candidate.artist || '',
    album: candidate.album || '',
    year: candidate.year || '',
    description: candidate.description || '',
    tags: Array.isArray(candidate.tags) ? candidate.tags : [],
    coverUrl: candidate.cover_image ? getOriginalImageUrl('music', candidate.cover_image) : '',
    coverAlt: `${candidate.title} cover`,
  }));
  const trackUrl = `${req.protocol}://${req.get('host')}/music/${track.slug}`;
  const trackConnections = await loadTrackConnections(db, track.id);

  trackPublicPageView(req, {
    requestPath: `/music/${track.slug}`,
    pageType: 'music_detail',
    contentType: 'music',
    contentId: track.id,
    contentSlug: track.slug,
  });

  return res.render('music_detail', {
    track,
    previewMode: !!previewToken,
    trackUrl,
    previousTrack,
    nextTrack,
    relatedTracks,
    playerQueue,
    relatedVideos: trackConnections.relatedVideos,
    relatedProjects: trackConnections.relatedProjects,
    pageMeta: buildPageMeta(req, {
      title: track.title,
      description: track.description || [track.artist, track.album].filter(Boolean).join(' / '),
      image: track.cover_image ? getOriginalImageUrl('music', track.cover_image) : '',
      type: 'music.song',
      canonicalPath: `/music/${track.slug}`,
    }),
  });
});

router.get('/videos', async (req, res) => {
  const db = req.app.locals.db;
  const playlists = await db.all('SELECT * FROM video_playlists ORDER BY title');
  for (const pl of playlists) {
    pl.items = await db.all(
      `SELECT v.*
       FROM videos v
       JOIN video_playlist_items vpi ON vpi.video_id = v.id
       WHERE vpi.playlist_id = ?
         AND ${getPublicListingVisibilityClause('v')}
         AND v.filename IS NOT NULL
         AND TRIM(v.filename) != ''
       ORDER BY vpi.order_index`,
      pl.id
    );
  }

  let sql = 'SELECT videos.* FROM videos';
  const params = [];
  const whereClauses = [
    getPublicListingVisibilityClause(),
    'filename IS NOT NULL',
    "TRIM(filename) != ''",
  ];

  if (req.query.playlist) {
    sql = `SELECT v.* FROM videos v
           JOIN video_playlist_items vpi ON vpi.video_id = v.id
           WHERE vpi.playlist_id = ?
             AND ${getPublicListingVisibilityClause('v')}
             AND v.filename IS NOT NULL
             AND TRIM(v.filename) != ''`;
    params.push(req.query.playlist);
    if (req.query.search) {
      sql += ` AND (v.title LIKE ? OR v.description LIKE ? OR ${getTagMatchExistsClause('videos', 'v.id')})`;
      const term = `%${req.query.search}%`;
      const normalizedTerm = `%${String(req.query.search).trim().toLowerCase()}%`;
      params.push(term, term, term, normalizedTerm);
    }
  } else {
    if (req.query.search) {
      whereClauses.push(`(title LIKE ? OR description LIKE ? OR ${getTagMatchExistsClause('videos', 'videos.id')})`);
      const term = `%${req.query.search}%`;
      const normalizedTerm = `%${String(req.query.search).trim().toLowerCase()}%`;
      params.push(term, term, term, normalizedTerm);
    }

    sql += ' WHERE ' + whereClauses.join(' AND ');
  }
  sql += ' ORDER BY sort_order ASC, created_at DESC, id DESC';
  const videos = await db.all(sql, ...params);
  await attachTagsToItems(db, 'videos', videos);
  trackPublicPageView(req, {
    requestPath: '/videos',
    pageType: 'videos',
    contentType: 'videos',
  });
  res.render('videos', {
    videos,
    search: req.query.search || '',
    playlists,
    selectedPlaylist: req.query.playlist || null,
    pageMeta: buildPageMeta(req, {
      title: 'Videos',
      description: 'Watch video work from PARACAUSAL.',
      canonicalPath: '/videos',
    }),
  });
});

router.get('/gallery', async (req, res) => {
  const db = req.app.locals.db;
  const collections = await db.all(
    `SELECT gc.*, COUNT(g.id) AS count
     FROM gallery_collections gc
     LEFT JOIN gallery_collection_items gci ON gci.collection_id = gc.id
     LEFT JOIN gallery g ON g.id = gci.gallery_id AND ${getPublicListingVisibilityClause('g')}
     GROUP BY gc.id
     ORDER BY LOWER(gc.title) ASC, gc.id ASC`
  );
  const selectedCollectionId = parseInt(req.query.collection, 10);
  const selectedCollection = Number.isInteger(selectedCollectionId)
    ? collections.find((collection) => collection.id === selectedCollectionId) || null
    : null;

  let sql = 'SELECT g.* FROM gallery g';
  const params = [];
  const whereClauses = [getPublicListingVisibilityClause('g')];

  if (selectedCollection) {
    sql += ' JOIN gallery_collection_items gci ON gci.gallery_id = g.id';
    whereClauses.push('gci.collection_id = ?');
    params.push(selectedCollection.id);
  }

  if (req.query.search) {
    whereClauses.push(`(g.title LIKE ? OR g.caption LIKE ? OR g.category LIKE ? OR ${getTagMatchExistsClause('gallery', 'g.id')})`);
    const term = `%${req.query.search}%`;
    const normalizedTerm = `%${String(req.query.search).trim().toLowerCase()}%`;
    params.push(term, term, term, term, normalizedTerm);
  }

  sql += ' WHERE ' + whereClauses.join(' AND ');
  sql += ' ORDER BY g.sort_order ASC, g.created_at DESC, g.id DESC';
  const images = await db.all(sql, ...params);
  await attachTagsToItems(db, 'gallery', images);

  trackPublicPageView(req, {
    requestPath: '/gallery',
    pageType: 'gallery',
    contentType: 'gallery',
  });

  res.render('gallery', {
    images,
    search: req.query.search || '',
    collections,
    selectedCollection: selectedCollection ? selectedCollection.id : null,
    selectedCollectionInfo: selectedCollection,
    pageMeta: buildPageMeta(req, {
      title: 'Gallery',
      description: 'Browse images and visual pieces from PARACAUSAL.',
      canonicalPath: '/gallery',
    }),
  });
});

router.get('/gallery/:slug', async (req, res) => {
  const db = req.app.locals.db;
  const previewToken = getRequestedPreviewToken(req);
  const requestedIdentifier = String(req.params.slug || '').trim();
  let image = null;

  if (/^\d+$/.test(requestedIdentifier)) {
    const legacyId = parseInt(requestedIdentifier, 10);
    image = previewToken
      ? await db.get(
        `SELECT *
         FROM gallery
         WHERE id = ?
           AND (preview_token = ? OR ${getPublicDirectVisibilityClause()})`,
        legacyId,
        previewToken
      )
      : await db.get(
        `SELECT *
         FROM gallery
         WHERE id = ?
           AND ${getPublicDirectVisibilityClause()}`,
        legacyId
      );

    if (image && image.slug) {
      return res.redirect(301, buildGalleryPath(image));
    }
  }

  if (!image) {
    image = await loadPreviewableContentBySlug(db, 'gallery', requestedIdentifier, previewToken);
  }

  if (!image) {
    return res.status(404).render('404');
  }

  await attachTagsToItems(db, 'gallery', [image]);
  const galleryConnections = await loadGalleryConnections(db, image.id);
  const galleryPath = buildGalleryPath(image);
  trackPublicPageView(req, {
    requestPath: galleryPath,
    pageType: 'gallery_detail',
    contentType: 'gallery',
    contentId: image.id,
    contentSlug: image.slug || null,
  });

  return res.render('gallery_detail', {
    image,
    previewMode: !!previewToken,
    relatedProjects: galleryConnections.relatedProjects,
    pageMeta: buildPageMeta(req, {
      title: image.title || 'Gallery Item',
      description: image.caption || image.category || 'A visual piece from PARACAUSAL.',
      image: image.filename ? req.app.locals.getOriginalImageUrl('images', image.filename) : '',
      canonicalPath: galleryPath,
    }),
  });
});

router.get('/projects', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const collections = await db.all(
      `SELECT pc.*, COUNT(p.id) AS item_count
       FROM project_collections pc
       LEFT JOIN project_collection_items pci ON pci.collection_id = pc.id
       LEFT JOIN projects p ON p.id = pci.project_id AND ${getPublicListingVisibilityClause('p')}
       GROUP BY pc.id
       ORDER BY LOWER(pc.title) ASC, pc.id ASC`
    );
    const selectedCollectionId = parseInt(req.query.collection, 10);
    const selectedCollection = Number.isInteger(selectedCollectionId)
      ? collections.find((collection) => collection.id === selectedCollectionId) || null
      : null;
    const sort = (() => {
      const normalizedSort = String(req.query.sort || 'newest').trim().toLowerCase();
      if (['newest', 'oldest', ONGOING_PROJECT_STATUS, CLOSED_PROJECT_STATUS].includes(normalizedSort)) {
        return normalizedSort;
      }

      return 'newest';
    })();

    const whereClauses = [];
    const params = [];
    let fromClause = ' FROM projects p ';

    if (selectedCollection) {
      fromClause += ' JOIN project_collection_items pci ON pci.project_id = p.id ';
      whereClauses.push('pci.collection_id = ?');
      params.push(selectedCollection.id);
    }

    whereClauses.push(getPublicListingVisibilityClause('p'));

    if (req.query.search) {
      whereClauses.push(`(p.title LIKE ? OR p.summary LIKE ? OR ${getTagMatchExistsClause('projects', 'p.id')})`);
      const term = `%${req.query.search}%`;
      const normalizedTerm = `%${String(req.query.search).trim().toLowerCase()}%`;
      params.push(term, term, term, normalizedTerm);
    }

    const projectStatusFilter = normalizeProjectStatusFilter(sort);
    if (projectStatusFilter) {
      whereClauses.push('COALESCE(p.project_status, ?) = ?');
      params.push(ONGOING_PROJECT_STATUS, projectStatusFilter);
    }

    let sql = 'SELECT p.*' + fromClause;
    if (whereClauses.length) {
      sql += ' WHERE ' + whereClauses.join(' AND ');
    }

    // determine order
    let order = 'p.sort_order ASC, p.created_at DESC, p.id DESC';
    if (sort === 'oldest') order = 'p.created_at ASC, p.id ASC';
    if (sort === 'newest') order = 'p.created_at DESC, p.id DESC';

    sql += ' ORDER BY ' + order;

    const projects = await db.all(sql, ...params);
    await attachTagsToItems(db, 'projects', projects);
    projects.forEach((project) => {
      project.projectStatusLabel = formatProjectStatusLabel(project.project_status);
    });
    trackPublicPageView(req, {
      requestPath: '/projects',
      pageType: 'projects',
      contentType: 'projects',
    });
    return res.render('projects', {
      projects,
      search: req.query.search || '',
      sort,
      collections,
      selectedCollection: selectedCollection ? selectedCollection.id : null,
      selectedCollectionInfo: selectedCollection,
      pageMeta: buildPageMeta(req, {
        title: 'Projects',
        description: 'Explore project work in PARACAUSAL.',
        canonicalPath: '/projects',
      }),
    });
  } catch (err) {
    console.error('Projects route error:', err);
    return res.render('projects', {
      projects: [],
      search: req.query.search || '',
      collections: [],
      selectedCollection: null,
      selectedCollectionInfo: null,
      sort: (() => {
        const normalizedSort = String(req.query.sort || 'newest').trim().toLowerCase();
        if (['newest', 'oldest', ONGOING_PROJECT_STATUS, CLOSED_PROJECT_STATUS].includes(normalizedSort)) {
          return normalizedSort;
        }

        return 'newest';
      })(),
      pageMeta: buildPageMeta(req, {
        title: 'Projects',
        description: 'Explore project work in PARACAUSAL.',
        canonicalPath: '/projects',
      }),
    });
  }
});

router.get('/releases', async (req, res) => res.status(404).render('404'));

router.get('/releases/:slug', async (req, res) => res.status(404).render('404'));

router.get('/collections', async (req, res) => res.status(404).render('404'));

router.get('/collections/:slug', async (req, res) => res.status(404).render('404'));

router.get('/search', async (req, res) => {
  const db = req.app.locals.db;
  const query = req.query.q || '';
  const emptyResults = {
    music: [],
    videos: [],
    gallery: [],
    projects: [],
  };

  if (!query) {
    trackPublicPageView(req, {
      requestPath: '/search',
      pageType: 'search',
      contentType: 'search',
    });
    return res.render('search', {
      results: emptyResults,
      query,
      pageMeta: buildPageMeta(req, {
        title: 'Search',
        description: 'Search PARACAUSAL.',
        canonicalPath: '/search',
      }),
    });
  }

  const results = { ...emptyResults };
  results.music = await db.all(
    `SELECT *
     FROM music
     WHERE ${getPublicListingVisibilityClause()}
       AND (
         title LIKE ? OR artist LIKE ? OR album LIKE ? OR description LIKE ?
         OR ${getTagMatchExistsClause('music', 'music.id')}
       )`,
    `%${query}%`,
    `%${query}%`,
    `%${query}%`,
    `%${query}%`,
    `%${String(query).trim().toLowerCase()}%`
  );
  results.videos = await db.all(
    `SELECT *
     FROM videos
     WHERE ${getPublicListingVisibilityClause()}
       AND filename IS NOT NULL
       AND TRIM(filename) != ''
       AND (
         title LIKE ? OR description LIKE ?
         OR ${getTagMatchExistsClause('videos', 'videos.id')}
       )`,
    `%${query}%`,
    `%${query}%`,
    `%${String(query).trim().toLowerCase()}%`
  );
  results.gallery = await db.all(
    `SELECT *
     FROM gallery
     WHERE ${getPublicListingVisibilityClause()}
       AND (
         title LIKE ? OR caption LIKE ? OR category LIKE ?
         OR ${getTagMatchExistsClause('gallery', 'gallery.id')}
       )`,
    `%${query}%`,
    `%${query}%`,
    `%${query}%`,
    `%${String(query).trim().toLowerCase()}%`
  );
  results.projects = await db.all(
    `SELECT *
     FROM projects
     WHERE ${getPublicListingVisibilityClause()}
       AND (
         title LIKE ? OR summary LIKE ? OR description LIKE ?
         OR EXISTS (
           SELECT 1
           FROM project_updates pu
           WHERE pu.project_id = projects.id
             AND pu.content LIKE ?
         )
         OR ${getTagMatchExistsClause('projects', 'projects.id')}
       )`,
    `%${query}%`,
    `%${query}%`,
    `%${query}%`,
    `%${query}%`,
    `%${String(query).trim().toLowerCase()}%`
  );

  await attachTagsToItems(db, 'music', results.music);
  await attachTagsToItems(db, 'videos', results.videos);
  await attachTagsToItems(db, 'gallery', results.gallery);
  await attachTagsToItems(db, 'projects', results.projects);

  trackPublicPageView(req, {
    requestPath: '/search',
    pageType: 'search',
    contentType: 'search',
  });

  res.render('search', {
    results,
    query,
    pageMeta: buildPageMeta(req, {
      title: `Search: ${query}`,
      description: `Search results for ${query} across music, videos, gallery and projects.`,
      canonicalPath: `/search?q=${encodeURIComponent(query)}`,
    }),
  });
});

router.get('/tags/:tag', async (req, res) => {
  const db = req.app.locals.db;
  const tag = await getTagByNormalizedName(db, req.params.tag);
  if (!tag) {
    return res.status(404).render('404');
  }

  const results = {
    music: [],
    videos: [],
    gallery: [],
    projects: [],
  };
  results.music = await db.all(
    `SELECT m.*
     FROM music m
     JOIN music_tags mt ON mt.music_id = m.id
     WHERE mt.tag_id = ?
       AND ${getPublicListingVisibilityClause('m')}
     ORDER BY m.sort_order ASC, m.id DESC`,
    tag.id
  );
  results.videos = await db.all(
    `SELECT v.*
     FROM videos v
     JOIN video_tags vt ON vt.video_id = v.id
     WHERE vt.tag_id = ?
       AND ${getPublicListingVisibilityClause('v')}
       AND v.filename IS NOT NULL
       AND TRIM(v.filename) != ''
     ORDER BY v.sort_order ASC, v.created_at DESC, v.id DESC`,
    tag.id
  );
  results.gallery = await db.all(
    `SELECT g.*
     FROM gallery g
     JOIN gallery_tags gt ON gt.gallery_id = g.id
     WHERE gt.tag_id = ?
       AND ${getPublicListingVisibilityClause('g')}
     ORDER BY g.sort_order ASC, g.created_at DESC, g.id DESC`,
    tag.id
  );
  results.projects = await db.all(
    `SELECT p.*
     FROM projects p
     JOIN project_tags pt ON pt.project_id = p.id
     WHERE pt.tag_id = ?
       AND ${getPublicListingVisibilityClause('p')}
     ORDER BY p.sort_order ASC, p.created_at DESC, p.id DESC`,
    tag.id
  );

  await attachTagsToItems(db, 'music', results.music);
  await attachTagsToItems(db, 'videos', results.videos);
  await attachTagsToItems(db, 'gallery', results.gallery);
  await attachTagsToItems(db, 'projects', results.projects);
  const backLink = getTagBackLink(results, req.query.from);

  trackPublicPageView(req, {
    requestPath: `/tags/${tag.normalized_name}`,
    pageType: 'tag',
    contentType: 'tag',
    contentSlug: tag.normalized_name,
  });

  return res.render('tag', {
    tag,
    results,
    backLink,
  });
});

router.get('/videos/:slug', async (req, res) => {
  const db = req.app.locals.db;
  const requestedSlug = String(req.params.slug || '').trim();
  const previewToken = getRequestedPreviewToken(req);

  if (/^\d+$/.test(requestedSlug)) {
    const legacyVideo = await db.get(
      `SELECT id, slug
       FROM videos
       WHERE id = ?
         AND ${getPublicDirectVisibilityClause()}
         AND filename IS NOT NULL
         AND TRIM(filename) != ''`,
      parseInt(requestedSlug, 10)
    );

    if (!legacyVideo) {
      return res.status(404).render('404');
    }

    return res.redirect(301, `/videos/${legacyVideo.slug}`);
  }

  const video = await loadPreviewableContentBySlug(db, 'videos', requestedSlug, previewToken, {
    extraWhere: "AND filename IS NOT NULL AND TRIM(filename) != ''",
  });

  if (!video) return res.status(404).render('404');
  await attachTagsToItems(db, 'videos', [video]);
  trackPublicPageView(req, {
    requestPath: `/videos/${video.slug}`,
    pageType: 'video_detail',
    contentType: 'video',
    contentId: video.id,
    contentSlug: video.slug,
  });
  res.render('video_detail', {
    video,
    previewMode: !!previewToken,
    pageMeta: buildPageMeta(req, {
      title: video.title,
      description: video.description || 'Video work from PARACAUSAL.',
      image: video.thumbnail ? `/uploads/videos/${video.thumbnail}` : '',
      canonicalPath: `/videos/${video.slug}`,
    }),
  });
});

router.get('/projects/:slug', async (req, res) => {
  const db = req.app.locals.db;
  const previewToken = getRequestedPreviewToken(req);
  const updatesSort = normalizeProjectUpdatesSort(req.query.updates);
  const updatesOrderClause = getProjectUpdatesOrderClause(updatesSort);
  const project = await loadPreviewableContentBySlug(db, 'projects', req.params.slug, previewToken);
  if (!project) return res.status(404).render('404');
  await attachTagsToItems(db, 'projects', [project]);
  project.projectStatusLabel = formatProjectStatusLabel(project.project_status);
  const updates = await db.all(
    `SELECT pu.*
     FROM project_updates pu
     WHERE pu.project_id = ?
     ${updatesOrderClause}`,
    project.id
  );
  const documents = await db.all('SELECT * FROM project_documents WHERE project_id = ?', project.id);
  // Add attachments to updates
  for (const update of updates) {
    update.attachments = await db.all('SELECT * FROM project_update_attachments WHERE update_id = ?', update.id);
  }
  const [relatedTracks, relatedVideos, relatedGallery] = await Promise.all([
    loadConnectedMusicItems(db, project.id),
    loadConnectedVideoItems(db, project.id),
    loadConnectedGalleryItems(db, project.id),
  ]);
  trackPublicPageView(req, {
    requestPath: `/projects/${project.slug}`,
    pageType: 'project_detail',
    contentType: 'project',
    contentSlug: project.slug,
  });
  res.render('project_detail', {
    project,
    updates,
    previewMode: !!previewToken,
    previewToken,
    updatesSort,
    documents,
    relatedTracks,
    relatedVideos,
    relatedGallery,
    pageMeta: buildPageMeta(req, {
      title: project.title,
      description: project.summary || project.description || 'Project work from PARACAUSAL.',
      image: project.hero_image ? req.app.locals.getOriginalImageUrl('projects', project.hero_image) : '',
      canonicalPath: `/projects/${project.slug}`,
    }),
  });
});

module.exports = router;