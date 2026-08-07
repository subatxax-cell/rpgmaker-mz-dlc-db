(function exposeDlcFilters(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.dlcFilters = api;
}(typeof window !== 'undefined' ? window : globalThis, () => {
  const OTHER_SUBCATEGORY_ORDER = Object.freeze([
    'background',
    'ui-window',
    'vfx-animation',
    'illustration-cg',
    'mixed-assets',
    'education',
    'other',
  ]);

  const CATEGORY_LABELS = Object.freeze({
    tileset: '🗺️ 图块素材',
    plugin: '🔌 插件工具',
    music: '🎵 音乐包',
    sfx: '🔊 音效包',
    character: '👤 角色素材',
    battler: '⚔️ 战斗角色',
    animation: '✨ 动画特效',
    icon: '🖼️ 图标素材',
    generator: '🧑‍🎨 角色生成器',
    weather: '🌦️ 天气效果',
    bundle: '📦 捆绑包',
    window: '🪟 窗口皮肤',
    tool: '🛠️ 工具软件',
    theme: '🎨 主题包',
    retro: '👾 复古像素',
    scifi: '🚀 科幻题材',
    other: '📋 其他',
  });

  const OTHER_SUBCATEGORY_LABELS = Object.freeze({
    background: '🌄 背景图',
    'ui-window': '🪟 UI／窗口皮肤',
    'vfx-animation': '✨ 特效动画',
    'illustration-cg': '🎨 立绘与 CG',
    'mixed-assets': '📦 混合素材包',
    education: '📚 教学资料',
    other: '📎 其他',
  });

  function asArray(dlcs) {
    return Array.isArray(dlcs) ? dlcs : [];
  }

  function filterByCategory(dlcs, selection = {}) {
    const source = asArray(dlcs);
    const category = selection.category;

    if (!category || category === 'all') return [...source];

    const inCategory = source.filter((dlc) => dlc?.category === category);
    if (category !== 'other' || !selection.subcategory) return inCategory;

    return inCategory.filter((dlc) => dlc?.sub_category === selection.subcategory);
  }

  function countBy(items, predicate) {
    return items.reduce((count, item) => count + (predicate(item) ? 1 : 0), 0);
  }

  function categoryLabel(key) {
    return CATEGORY_LABELS[key] || String(key);
  }

  function buildCategoryNavigation(allDlcs, visibleDlcs, selection = {}) {
    const all = asArray(allDlcs);
    const visible = asArray(visibleDlcs);
    const activeCategory = selection.category || null;
    const activeSubcategory = activeCategory === 'other' ? selection.subcategory || null : null;
    const categories = [...new Set(all.map((dlc) => dlc?.category).filter(Boolean))]
      .sort((left, right) => {
        const countDifference = countBy(all, (dlc) => dlc?.category === right)
          - countBy(all, (dlc) => dlc?.category === left);
        return countDifference || String(left).localeCompare(String(right));
      });

    const allItem = {
      key: 'all',
      label: '📋 全部',
      level: 0,
      count: visible.length,
      selected: !activeCategory,
      children: [],
    };

    const categoryItems = categories.map((key) => {
      const item = {
        key,
        label: categoryLabel(key),
        level: 1,
        count: countBy(visible, (dlc) => dlc?.category === key),
        selected: activeCategory === key && (key !== 'other' || !activeSubcategory),
        expanded: key === 'other' && activeCategory === 'other',
        children: [],
      };

      if (key === 'other') {
        const availableSubcategories = new Set(
          all.filter((dlc) => dlc?.category === 'other').map((dlc) => dlc?.sub_category),
        );
        item.children = OTHER_SUBCATEGORY_ORDER
          .filter((subcategory) => availableSubcategories.has(subcategory))
          .map((subcategory) => ({
            key: subcategory,
            label: OTHER_SUBCATEGORY_LABELS[subcategory],
            level: 2,
            count: countBy(visible, (dlc) => dlc?.category === 'other' && dlc?.sub_category === subcategory),
            selected: activeCategory === 'other' && activeSubcategory === subcategory,
            children: [],
          }));
      }

      return item;
    });

    return [allItem, ...categoryItems];
  }

  return {
    OTHER_SUBCATEGORY_ORDER,
    CATEGORY_LABELS,
    OTHER_SUBCATEGORY_LABELS,
    filterByCategory,
    buildCategoryNavigation,
  };
}));
