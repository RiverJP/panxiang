function normalizedNow(now) {
  const parsed = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError("now 必须是有效的日期或时间戳");
  }
  return parsed.toISOString();
}

function hasPositiveLegacySortOrder(product) {
  const sortOrder = Number(product?.sortOrder);
  return Number.isFinite(sortOrder) && sortOrder > 0;
}

function timestampOrNull(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * Adds publication-history fields to legacy catalogue rows.
 *
 * A positive legacy sortOrder is treated as evidence that a hidden product was
 * previously present in the storefront. The supplied `now` is a migration
 * baseline, not an attempt to reconstruct an unknown historical timestamp.
 */
export function migratePublicationHistory(product, now) {
  if (!product || typeof product !== "object" || Array.isArray(product)) {
    throw new TypeError("product 必须是商品对象");
  }

  const migratedAt = normalizedNow(now);
  const published = product.published === true;
  const inferredFromLegacySort = !published && hasPositiveLegacySortOrder(product);
  const everPublished = product.everPublished === true || published || inferredFromLegacySort;

  const migrated = {
    ...product,
    published,
    everPublished,
    firstPublishedAt: timestampOrNull(product.firstPublishedAt),
    lastPublishedAt: timestampOrNull(product.lastPublishedAt),
    lastUnpublishedAt: timestampOrNull(product.lastUnpublishedAt)
  };

  if (!everPublished) return migrated;

  migrated.firstPublishedAt = migrated.firstPublishedAt
    || migrated.lastPublishedAt
    || migratedAt;
  migrated.lastPublishedAt = migrated.lastPublishedAt
    || migrated.firstPublishedAt;

  if (!published && inferredFromLegacySort && !migrated.lastUnpublishedAt) {
    migrated.lastUnpublishedAt = migratedAt;
  }

  return migrated;
}

/**
 * Applies a storefront publication transition without mutating `product`.
 * Repeating the current state is idempotent and does not rewrite timestamps.
 */
export function applyPublicationTransition(product, nextPublished, now) {
  if (typeof nextPublished !== "boolean") {
    throw new TypeError("nextPublished 必须是布尔值");
  }

  const transitionedAt = normalizedNow(now);
  const previousPublished = product?.published === true;
  const migrated = migratePublicationHistory(product, transitionedAt);

  if (previousPublished === nextPublished) return migrated;

  if (nextPublished) {
    return {
      ...migrated,
      published: true,
      everPublished: true,
      firstPublishedAt: migrated.firstPublishedAt || transitionedAt,
      lastPublishedAt: transitionedAt
    };
  }

  return {
    ...migrated,
    published: false,
    everPublished: true,
    firstPublishedAt: migrated.firstPublishedAt || transitionedAt,
    lastPublishedAt: migrated.lastPublishedAt || transitionedAt,
    lastUnpublishedAt: transitionedAt
  };
}

export function isHistoricalPublishedProduct(product) {
  return product?.published !== true && product?.everPublished === true;
}
