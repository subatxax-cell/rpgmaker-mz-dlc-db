const OTHER_SUBCATEGORY_KEYS = Object.freeze([
  'background',
  'ui-window',
  'vfx-animation',
  'illustration-cg',
  'mixed-assets',
  'education',
  'other',
]);

const OTHER_SUBCATEGORY_KEY_SET = new Set(OTHER_SUBCATEGORY_KEYS);

const ASSET_KIND_PATTERNS = [
  /\b(?:tiles?|tile[- ]?sets?)\b/,
  /\b(?:characters?|sprites?|faces?|facesets?)\b/,
  /\b(?:music|audio|sound(?:tracks?|effects?)?|sfx|bgm|ost)\b/,
  /\b(?:ui|user[- ]?interface|menu[- ]?ui|window[- ]?skins?)\b/,
];

const VFX_ASSET_PATTERN = /\b(?:vfx|visual[- ]?effects?|effects?|animations?)\b/;
const AUDIO_EFFECTS_PATTERN = /\b(?:sound|audio)[- ]?effects?\b/g;

function productText(product) {
  return [
    product?.title_en,
    product?.name,
    product?.description_en,
    product?.description,
  ]
    .filter(value => value != null)
    .join(' ')
    .toLowerCase();
}

function inferOtherSubcategory(product) {
  const text = productText(product);
  const assetKinds = (
    ASSET_KIND_PATTERNS.filter(pattern => pattern.test(text)).length
    + Number(VFX_ASSET_PATTERN.test(text.replace(AUDIO_EFFECTS_PATTERN, '')))
  );

  if (
    /\b(?:bundles?|complete[- ]?collections?|mixed[- ]?assets?)\b/.test(text)
    || assetKinds >= 2
  ) return 'mixed-assets';
  if (/\b(?:window[- ]?skins?|menu[- ]?ui|user[- ]?interface|ui[- ]?packs?)\b/.test(text)) {
    return 'ui-window';
  }
  if (/\b(?:vfx|visual[- ]?effects?|effects?[- ]?animations?|animation[- ]?packs?)\b/.test(text)) {
    return 'vfx-animation';
  }
  if (/\b(?:backgrounds?|backdrops?|parallax(?:es)?)\b/.test(text)) return 'background';
  if (/\b(?:portraits?|standing[- ]?art|event[- ]?cg|illustrations?)\b/.test(text)) {
    return 'illustration-cg';
  }
  if (/\b(?:handbooks?|guides?|tutorials?|template[- ]?projects?)\b/.test(text)) return 'education';
  return 'other';
}

function normalizeSubcategory(category, requested, product) {
  if (category !== 'other') return requested;
  return OTHER_SUBCATEGORY_KEY_SET.has(requested)
    ? requested
    : inferOtherSubcategory(product);
}

module.exports = {
  OTHER_SUBCATEGORY_KEYS,
  inferOtherSubcategory,
  normalizeSubcategory,
};
