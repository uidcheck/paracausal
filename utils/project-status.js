const ONGOING_PROJECT_STATUS = 'ongoing';
const CLOSED_PROJECT_STATUS = 'closed';

const PROJECT_STATUS_OPTIONS = [
  { value: ONGOING_PROJECT_STATUS, label: 'Ongoing' },
  { value: CLOSED_PROJECT_STATUS, label: 'Closed' },
];

function normalizeProjectStatusFilter(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }

  return normalizeProjectStatus(value, null);
}

function normalizeProjectStatus(value, fallbackValue = ONGOING_PROJECT_STATUS) {
  if (typeof value !== 'string') {
    return fallbackValue;
  }

  const normalizedValue = value.trim().toLowerCase();
  if (normalizedValue === ONGOING_PROJECT_STATUS || normalizedValue === CLOSED_PROJECT_STATUS) {
    return normalizedValue;
  }

  return fallbackValue;
}

function formatProjectStatusLabel(value) {
  const normalizedValue = normalizeProjectStatus(value, ONGOING_PROJECT_STATUS);
  return normalizedValue === CLOSED_PROJECT_STATUS ? 'Closed' : 'Ongoing';
}

module.exports = {
  CLOSED_PROJECT_STATUS,
  ONGOING_PROJECT_STATUS,
  PROJECT_STATUS_OPTIONS,
  formatProjectStatusLabel,
  normalizeProjectStatus,
  normalizeProjectStatusFilter,
};