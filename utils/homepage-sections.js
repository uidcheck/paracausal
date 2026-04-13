const HOMEPAGE_SECTION_TYPES = {
  featuredTrack: 'featured_track',
  featuredVideo: 'featured_video',
  featuredGalleryImage: 'featured_gallery_image',
  ongoingProjects: 'ongoing_projects',
  latestUpdates: 'latest_updates',
  galleryStrip: 'gallery_strip',
  manifestoBlock: 'manifesto_block',
  externalLinksBlock: 'external_links_block',
};

const HOMEPAGE_SECTION_TYPE_OPTIONS = [
  { value: HOMEPAGE_SECTION_TYPES.featuredTrack, label: 'Featured Track' },
  { value: HOMEPAGE_SECTION_TYPES.featuredVideo, label: 'Featured Video' },
  { value: HOMEPAGE_SECTION_TYPES.featuredGalleryImage, label: 'Featured Gallery Image' },
  { value: HOMEPAGE_SECTION_TYPES.ongoingProjects, label: 'Ongoing Projects' },
  { value: HOMEPAGE_SECTION_TYPES.latestUpdates, label: 'Latest Updates' },
  { value: HOMEPAGE_SECTION_TYPES.galleryStrip, label: 'Gallery Strip' },
  { value: HOMEPAGE_SECTION_TYPES.manifestoBlock, label: 'Text / Manifesto Block' },
  { value: HOMEPAGE_SECTION_TYPES.externalLinksBlock, label: 'External Links Block' },
];

const HOMEPAGE_SECTION_STYLE_OPTIONS = [
  { value: 'default', label: 'Default' },
  { value: 'broadcast', label: 'Broadcast' },
  { value: 'vault', label: 'Vault' },
  { value: 'signal', label: 'Signal' },
];

function normalizeOptionalText(value, maxLength) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().slice(0, maxLength);
}

function normalizeNullableId(value) {
  const parsed = parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeBooleanFlag(value) {
  return value === '1' || value === 'true' || value === 'on' || value === true;
}

function normalizeHomepageSectionType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return Object.values(HOMEPAGE_SECTION_TYPES).includes(normalized)
    ? normalized
    : HOMEPAGE_SECTION_TYPES.manifestoBlock;
}

function normalizeHomepageSectionStyle(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return HOMEPAGE_SECTION_STYLE_OPTIONS.some((option) => option.value === normalized)
    ? normalized
    : 'default';
}

function formatHomepageSectionTypeLabel(value) {
  const option = HOMEPAGE_SECTION_TYPE_OPTIONS.find((entry) => entry.value === value);
  return option ? option.label : 'Section';
}

function normalizeHomepageSectionInput(body = {}) {
  return {
    sectionType: normalizeHomepageSectionType(body.section_type),
    titleOverride: normalizeOptionalText(body.title_override, 120),
    bodyText: normalizeOptionalText(body.body_text, 4000),
    itemLimit: Math.max(1, Math.min(parseInt(body.item_limit, 10) || 6, 24)),
    enabled: normalizeBooleanFlag(body.enabled),
    linkedTrackId: normalizeNullableId(body.linked_track_id),
    linkedVideoId: normalizeNullableId(body.linked_video_id),
    linkedGalleryId: normalizeNullableId(body.linked_gallery_id),
    sourceGroup: normalizeOptionalText(body.source_group, 32),
    filterTag: normalizeOptionalText(body.filter_tag, 80),
    accentColour: normalizeOptionalText(body.accent_colour, 16),
    styleMode: normalizeHomepageSectionStyle(body.style_mode),
  };
}

module.exports = {
  HOMEPAGE_SECTION_STYLE_OPTIONS,
  HOMEPAGE_SECTION_TYPE_OPTIONS,
  HOMEPAGE_SECTION_TYPES,
  formatHomepageSectionTypeLabel,
  normalizeHomepageSectionInput,
  normalizeHomepageSectionStyle,
  normalizeHomepageSectionType,
};