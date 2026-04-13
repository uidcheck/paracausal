const SORT_ORDER_TABLES = {
  music: 'music',
  videos: 'videos',
  gallery: 'gallery',
  projects: 'projects',
  homepageSections: 'homepage_sections',
};

async function getNextSortOrder(db, contentType) {
  const tableName = SORT_ORDER_TABLES[contentType];
  if (!tableName) {
    throw new Error(`Unsupported sortable content type: ${contentType}`);
  }

  const row = await db.get(`SELECT MAX(sort_order) AS max_sort_order FROM ${tableName}`);
  const maxSortOrder = row && Number.isInteger(row.max_sort_order) ? row.max_sort_order : 0;
  return maxSortOrder + 1;
}

module.exports = {
  getNextSortOrder,
};