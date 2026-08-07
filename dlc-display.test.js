const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildDlcDetailView,
  formatDlcPrice,
} = require('./js/dlc-display');

test('curated details prefer the canonical Steam summary and explain the blended score', () => {
  const view = buildDlcDetailView({
    recommendation_score: 78.26,
    manual_rating: 4,
    steam_rating: 100,
    steam_review_count: 3,
    steam_review_summary: '3 user reviews',
    review_summary: 'Legacy curated prose must not replace Steam evidence.',
    price_cny: 68,
    price_status: 'available',
  });

  assert.deepEqual(view, {
    descriptionEn: '暂无英文介绍。',
    descriptionZh: '暂无中文介绍。',
    recommendationScore: '78.26 / 100',
    recommendationSource: '人工推荐 4/5（60%）+ Steam 质量（100% 好评，3 条评价，贝叶斯平滑 + 评价量对数置信度，40%）',
    steamRating: '100% 好评',
    reviewCount: '3 条评价',
    reviewSummary: '3 user reviews',
    price: '¥68',
    lowestPrice: '暂无数据',
  });
});

test('uncurated details expose the Steam-only score source and canonical summary', () => {
  const view = buildDlcDetailView({
    recommendation_score: 74.64,
    steam_rating: 0,
    steam_review_count: 1,
    steam_review_summary: '1 user reviews',
    price_cny: 0,
    price_status: 'free',
  });

  assert.deepEqual(view, {
    descriptionEn: '暂无英文介绍。',
    descriptionZh: '暂无中文介绍。',
    recommendationScore: '74.64 / 100',
    recommendationSource: 'Steam 质量（0% 好评，1 条评价，贝叶斯平滑 + 评价量对数置信度；无人工评分）',
    steamRating: '0% 好评',
    reviewCount: '1 条评价',
    reviewSummary: '1 user reviews',
    price: '免费',
    lowestPrice: '免费',
  });
});

test('legacy review prose is only a fallback when the canonical Steam summary is absent', () => {
  const view = buildDlcDetailView({
    recommendation_score: 75,
    steam_rating: 75,
    steam_review_count: 0,
    steam_review_summary: '',
    review_summary: 'Legacy fallback summary.',
    price_cny: null,
    price_status: 'unavailable',
  });

  assert.equal(view.reviewSummary, 'Legacy fallback summary.');
  assert.equal(view.reviewCount, '0 条评价');
  assert.equal(view.price, '暂无数据');
});

test('zero-review canonical DLCs expose the neutral prior without claiming observed approval', () => {
  const catalog = require('./data/dlc-catalog.json');
  const uncurated = catalog.find(dlc => String(dlc.steam_appid) === '4838050');
  const curated = catalog.find(dlc => String(dlc.steam_appid) === '4961520');

  assert.ok(uncurated, 'expected a real uncurated zero-review canonical DLC');
  assert.ok(curated, 'expected a real curated zero-review canonical DLC');
  assert.equal(uncurated.steam_rating, 75);
  assert.equal(uncurated.steam_review_count, 0);
  assert.equal(uncurated.steam_review_summary, 'No user reviews');
  assert.equal(curated.steam_rating, 75);
  assert.equal(curated.steam_review_count, 0);
  assert.equal(curated.steam_review_summary, 'No user reviews');
  assert.equal(curated.manual_rating, 4.2);

  const uncuratedView = buildDlcDetailView(uncurated);
  const curatedView = buildDlcDetailView(curated);

  assert.equal(uncuratedView.steamRating, '暂无用户评价');
  assert.equal(uncuratedView.reviewCount, '0 条评价');
  assert.equal(
    uncuratedView.recommendationSource,
    'Steam 质量（暂无用户评价；推荐计算使用中性先验 75/100，评价量置信度为 0；无人工评分）',
  );
  assert.equal(curatedView.steamRating, '暂无用户评价');
  assert.equal(curatedView.reviewCount, '0 条评价');
  assert.equal(
    curatedView.recommendationSource,
    '人工推荐 4.2/5（60%）+ Steam 质量（暂无用户评价；推荐计算使用中性先验 75/100，评价量置信度为 0，40%）',
  );
  assert.doesNotMatch(uncuratedView.recommendationSource, /75% 好评/);
  assert.doesNotMatch(curatedView.recommendationSource, /75% 好评/);
});

test('all canonical free DLCs render as free instead of unknown price', () => {
  const catalog = require('./data/dlc-catalog.json');
  const freeDlcs = catalog.filter(dlc => dlc.price_status === 'free');

  assert.equal(freeDlcs.length, 7);
  assert.ok(freeDlcs.every(dlc => dlc.price_cny === 0));
  assert.deepEqual(freeDlcs.map(dlc => formatDlcPrice(dlc)), Array(7).fill('免费'));
});

test('details expose canonical English followed by Simplified Chinese descriptions', () => {
  const view = buildDlcDetailView({
    description_en: 'Original English.\n\nSecond paragraph.',
    description_zh: '中文翻译。\n\n第二段。',
  });

  assert.equal(view.descriptionEn, 'Original English.\n\nSecond paragraph.');
  assert.equal(view.descriptionZh, '中文翻译。\n\n第二段。');
});

test('English-only legacy descriptions do not repeat as the Chinese detail', () => {
  const view = buildDlcDetailView({
    description: 'Legacy English description only.',
  });

  assert.equal(view.descriptionEn, 'Legacy English description only.');
  assert.equal(view.descriptionZh, '暂无中文介绍。');
});

test('English-led legacy descriptions with an incidental Chinese term do not masquerade as Chinese', () => {
  const view = buildDlcDetailView({
    description: 'Legacy English description; includes 中文 language support.',
  });

  assert.equal(view.descriptionEn, 'Legacy English description; includes 中文 language support.');
  assert.equal(view.descriptionZh, '暂无中文介绍。');
});

test('Chinese legacy descriptions remain available as the Chinese compatibility fallback', () => {
  const view = buildDlcDetailView({
    description: '这是旧数据中的中文介绍。',
  });

  assert.equal(view.descriptionZh, '这是旧数据中的中文介绍。');
});

test('short Chinese legacy descriptions remain valid Chinese compatibility fallbacks', () => {
  const view = buildDlcDetailView({ description: '中文' });

  assert.equal(view.descriptionZh, '中文');
});
