const TAG_RELATION_CONFIG = {
  music: {
    joinTable: 'music_tags',
    contentColumn: 'music_id',
  },
  videos: {
    joinTable: 'video_tags',
    contentColumn: 'video_id',
  },
  gallery: {
    joinTable: 'gallery_tags',
    contentColumn: 'gallery_id',
  },
  projects: {
    joinTable: 'project_tags',
    contentColumn: 'project_id',
  },
};

function getTagRelationConfig(contentType) {
  if (typeof contentType !== 'string') {
    return null;
  }

  return TAG_RELATION_CONFIG[contentType] || null;
}

function cleanTagDisplayName(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().replace(/\s+/g, ' ');
}

function normalizeTagName(value) {
  const cleanedValue = cleanTagDisplayName(value);
  if (!cleanedValue) {
    return '';
  }

  return cleanedValue.toLowerCase();
}

function serializeTag(tag) {
  if (!tag) {
    return null;
  }

  const name = cleanTagDisplayName(tag.name || tag.tag_name || '');
  const normalizedName = normalizeTagName(tag.normalizedName || tag.normalized_name || name);
  if (!name || !normalizedName) {
    return null;
  }

  return {
    id: tag.id || tag.tag_id || null,
    name,
    normalizedName,
    urlPath: `/tags/${encodeURIComponent(normalizedName)}`,
  };
}

function parseTagInput(rawInput) {
  const sourceValues = Array.isArray(rawInput)
    ? rawInput
    : String(rawInput || '').split(',');
  const seen = new Set();
  const parsedTags = [];

  sourceValues.forEach((fragment) => {
    const name = cleanTagDisplayName(fragment);
    const normalizedName = normalizeTagName(name);
    if (!name || !normalizedName || seen.has(normalizedName)) {
      return;
    }

    seen.add(normalizedName);
    parsedTags.push(serializeTag({ name, normalizedName }));
  });

  return parsedTags;
}

function formatTagInput(tags) {
  if (!Array.isArray(tags) || !tags.length) {
    return '';
  }

  return tags
    .map((tag) => serializeTag(tag))
    .filter(Boolean)
    .map((tag) => tag.name)
    .join(', ');
}

function getTagMatchExistsClause(contentType, contentIdExpression) {
  const config = getTagRelationConfig(contentType);
  if (!config || !contentIdExpression) {
    throw new Error('Unknown content type for tag match clause.');
  }

  return `EXISTS (
    SELECT 1
    FROM ${config.joinTable} content_tags
    JOIN tags search_tags ON search_tags.id = content_tags.tag_id
    WHERE content_tags.${config.contentColumn} = ${contentIdExpression}
      AND (search_tags.name LIKE ? OR search_tags.normalized_name LIKE ?)
  )`;
}

async function getOrCreateTagId(db, tag) {
  const serializedTag = serializeTag(tag);
  if (!serializedTag) {
    return null;
  }

  const existingTag = await db.get(
    'SELECT id, name, normalized_name FROM tags WHERE normalized_name = ?',
    serializedTag.normalizedName
  );
  if (existingTag) {
    return existingTag.id;
  }

  const result = await db.run(
    'INSERT INTO tags (name, normalized_name) VALUES (?, ?)',
    serializedTag.name,
    serializedTag.normalizedName
  );
  return result.lastID;
}

async function deleteOrphanedTags(db) {
  await db.run(
    `DELETE FROM tags
     WHERE NOT EXISTS (SELECT 1 FROM music_tags WHERE music_tags.tag_id = tags.id)
       AND NOT EXISTS (SELECT 1 FROM video_tags WHERE video_tags.tag_id = tags.id)
       AND NOT EXISTS (SELECT 1 FROM gallery_tags WHERE gallery_tags.tag_id = tags.id)
       AND NOT EXISTS (SELECT 1 FROM project_tags WHERE project_tags.tag_id = tags.id)`
  );
}

async function syncContentTags(db, contentType, contentId, rawInput) {
  const config = getTagRelationConfig(contentType);
  if (!config) {
    throw new Error('Unknown content type for tag sync.');
  }

  const numericContentId = Number.parseInt(contentId, 10);
  if (!Number.isInteger(numericContentId) || numericContentId <= 0) {
    throw new Error('A valid content id is required to sync tags.');
  }

  const parsedTags = parseTagInput(rawInput);
  await db.exec('SAVEPOINT sync_content_tags');
  try {
    await db.run(`DELETE FROM ${config.joinTable} WHERE ${config.contentColumn} = ?`, numericContentId);

    for (const tag of parsedTags) {
      const tagId = await getOrCreateTagId(db, tag);
      await db.run(
        `INSERT OR IGNORE INTO ${config.joinTable} (${config.contentColumn}, tag_id) VALUES (?, ?)`,
        numericContentId,
        tagId
      );
    }

    if (contentType === 'projects') {
      await db.run(
        'UPDATE projects SET tags = ? WHERE id = ?',
        formatTagInput(parsedTags),
        numericContentId
      );
    }

    await deleteOrphanedTags(db);
    await db.exec('RELEASE SAVEPOINT sync_content_tags');
  } catch (err) {
    await db.exec('ROLLBACK TO SAVEPOINT sync_content_tags');
    await db.exec('RELEASE SAVEPOINT sync_content_tags');
    throw err;
  }

  return parsedTags;
}

async function getTagsForContentIds(db, contentType, contentIds) {
  const config = getTagRelationConfig(contentType);
  if (!config) {
    throw new Error('Unknown content type for tag lookup.');
  }

  const ids = Array.from(new Set((Array.isArray(contentIds) ? contentIds : [])
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isInteger(value) && value > 0)));
  if (!ids.length) {
    return {};
  }

  const placeholders = ids.map(() => '?').join(', ');
  const rows = await db.all(
    `SELECT relation.${config.contentColumn} AS content_id,
            tags.id AS tag_id,
            tags.name AS tag_name,
            tags.normalized_name
     FROM ${config.joinTable} relation
     JOIN tags ON tags.id = relation.tag_id
     WHERE relation.${config.contentColumn} IN (${placeholders})
     ORDER BY LOWER(tags.name) ASC, tags.id ASC`,
    ...ids
  );

  const tagsByContentId = {};
  ids.forEach((id) => {
    tagsByContentId[id] = [];
  });

  rows.forEach((row) => {
    const serializedTag = serializeTag(row);
    if (!serializedTag) {
      return;
    }

    if (!tagsByContentId[row.content_id]) {
      tagsByContentId[row.content_id] = [];
    }
    tagsByContentId[row.content_id].push(serializedTag);
  });

  return tagsByContentId;
}

async function attachTagsToItems(db, contentType, items) {
  if (!Array.isArray(items) || !items.length) {
    return items;
  }

  const tagsByContentId = await getTagsForContentIds(db, contentType, items.map((item) => item.id));
  items.forEach((item) => {
    const itemTags = tagsByContentId[item.id] || [];
    item.tags = itemTags;
    item.tagInput = formatTagInput(itemTags);
  });

  return items;
}

async function getTagByNormalizedName(db, rawValue) {
  const normalizedName = normalizeTagName(rawValue);
  if (!normalizedName) {
    return null;
  }

  const row = await db.get('SELECT id, name, normalized_name FROM tags WHERE normalized_name = ?', normalizedName);
  return serializeTag(row);
}

async function ensureTagTablesReady(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS music_tags (
      music_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (music_id, tag_id),
      FOREIGN KEY(music_id) REFERENCES music(id) ON DELETE CASCADE,
      FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE
    );
  `);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS video_tags (
      video_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (video_id, tag_id),
      FOREIGN KEY(video_id) REFERENCES videos(id) ON DELETE CASCADE,
      FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE
    );
  `);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS gallery_tags (
      gallery_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (gallery_id, tag_id),
      FOREIGN KEY(gallery_id) REFERENCES gallery(id) ON DELETE CASCADE,
      FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE
    );
  `);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS project_tags (
      project_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (project_id, tag_id),
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE
    );
  `);

  await db.exec('CREATE INDEX IF NOT EXISTS idx_tags_normalized_name ON tags(normalized_name)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_music_tags_tag_id ON music_tags(tag_id)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_video_tags_tag_id ON video_tags(tag_id)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_gallery_tags_tag_id ON gallery_tags(tag_id)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_project_tags_tag_id ON project_tags(tag_id)');

  const legacyProjects = await db.all(
    `SELECT id, tags
     FROM projects
     WHERE tags IS NOT NULL
       AND TRIM(tags) != ''`
  );

  for (const project of legacyProjects) {
    await syncContentTags(db, 'projects', project.id, project.tags);
  }
}

module.exports = {
  attachTagsToItems,
  ensureTagTablesReady,
  formatTagInput,
  getTagByNormalizedName,
  getTagMatchExistsClause,
  getTagRelationConfig,
  getTagsForContentIds,
  normalizeTagName,
  parseTagInput,
  syncContentTags,
};