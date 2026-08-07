const STEAM_PRIOR_MEAN = 75;
const STEAM_PRIOR_WEIGHT = 20;
const MANUAL_WEIGHT = 0.6;
const STEAM_WEIGHT = 0.4;
const { normalizeSubcategory } = require('./dlc-taxonomy');

const CATEGORY_RULES = [
  ['music', /\b(?:music|soundtrack|bgm|ost)\b/],
  ['sfx', /\b(?:sound effects?|sfx|se|audio pack)\b/],
  ['plugin', /\b(?:plugin|plug-in|extension)\b/],
  ['tileset', /\b(?:tileset|tile set|tiles)\b/],
  ['character', /\b(?:character|generator parts?|portrait|faceset)\b/],
  ['battler', /\b(?:battlers?|side[- ]view|sv battler|enemy pack)\b/],
];

function numberInRange(value, minimum, maximum, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(maximum, Math.max(minimum, numeric)) : fallback;
}

function roundScore(value) {
  return Number(value.toFixed(2));
}

function manualRating(curated) {
  if (!curated || (curated.manual_rating === undefined && curated.rating === undefined)) return undefined;
  const rating = Number(curated.manual_rating ?? curated.rating);
  if (!Number.isFinite(rating)) return undefined;
  return rating <= 5
    ? numberInRange(rating, 0, 5, 0) * 20
    : numberInRange(rating, 0, 100, 0);
}

function inferCategory(product) {
  const text = [product?.name, product?.title_en, product?.description_en, product?.description]
    .filter(value => value != null)
    .join(' ')
    .toLowerCase();

  const rule = CATEGORY_RULES.find(([, pattern]) => pattern.test(text));
  return rule ? rule[0] : 'other';
}

function steamQuality(product) {
  const reviewCount = numberInRange(product?.steam_review_count, 0, Number.MAX_SAFE_INTEGER, 0);
  const rating = numberInRange(product?.steam_rating, 0, 100, STEAM_PRIOR_MEAN);
  const bayesianScore = (
    rating * reviewCount + STEAM_PRIOR_MEAN * STEAM_PRIOR_WEIGHT
  ) / (reviewCount + STEAM_PRIOR_WEIGHT);
  const confidence = Math.min(1, Math.log10(reviewCount + 1) / 3);

  return STEAM_PRIOR_MEAN + (bayesianScore - STEAM_PRIOR_MEAN) * confidence;
}

function calculateRecommendation(product, curated) {
  const quality = steamQuality(product);
  const manualScore = manualRating(curated ?? product);
  const score = manualScore === undefined
    ? quality
    : MANUAL_WEIGHT * manualScore + STEAM_WEIGHT * quality;

  return roundScore(score);
}

function mergeCatalog(official, curated) {
  const curatedByAppid = new Map(
    curated
      .filter(item => item?.steam_appid != null)
      .map(item => [String(item.steam_appid), item]),
  );

  return official.map(product => {
    const steam_appid = String(product.steam_appid);
    const curatedProduct = curatedByAppid.get(steam_appid);
    const merged = { ...(curatedProduct || {}), ...product, steam_appid };
    const rawManualRating = curatedProduct && Number(
      curatedProduct.manual_rating ?? curatedProduct.rating,
    );

    delete merged.rating;
    if (!Number.isFinite(rawManualRating)) delete merged.manual_rating;
    else merged.manual_rating = rawManualRating;

    if (product.description_en || product.description_zh) {
      merged.description = product.description_zh || product.description_en;
    } else if (curatedProduct?.description !== undefined) {
      merged.description = curatedProduct.description;
    }
    merged.category = curatedProduct?.category || inferCategory(product);
    merged.sub_category = normalizeSubcategory(
      merged.category,
      curatedProduct?.sub_category ?? merged.sub_category,
      merged,
    );
    merged.recommendation_score = calculateRecommendation(product, curatedProduct);
    return merged;
  });
}

module.exports = {
  inferCategory,
  calculateRecommendation,
  mergeCatalog,
};
