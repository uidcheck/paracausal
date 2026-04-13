PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  two_factor_secret TEXT,
  two_factor_enabled INTEGER NOT NULL DEFAULT 0,
  two_factor_recovery_codes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS music (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  slug TEXT,
  artist TEXT,
  album TEXT,
  year INTEGER,
  description TEXT,
  lyrics TEXT,
  publication_status TEXT NOT NULL DEFAULT 'published',
  published_at DATETIME,
  sort_order INTEGER NOT NULL DEFAULT 0,
  filename TEXT NOT NULL,
  cover_image TEXT,
  order_index INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  slug TEXT,
  description TEXT,
  publication_status TEXT NOT NULL DEFAULT 'published',
  published_at DATETIME,
  sort_order INTEGER NOT NULL DEFAULT 0,
  filename TEXT NOT NULL,
  thumbnail TEXT,
  category TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS gallery (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  slug TEXT,
  caption TEXT,
  publication_status TEXT NOT NULL DEFAULT 'published',
  published_at DATETIME,
  sort_order INTEGER NOT NULL DEFAULT 0,
  filename TEXT NOT NULL,
  category TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  summary TEXT,
  description TEXT,
  project_status TEXT NOT NULL DEFAULT 'ongoing',
  publication_status TEXT NOT NULL DEFAULT 'published',
  published_at DATETIME,
  preview_token TEXT,
  tools_used TEXT,
  stack_used TEXT,
  started_on DATE,
  completed_on DATE,
  accent_colour TEXT,
  visual_style TEXT NOT NULL DEFAULT 'default',
  sort_order INTEGER NOT NULL DEFAULT 0,
  tags TEXT,
  hero_image TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  subtitle TEXT,
  release_type TEXT NOT NULL DEFAULT 'single',
  cover_image TEXT,
  release_date DATE,
  notes TEXT,
  credits TEXT,
  publication_status TEXT NOT NULL DEFAULT 'published',
  published_at DATETIME,
  preview_token TEXT,
  accent_colour TEXT,
  visual_style TEXT NOT NULL DEFAULT 'default',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS release_related_items (
  release_id INTEGER NOT NULL,
  related_release_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (release_id, related_release_id),
  FOREIGN KEY(release_id) REFERENCES releases(id) ON DELETE CASCADE,
  FOREIGN KEY(related_release_id) REFERENCES releases(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS curated_collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  hero_image TEXT,
  publication_status TEXT NOT NULL DEFAULT 'published',
  published_at DATETIME,
  preview_token TEXT,
  accent_colour TEXT,
  visual_style TEXT NOT NULL DEFAULT 'default',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS curated_collection_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collection_id INTEGER NOT NULL,
  item_type TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  order_index INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(collection_id) REFERENCES curated_collections(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS homepage_sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  section_type TEXT NOT NULL,
  title_override TEXT,
  body_text TEXT,
  item_limit INTEGER NOT NULL DEFAULT 6,
  enabled INTEGER NOT NULL DEFAULT 1,
  linked_release_id INTEGER,
  linked_track_id INTEGER,
  linked_video_id INTEGER,
  linked_gallery_id INTEGER,
  linked_collection_id INTEGER,
  source_group TEXT,
  filter_tag TEXT,
  accent_colour TEXT,
  style_mode TEXT NOT NULL DEFAULT 'default',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(linked_release_id) REFERENCES releases(id) ON DELETE SET NULL,
  FOREIGN KEY(linked_track_id) REFERENCES music(id) ON DELETE SET NULL,
  FOREIGN KEY(linked_video_id) REFERENCES videos(id) ON DELETE SET NULL,
  FOREIGN KEY(linked_gallery_id) REFERENCES gallery(id) ON DELETE SET NULL,
  FOREIGN KEY(linked_collection_id) REFERENCES curated_collections(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS release_music_items (
  release_id INTEGER NOT NULL,
  music_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (release_id, music_id),
  FOREIGN KEY(release_id) REFERENCES releases(id) ON DELETE CASCADE,
  FOREIGN KEY(music_id) REFERENCES music(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS release_video_items (
  release_id INTEGER NOT NULL,
  video_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (release_id, video_id),
  FOREIGN KEY(release_id) REFERENCES releases(id) ON DELETE CASCADE,
  FOREIGN KEY(video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS release_gallery_items (
  release_id INTEGER NOT NULL,
  gallery_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (release_id, gallery_id),
  FOREIGN KEY(release_id) REFERENCES releases(id) ON DELETE CASCADE,
  FOREIGN KEY(gallery_id) REFERENCES gallery(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS release_project_items (
  release_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (release_id, project_id),
  FOREIGN KEY(release_id) REFERENCES releases(id) ON DELETE CASCADE,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_music_links (
  project_id INTEGER NOT NULL,
  music_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project_id, music_id),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(music_id) REFERENCES music(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_video_links (
  project_id INTEGER NOT NULL,
  video_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project_id, video_id),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_gallery_links (
  project_id INTEGER NOT NULL,
  gallery_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project_id, gallery_id),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(gallery_id) REFERENCES gallery(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS music_video_links (
  music_id INTEGER NOT NULL,
  video_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (music_id, video_id),
  FOREIGN KEY(music_id) REFERENCES music(id) ON DELETE CASCADE,
  FOREIGN KEY(video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS music_project_links (
  music_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (music_id, project_id),
  FOREIGN KEY(music_id) REFERENCES music(id) ON DELETE CASCADE,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS gallery_project_links (
  gallery_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (gallery_id, project_id),
  FOREIGN KEY(gallery_id) REFERENCES gallery(id) ON DELETE CASCADE,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS music_tags (
  music_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (music_id, tag_id),
  FOREIGN KEY(music_id) REFERENCES music(id) ON DELETE CASCADE,
  FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS video_tags (
  video_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (video_id, tag_id),
  FOREIGN KEY(video_id) REFERENCES videos(id) ON DELETE CASCADE,
  FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS gallery_tags (
  gallery_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (gallery_id, tag_id),
  FOREIGN KEY(gallery_id) REFERENCES gallery(id) ON DELETE CASCADE,
  FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_tags (
  project_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project_id, tag_id),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  title TEXT,
  content TEXT NOT NULL,
  update_kind TEXT NOT NULL DEFAULT 'note',
  is_pinned INTEGER NOT NULL DEFAULT 0,
  image_filename TEXT,
  linked_video_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(linked_video_id) REFERENCES videos(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS project_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_update_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  update_id INTEGER NOT NULL,
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(update_id) REFERENCES project_updates(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS music_playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  slug TEXT UNIQUE,
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS music_playlist_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  playlist_id INTEGER NOT NULL,
  music_id INTEGER NOT NULL,
  order_index INTEGER,
  FOREIGN KEY(playlist_id) REFERENCES music_playlists(id) ON DELETE CASCADE,
  FOREIGN KEY(music_id) REFERENCES music(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS video_playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS video_playlist_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  playlist_id INTEGER NOT NULL,
  video_id INTEGER NOT NULL,
  order_index INTEGER,
  FOREIGN KEY(playlist_id) REFERENCES video_playlists(id) ON DELETE CASCADE,
  FOREIGN KEY(video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS gallery_collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS gallery_collection_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collection_id INTEGER NOT NULL,
  gallery_id INTEGER NOT NULL,
  order_index INTEGER,
  FOREIGN KEY(collection_id) REFERENCES gallery_collections(id) ON DELETE CASCADE,
  FOREIGN KEY(gallery_id) REFERENCES gallery(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS project_collection_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collection_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  order_index INTEGER,
  FOREIGN KEY(collection_id) REFERENCES project_collections(id) ON DELETE CASCADE,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS homepage_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  section TEXT NOT NULL,
  description TEXT,
  order_index INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS homepage_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  heading_override TEXT,
  intro_text TEXT,
  tagline TEXT,
  featured_project_id INTEGER,
  featured_track_id INTEGER,
  featured_video_id INTEGER,
  show_music INTEGER NOT NULL DEFAULT 1,
  show_videos INTEGER NOT NULL DEFAULT 1,
  show_gallery INTEGER NOT NULL DEFAULT 1,
  show_projects INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(featured_project_id) REFERENCES projects(id) ON DELETE SET NULL,
  FOREIGN KEY(featured_track_id) REFERENCES music(id) ON DELETE SET NULL,
  FOREIGN KEY(featured_video_id) REFERENCES videos(id) ON DELETE SET NULL
);

INSERT OR IGNORE INTO homepage_settings (
  id,
  intro_text,
  show_music,
  show_videos,
  show_gallery,
  show_projects
) VALUES (
  1,
  'A collection of music, media and experimental projects.',
  1,
  1,
  1,
  1
);

CREATE TABLE IF NOT EXISTS analytics_page_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_path TEXT NOT NULL,
  page_type TEXT NOT NULL,
  content_type TEXT,
  content_id INTEGER,
  content_slug TEXT,
  referrer_host TEXT,
  viewed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_analytics_page_views_viewed_at
  ON analytics_page_views(viewed_at);

CREATE INDEX IF NOT EXISTS idx_analytics_page_views_request_path
  ON analytics_page_views(request_path);

CREATE INDEX IF NOT EXISTS idx_analytics_page_views_page_type
  ON analytics_page_views(page_type);

CREATE INDEX IF NOT EXISTS idx_analytics_page_views_content
  ON analytics_page_views(content_type, content_id, content_slug);

CREATE UNIQUE INDEX IF NOT EXISTS idx_videos_slug_unique
  ON videos(slug);

CREATE UNIQUE INDEX IF NOT EXISTS idx_gallery_slug_unique
  ON gallery(slug);

CREATE INDEX IF NOT EXISTS idx_music_published_at
  ON music(published_at);

CREATE INDEX IF NOT EXISTS idx_videos_published_at
  ON videos(published_at);

CREATE INDEX IF NOT EXISTS idx_gallery_published_at
  ON gallery(published_at);

CREATE INDEX IF NOT EXISTS idx_projects_published_at
  ON projects(published_at);

CREATE INDEX IF NOT EXISTS idx_releases_publication_status
  ON releases(publication_status);

CREATE INDEX IF NOT EXISTS idx_curated_collections_publication_status
  ON curated_collections(publication_status);

CREATE INDEX IF NOT EXISTS idx_releases_published_at
  ON releases(published_at);

CREATE INDEX IF NOT EXISTS idx_curated_collections_published_at
  ON curated_collections(published_at);

CREATE INDEX IF NOT EXISTS idx_releases_release_date
  ON releases(release_date);

CREATE INDEX IF NOT EXISTS idx_curated_collections_sort_order
  ON curated_collections(sort_order);

CREATE INDEX IF NOT EXISTS idx_homepage_sections_sort_order
  ON homepage_sections(sort_order);

CREATE INDEX IF NOT EXISTS idx_homepage_sections_enabled
  ON homepage_sections(enabled);

CREATE INDEX IF NOT EXISTS idx_curated_collection_items_collection_order
  ON curated_collection_items(collection_id, order_index, id);

CREATE INDEX IF NOT EXISTS idx_curated_collection_items_lookup
  ON curated_collection_items(item_type, item_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_curated_collection_items_unique
  ON curated_collection_items(collection_id, item_type, item_id);

CREATE INDEX IF NOT EXISTS idx_release_related_items_related
  ON release_related_items(related_release_id);

-- Sessions table for persistent express-session storage
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expiresAt DATETIME NOT NULL
);