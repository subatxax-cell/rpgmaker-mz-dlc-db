(function exposeDlcSort(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.sortDlcs = api.sortDlcs;
}(typeof window !== 'undefined' ? window : globalThis, () => {
  function numericValue(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function normalizedTitle(dlc) {
    return String(dlc?.title_en || '').normalize('NFKD').toLowerCase();
  }

  function compareTitles(left, right) {
    const first = normalizedTitle(left);
    const second = normalizedTitle(right);
    if (first < second) return -1;
    if (first > second) return 1;
    return 0;
  }

  function compareRecommendation(left, right) {
    const byScore = numericValue(right.recommendation_score) - numericValue(left.recommendation_score);
    if (byScore) return byScore;

    const byReviewCount = numericValue(right.steam_review_count) - numericValue(left.steam_review_count);
    if (byReviewCount) return byReviewCount;

    const byTitle = compareTitles(left, right);
    if (byTitle) return byTitle;

    const leftId = String(left.steam_appid || left.id || '');
    const rightId = String(right.steam_appid || right.id || '');
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  }

  function sortDlcs(dlcs, sort) {
    const sorted = Array.isArray(dlcs) ? [...dlcs] : [];
    if (sort === 'recommendation-desc') return sorted.sort(compareRecommendation);
    if (sort === 'recommendation-asc') return sorted.sort((left, right) => -compareRecommendation(left, right));

    const [key, direction] = String(sort || '').split('-');
    const multiplier = direction === 'asc' ? -1 : 1;
    return sorted.sort((left, right) => {
      let first;
      let second;
      switch (key) {
        case 'rating':
          first = numericValue(left.rating);
          second = numericValue(right.rating);
          break;
        case 'price':
          first = numericValue(left.price_cny);
          second = numericValue(right.price_cny);
          break;
        case 'name':
          return compareTitles(left, right) * multiplier;
        case 'steam_rating':
          first = numericValue(left.steam_rating);
          second = numericValue(right.steam_rating);
          break;
        default:
          first = numericValue(left.rating);
          second = numericValue(right.rating);
      }
      return (first - second) * multiplier;
    });
  }

  return { sortDlcs };
}));
