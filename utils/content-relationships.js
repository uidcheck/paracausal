const RELATIONSHIP_CONFIGS = {
  projectMusic: {
    tableName: 'project_music_links',
    sourceColumn: 'project_id',
    targetColumn: 'music_id',
  },
  projectVideos: {
    tableName: 'project_video_links',
    sourceColumn: 'project_id',
    targetColumn: 'video_id',
  },
  projectGallery: {
    tableName: 'project_gallery_links',
    sourceColumn: 'project_id',
    targetColumn: 'gallery_id',
  },
  musicVideos: {
    tableName: 'music_video_links',
    sourceColumn: 'music_id',
    targetColumn: 'video_id',
  },
  musicProjects: {
    tableName: 'music_project_links',
    sourceColumn: 'music_id',
    targetColumn: 'project_id',
  },
  galleryProjects: {
    tableName: 'gallery_project_links',
    sourceColumn: 'gallery_id',
    targetColumn: 'project_id',
  },
};

function getRelationshipConfig(key) {
  return RELATIONSHIP_CONFIGS[key] || null;
}

function normalizeRelationshipIds(rawValues) {
  const values = Array.isArray(rawValues) ? rawValues : [rawValues];
  return [...new Set(values
    .map((value) => parseInt(value, 10))
    .filter((value) => Number.isInteger(value) && value > 0))];
}

async function syncRelationshipSet(db, relationshipKey, sourceId, rawTargetIds) {
  const config = getRelationshipConfig(relationshipKey);
  if (!config) {
    throw new Error(`Unknown relationship config: ${relationshipKey}`);
  }

  const normalizedSourceId = parseInt(sourceId, 10);
  if (!Number.isInteger(normalizedSourceId) || normalizedSourceId <= 0) {
    throw new Error('A valid source id is required for relationship sync.');
  }

  const targetIds = normalizeRelationshipIds(rawTargetIds);
  await db.run(`DELETE FROM ${config.tableName} WHERE ${config.sourceColumn} = ?`, normalizedSourceId);

  for (const targetId of targetIds) {
    await db.run(
      `INSERT OR IGNORE INTO ${config.tableName} (${config.sourceColumn}, ${config.targetColumn}) VALUES (?, ?)`,
      normalizedSourceId,
      targetId
    );
  }

  return targetIds;
}

async function loadRelationshipIds(db, relationshipKey, sourceId) {
  const config = getRelationshipConfig(relationshipKey);
  if (!config) {
    throw new Error(`Unknown relationship config: ${relationshipKey}`);
  }

  const normalizedSourceId = parseInt(sourceId, 10);
  if (!Number.isInteger(normalizedSourceId) || normalizedSourceId <= 0) {
    return [];
  }

  const rows = await db.all(
    `SELECT ${config.targetColumn} AS target_id
     FROM ${config.tableName}
     WHERE ${config.sourceColumn} = ?
     ORDER BY ${config.targetColumn} ASC`,
    normalizedSourceId
  );

  return rows.map((row) => row.target_id);
}

async function syncRelationshipSetByTarget(db, relationshipKey, targetId, rawSourceIds) {
  const config = getRelationshipConfig(relationshipKey);
  if (!config) {
    throw new Error(`Unknown relationship config: ${relationshipKey}`);
  }

  const normalizedTargetId = parseInt(targetId, 10);
  if (!Number.isInteger(normalizedTargetId) || normalizedTargetId <= 0) {
    throw new Error('A valid target id is required for relationship sync.');
  }

  const sourceIds = normalizeRelationshipIds(rawSourceIds);
  await db.run(`DELETE FROM ${config.tableName} WHERE ${config.targetColumn} = ?`, normalizedTargetId);

  for (const sourceId of sourceIds) {
    await db.run(
      `INSERT OR IGNORE INTO ${config.tableName} (${config.sourceColumn}, ${config.targetColumn}) VALUES (?, ?)`,
      sourceId,
      normalizedTargetId
    );
  }

  return sourceIds;
}

async function loadSourceIdsForTarget(db, relationshipKey, targetId) {
  const config = getRelationshipConfig(relationshipKey);
  if (!config) {
    throw new Error(`Unknown relationship config: ${relationshipKey}`);
  }

  const normalizedTargetId = parseInt(targetId, 10);
  if (!Number.isInteger(normalizedTargetId) || normalizedTargetId <= 0) {
    return [];
  }

  const rows = await db.all(
    `SELECT ${config.sourceColumn} AS source_id
     FROM ${config.tableName}
     WHERE ${config.targetColumn} = ?
     ORDER BY ${config.sourceColumn} ASC`,
    normalizedTargetId
  );

  return rows.map((row) => row.source_id);
}

module.exports = {
  RELATIONSHIP_CONFIGS,
  getRelationshipConfig,
  loadSourceIdsForTarget,
  loadRelationshipIds,
  normalizeRelationshipIds,
  syncRelationshipSetByTarget,
  syncRelationshipSet,
};