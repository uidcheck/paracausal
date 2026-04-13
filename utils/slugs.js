function slugify(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .replace(/-{2,}/g, '-');
}

function isValidSlug(slug, options = {}) {
  const { allowNumericOnly = true } = options;

  if (typeof slug !== 'string' || !slug) {
    return false;
  }

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    return false;
  }

  if (!allowNumericOnly && /^\d+$/.test(slug)) {
    return false;
  }

  return true;
}

function normalizeSlugInput(value) {
  return slugify(value);
}

async function slugExists(db, tableName, slug, ignoreId = null) {
  let query = `SELECT id FROM ${tableName} WHERE slug = ?`;
  const params = [slug];

  if (ignoreId !== null && ignoreId !== undefined) {
    query += ' AND id != ?';
    params.push(ignoreId);
  }

  const existing = await db.get(query, ...params);
  return !!existing;
}

async function generateUniqueSlug(db, options = {}) {
  const {
    tableName,
    title = '',
    requestedSlug = '',
    fallbackPrefix = 'item',
    allowNumericOnly = true,
    ignoreId = null,
    idForFallback = null,
  } = options;

  let baseSlug = normalizeSlugInput(requestedSlug) || normalizeSlugInput(title);
  if (!baseSlug) {
    baseSlug = idForFallback ? `${fallbackPrefix}-${idForFallback}` : fallbackPrefix;
  }

  if (!allowNumericOnly && /^\d+$/.test(baseSlug)) {
    baseSlug = `${fallbackPrefix}-${baseSlug}`;
  }

  let slug = baseSlug;
  let suffix = 2;
  while (await slugExists(db, tableName, slug, ignoreId)) {
    slug = `${baseSlug}-${suffix}`;
    suffix += 1;
  }

  return slug;
}

async function resolveOptionalSlug(db, options = {}) {
  const {
    tableName,
    title = '',
    rawSlug = '',
    fallbackPrefix = 'item',
    allowNumericOnly = true,
    ignoreId = null,
    idForFallback = null,
  } = options;

  const hasManualSlug = typeof rawSlug === 'string' && rawSlug.trim() !== '';
  if (!hasManualSlug) {
    return {
      slug: await generateUniqueSlug(db, {
        tableName,
        title,
        fallbackPrefix,
        allowNumericOnly,
        ignoreId,
        idForFallback,
      }),
      error: '',
    };
  }

  const normalizedSlug = normalizeSlugInput(rawSlug);
  if (!isValidSlug(normalizedSlug, { allowNumericOnly })) {
    return {
      slug: '',
      error: allowNumericOnly
        ? 'Enter a valid slug using letters, numbers and hyphens.'
        : 'Enter a valid slug using letters, numbers and hyphens. Numeric-only slugs are not allowed here.',
    };
  }

  if (await slugExists(db, tableName, normalizedSlug, ignoreId)) {
    return {
      slug: '',
      error: 'That slug is already in use. Choose a different one.',
    };
  }

  return {
    slug: normalizedSlug,
    error: '',
  };
}

module.exports = {
  generateUniqueSlug,
  isValidSlug,
  normalizeSlugInput,
  resolveOptionalSlug,
  slugify,
};