const DRAFT_CONTENT_STATUS = 'draft';
const UNLISTED_CONTENT_STATUS = 'unlisted';
const PUBLISHED_CONTENT_STATUS = 'published';
const SCHEDULED_CONTENT_STATUS = 'scheduled';

const ALL_PUBLICATION_STATUSES = [
  DRAFT_CONTENT_STATUS,
  UNLISTED_CONTENT_STATUS,
  PUBLISHED_CONTENT_STATUS,
  SCHEDULED_CONTENT_STATUS,
];

const PUBLICATION_STATUS_OPTIONS = [
  { value: DRAFT_CONTENT_STATUS, label: 'Draft' },
  { value: UNLISTED_CONTENT_STATUS, label: 'Unlisted' },
  { value: PUBLISHED_CONTENT_STATUS, label: 'Published' },
  { value: SCHEDULED_CONTENT_STATUS, label: 'Scheduled' },
];

function normalizePublicationStatusFilter(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }

  return normalizePublicationStatus(value, null);
}

function normalizePublicationStatus(value, fallbackValue = PUBLISHED_CONTENT_STATUS) {
  if (typeof value !== 'string') {
    return fallbackValue;
  }

  const normalizedValue = value.trim().toLowerCase();
  if (ALL_PUBLICATION_STATUSES.includes(normalizedValue)) {
    return normalizedValue;
  }

  return fallbackValue;
}

function formatPublicationStatusLabel(value) {
  const normalizedValue = normalizePublicationStatus(value, PUBLISHED_CONTENT_STATUS);
  const matchingOption = PUBLICATION_STATUS_OPTIONS.find((option) => option.value === normalizedValue);
  return matchingOption ? matchingOption.label : 'Published';
}

function getQualifiedColumnName(alias, columnName) {
  return alias ? `${alias}.${columnName}` : columnName;
}

function getPublicListingVisibilityClause(alias = '') {
  const publicationStatus = getQualifiedColumnName(alias, 'publication_status');
  const publishedAt = getQualifiedColumnName(alias, 'published_at');

  return `(${publicationStatus} = '${PUBLISHED_CONTENT_STATUS}' OR (${publicationStatus} = '${SCHEDULED_CONTENT_STATUS}' AND ${publishedAt} IS NOT NULL AND datetime(${publishedAt}) <= CURRENT_TIMESTAMP))`;
}

function getPublicDirectVisibilityClause(alias = '') {
  const publicationStatus = getQualifiedColumnName(alias, 'publication_status');
  const publishedAt = getQualifiedColumnName(alias, 'published_at');

  return `(${publicationStatus} IN ('${PUBLISHED_CONTENT_STATUS}', '${UNLISTED_CONTENT_STATUS}') OR (${publicationStatus} = '${SCHEDULED_CONTENT_STATUS}' AND ${publishedAt} IS NOT NULL AND datetime(${publishedAt}) <= CURRENT_TIMESTAMP))`;
}

function normalizePublicationTimestamp(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return null;
  }

  const match = trimmedValue.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) {
    return null;
  }

  const [, year, month, day, hours, minutes, seconds = '00'] = match;
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function toDateTimeLocalValue(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return '';
  }

  const normalizedValue = normalizePublicationTimestamp(value);
  if (!normalizedValue) {
    return '';
  }

  return normalizedValue.slice(0, 16).replace(' ', 'T');
}

module.exports = {
  ALL_PUBLICATION_STATUSES,
  DRAFT_CONTENT_STATUS,
  PUBLISHED_CONTENT_STATUS,
  PUBLICATION_STATUS_OPTIONS,
  SCHEDULED_CONTENT_STATUS,
  UNLISTED_CONTENT_STATUS,
  formatPublicationStatusLabel,
  getPublicDirectVisibilityClause,
  getPublicListingVisibilityClause,
  normalizePublicationStatus,
  normalizePublicationStatusFilter,
  normalizePublicationTimestamp,
  toDateTimeLocalValue,
};
