(function exposeDlcDisplay(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.dlcDisplay = api;
}(typeof window !== 'undefined' ? window : globalThis, () => {
  const STEAM_NEUTRAL_PRIOR = 75;

  function numericValue(value) {
    if (value === null || value === undefined || value === '') return undefined;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : undefined;
  }

  function compactNumber(value) {
    return String(Number(value));
  }

  function reviewCount(dlc) {
    return Math.max(0, Math.trunc(numericValue(dlc?.steam_review_count) ?? 0));
  }

  function formatDlcPrice(dlc, unavailableText = '暂无数据') {
    const price = numericValue(dlc?.price_cny);
    if (dlc?.price_status === 'free' || price === 0) return '免费';
    return price === undefined ? unavailableText : `¥${compactNumber(price)}`;
  }

  function formatLowestPrice(dlc) {
    if (dlc?.price_status === 'free' || numericValue(dlc?.price_cny) === 0) return '免费';
    const lowest = numericValue(dlc?.price_cny_lowest);
    return lowest === undefined ? '暂无数据' : `¥${compactNumber(lowest)}`;
  }

  function nonEmptyText(value) {
    return typeof value === 'string' && value.trim() ? value : '';
  }

  function hasChineseDominantLegacyText(value) {
    const hanCharacterCount = (value.match(/[\u3400-\u9fff]/gu) || []).length;
    const latinLetterCount = (value.match(/[A-Za-z]/g) || []).length;

    // A legacy field is only a Chinese fallback when its body is Chinese-led:
    // two Han characters permit short valid text such as “中文”, while requiring
    // at least as many Han as Latin letters rejects English prose that merely
    // mentions a Chinese term.
    return hanCharacterCount >= 2 && hanCharacterCount >= latinLetterCount;
  }

  function detailDescriptions(dlc) {
    const canonicalEnglish = nonEmptyText(dlc.description_en);
    const canonicalChinese = nonEmptyText(dlc.description_zh);
    const legacyDescription = nonEmptyText(dlc.description);

    // Legacy catalogs stored one unlabelled description. It remains an English
    // compatibility fallback while published bilingual data uses the canonical
    // language-specific fields above.
    const descriptionEn = canonicalEnglish || legacyDescription || '暂无英文介绍。';
    const descriptionZh = canonicalChinese
      || (hasChineseDominantLegacyText(legacyDescription) ? legacyDescription : '暂无中文介绍。');

    return { descriptionEn, descriptionZh };
  }

  function buildDlcDetailView(dlc = {}) {
    const score = numericValue(dlc.recommendation_score);
    const rating = numericValue(dlc.steam_rating);
    const count = reviewCount(dlc);
    const manual = numericValue(dlc.manual_rating);
    const recommendationScore = score === undefined ? '暂无数据' : `${score.toFixed(2)} / 100`;
    const hasSteamReviews = count > 0;
    const steamRating = hasSteamReviews
      ? (rating === undefined ? '暂无数据' : `${compactNumber(rating)}% 好评`)
      : '暂无用户评价';
    const reviewCountText = `${count} 条评价`;
    const steamSignal = hasSteamReviews
      ? `${steamRating}，${reviewCountText}，贝叶斯平滑 + 评价量对数置信度`
      : `暂无用户评价；推荐计算使用中性先验 ${STEAM_NEUTRAL_PRIOR}/100，评价量置信度为 0`;
    const recommendationSource = manual === undefined
      ? `Steam 质量（${steamSignal}；无人工评分）`
      : `人工推荐 ${compactNumber(manual)}/5（60%）+ Steam 质量（${steamSignal}，40%）`;

    return {
      ...detailDescriptions(dlc),
      recommendationScore,
      recommendationSource,
      steamRating,
      reviewCount: reviewCountText,
      reviewSummary: dlc.steam_review_summary
        || dlc.review_summary
        || '暂无 Steam 评价汇总。',
      price: formatDlcPrice(dlc),
      lowestPrice: formatLowestPrice(dlc),
    };
  }

  return {
    buildDlcDetailView,
    formatDlcPrice,
  };
}));
