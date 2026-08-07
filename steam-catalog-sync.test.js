const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const {
  extractAppIds,
  discoverAllDlcs,
  isRpgMakerMzDlc,
  verifyProducts,
} = require('./lib/steam-catalog');
const {
  inferCategory,
  calculateRecommendation,
  mergeCatalog,
} = require('./lib/dlc-model');
const {
  buildArtifacts,
  catalogPageUrl,
  discoverOfficialDlcs,
  parseCatalogPage,
  appDetailsUrl,
  fetchAppDetails,
  reviewSummaryUrl,
  isOfficialSteamMediaUrl,
  publishAtomically,
  createRequestScheduler,
  requestText,
  runCli,
  syncSteamDlcs,
} = require('./sync-steam-dlcs');
const {
  cleanSteamDescription,
  mergeLocalizedDescriptions,
} = require('./lib/dlc-localization');
const { sortDlcs } = require('./js/dlc-sort');

const TIMESTAMP = '2026-08-05T00:00:00.000Z';

test('globally serializes official requests and applies cooldowns after HTTP 403 and 429', async () => {
  let now = 0;
  const sleeps = [];
  const scheduler = createRequestScheduler({
    minIntervalMs: 900,
    cooldownMs: 300000,
    now: () => now,
    sleep: async milliseconds => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
  });

  const starts = await Promise.all([
    scheduler.waitForSlot(),
    scheduler.waitForSlot(),
    scheduler.waitForSlot(),
  ]);
  assert.deepEqual(starts, [0, 900, 1800]);

  scheduler.observeStatus(403);
  assert.equal(await scheduler.waitForSlot(), 301800);
  scheduler.observeStatus(200);
  assert.equal(await scheduler.waitForSlot(), 302700);
  scheduler.observeStatus(429);
  assert.equal(await scheduler.waitForSlot(), 602700);
  assert.deepEqual(sleeps, [900, 900, 300000, 900, 300000]);
});

test('official HTTP responses feed their status into the shared request scheduler', async () => {
  const originalGet = https.get;
  const statuses = [];
  let waitCalls = 0;
  let requestHeaders;
  https.get = (url, options, callback) => {
    requestHeaders = options.headers;
    const request = new EventEmitter();
    request.destroy = error => request.emit('error', error);
    const response = new EventEmitter();
    response.statusCode = 429;
    response.headers = {};
    response.setEncoding = () => {};
    response.resume = () => {};
    queueMicrotask(() => {
      callback(response);
      queueMicrotask(() => response.emit('end'));
    });
    return request;
  };

  try {
    await assert.rejects(() => requestText('https://store.steampowered.com/test', {
      requestScheduler: {
        waitForSlot: async () => { waitCalls += 1; },
        observeStatus: status => statuses.push(status),
      },
    }), /HTTP 429/);
  } finally {
    https.get = originalGet;
  }

  assert.equal(waitCalls, 1);
  assert.deepEqual(statuses, [429]);
  assert.match(requestHeaders['User-Agent'], /^Mozilla\/5\.0/);
  assert.equal(requestHeaders['Accept-Language'], 'en-US,en;q=0.9');
});

test('CLI help prints usage and exits without invoking the live sync', async () => {
  for (const flag of ['--help', '-h']) {
    let syncCalls = 0;
    const output = [];
    const result = await runCli([flag], {
      sync: async () => { syncCalls += 1; },
      log: line => output.push(line),
    });

    assert.deepEqual(result, { help: true });
    assert.equal(syncCalls, 0);
    assert.match(output.join('\n'), /usage: node sync-steam-dlcs\.js/i);
  }
});

test('CLI rejects unknown arguments before invoking the live sync', async () => {
  let syncCalls = 0;
  await assert.rejects(() => runCli(['--unsafe'], {
    sync: async () => { syncCalls += 1; },
    log: () => {},
  }), /unknown argument.*--unsafe/i);
  assert.equal(syncCalls, 0);
});

test('recommendation sorting restores the selected quality order after search filtering', () => {
  const items = [
    {
      id: 'low',
      title_en: 'Music Pack Alpha',
      recommendation_score: 72.5,
      steam_review_count: 500,
    },
    {
      id: 'high',
      title_en: 'Music Pack Beta',
      recommendation_score: 91.25,
      steam_review_count: 25,
    },
    {
      id: 'not-a-match',
      title_en: 'Forest Tileset',
      recommendation_score: 99,
      steam_review_count: 1000,
    },
  ];
  const filtered = items.filter(item => item.title_en.includes('Music'));

  assert.deepEqual(
    sortDlcs(filtered, 'recommendation-desc').map(item => item.id),
    ['high', 'low'],
  );
  assert.deepEqual(
    sortDlcs(filtered, 'recommendation-asc').map(item => item.id),
    ['low', 'high'],
  );
});

test('recommendation sort breaks equal scores by review count then normalized English title', () => {
  const items = [
    { id: 'zebra', title_en: 'Zebra Music', recommendation_score: 90, steam_review_count: 10 },
    { id: 'alpha', title_en: 'alpha music', recommendation_score: 90, steam_review_count: 10 },
    { id: 'more-reviews', title_en: 'Middle Music', recommendation_score: 90, steam_review_count: 11 },
  ];

  assert.deepEqual(
    sortDlcs(items, 'recommendation-desc').map(item => item.id),
    ['more-reviews', 'alpha', 'zebra'],
  );
  assert.deepEqual(
    sortDlcs(items, 'recommendation-asc').map(item => item.id),
    ['zebra', 'alpha', 'more-reviews'],
  );
});

test('recommendation sort reverses the final app ID tiebreak for equal records', () => {
  const items = [
    { id: 'record-z', steam_appid: 'z-app', title_en: 'Same title', recommendation_score: 90, steam_review_count: 10 },
    { id: 'record-a', steam_appid: 'a-app', title_en: 'Same title', recommendation_score: 90, steam_review_count: 10 },
  ];

  assert.deepEqual(
    sortDlcs(items, 'recommendation-desc').map(item => item.id),
    ['record-a', 'record-z'],
  );
  assert.deepEqual(
    sortDlcs(items, 'recommendation-asc').map(item => item.id),
    ['record-z', 'record-a'],
  );
});

test('recommendation sorting returns a new array without mutating the input', () => {
  const items = [
    { id: 'high', title_en: 'High', recommendation_score: 90, steam_review_count: 1 },
    { id: 'low', title_en: 'Low', recommendation_score: 10, steam_review_count: 100 },
  ];
  const originalIds = items.map(item => item.id);

  const sorted = sortDlcs(items, 'recommendation-asc');

  assert.deepEqual(sorted.map(item => item.id), ['low', 'high']);
  assert.notEqual(sorted, items);
  assert.deepEqual(items.map(item => item.id), originalIds);
});

test('explicit alternative sorts retain their selected ordering', () => {
  const items = [
    { id: 'expensive', title_en: 'Zebra', price_cny: 20, rating: 2 },
    { id: 'cheap', title_en: 'Alpha', price_cny: 5, rating: 5 },
  ];

  assert.deepEqual(sortDlcs(items, 'price-asc').map(item => item.id), ['expensive', 'cheap']);
  assert.deepEqual(sortDlcs(items, 'name-desc').map(item => item.id), ['cheap', 'expensive']);
});

function catalogPage(appids, start = 0, totalCount = appids.length, pageSize = appids.length || 10) {
  return {
    success: 1,
    pagesize: pageSize,
    total_count: totalCount,
    start,
    results_html: appids.map(appid => `data-ds-appid="${appid}"`).join(' '),
  };
}

function officialFixture(appid = '10', overrides = {}) {
  return {
    steam_appid: appid,
    type: 'dlc',
    fullgame: { appid: '1096900' },
    name: `RPG Maker MZ - Official Pack ${appid}`,
    short_description: 'Official Steam description.',
    description_en: 'Official Steam description.',
    description_zh: '官方 Steam 中文介绍。',
    header_image: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`,
    screenshots: [{
      path_full: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/ss_full.jpg`,
      path_thumbnail: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/ss_thumb.jpg`,
    }],
    movies: [{
      name: 'Trailer',
      thumbnail: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/movie.jpg`,
      mp4: { max: `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/movie_max.mp4` },
      webm: { max: `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/movie_max.webm` },
      hls_h264: `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/master.m3u8`,
      dash_h264: `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/manifest.mpd`,
    }],
    price_overview: { currency: 'CNY', final: 4800 },
    release_date: { date: '5 Aug, 2026' },
    steam_rating: 90,
    steam_review_count: 120,
    ...overrides,
  };
}

test('localized descriptions merge official English and Simplified Chinese by exact App ID', () => {
  assert.deepEqual(mergeLocalizedDescriptions({
    appid: '10',
    english: { short_description: '<p>English &amp; original.</p>' },
    schinese: { short_description: '<p>简体中文介绍。</p>' },
    previous: { steam_appid: '10', description_zh: '旧中文' },
    fallbackTranslations: { '20': '不应按标题合并' },
  }), {
    description_en: 'English & original.',
    description_zh: '简体中文介绍。',
  });
});

test('localized cleaning preserves paragraph, list, and BR structure while removing active contents', () => {
  const input = [
    '<style>.secret { display: block; }</style>',
    '<p>First&nbsp;paragraph &amp; value<br>next line</p>',
    '<ul><li>One &lt;item&gt;</li><li>Two &#x4E2D;&#25991;</li></ul>',
    '<script>alert(&quot;secret&quot;)</script>',
    '<p>Final &apos;paragraph&apos;</p>',
  ].join('');

  assert.equal(
    cleanSteamDescription(input),
    "First paragraph & value\nnext line\n\nOne <item>\nTwo 中文\n\nFinal 'paragraph'",
  );
});

test('localized cleaning keeps ordinary angle-bracket text while removing real HTML tags', () => {
  assert.equal(
    cleanSteamDescription(
      'Keep x < y and y > z. <strong>Bold</strong> <span data-check="1 > 0">real</span>',
    ),
    'Keep x < y and y > z. Bold real',
  );
});

test('localized cleaning removes obsolete HTML tags', () => {
  assert.equal(
    cleanSteamDescription('<marquee direction="left">moving</marquee>'),
    'moving',
  );
});

test('localized cleaning removes custom and namespaced tags', () => {
  assert.equal(
    cleanSteamDescription('<custom-box>inside</custom-box> <ui:panel>copy</ui:panel>'),
    'inside copy',
  );
});

test('localized cleaning removes SVG and self-closing path tags', () => {
  assert.equal(
    cleanSteamDescription('<svg viewBox="0 0 10 10"><path d="M0 0"/><svg:path /></svg>'),
    '',
  );
});

test('localized Simplified Chinese fallback uses exact App ID when Steam repeats English', () => {
  const result = mergeLocalizedDescriptions({
    appid: 10,
    english: { short_description: '<p>Same text</p>' },
    schinese: { short_description: ' Same&nbsp;text ' },
    previous: { steam_appid: '10', description_zh: '旧中文' },
    fallbackTranslations: { '10': '<p>持久化精确翻译</p>', '11': '错误 App ID' },
  });

  assert.equal(result.description_zh, '持久化精确翻译');
});

test('localized persisted fallback beats previous Chinese and previous wins when fallback is absent', () => {
  const shared = {
    english: { detailed_description: '<p>English detailed</p>' },
    schinese: {},
    previous: { steam_appid: '10', description_en: 'Old English', description_zh: '旧中文' },
  };

  assert.equal(mergeLocalizedDescriptions({
    appid: '10',
    ...shared,
    fallbackTranslations: { '10': '持久化中文' },
  }).description_zh, '持久化中文');
  assert.equal(mergeLocalizedDescriptions({
    appid: '10',
    ...shared,
    fallbackTranslations: { '20': '不同 App ID' },
  }).description_zh, '旧中文');
});

test('localized merge rejects missing English and missing all Chinese sources with App ID', () => {
  assert.throws(() => mergeLocalizedDescriptions({
    appid: '101',
    english: {},
    schinese: { short_description: '中文' },
    previous: {},
    fallbackTranslations: {},
  }), /101.*English|English.*101/i);
  assert.throws(() => mergeLocalizedDescriptions({
    appid: '202',
    english: { short_description: 'English' },
    schinese: {},
    previous: {},
    fallbackTranslations: {},
  }), /202.*Chinese|Chinese.*202/i);
});

test('extracts app ids from either supported attribute quote style', () => {
  const html = 'data-ds-appid="10" data-ds-appid=\'20\' data-ds-appid="10"';

  assert.deepEqual(extractAppIds(html), ['10', '20', '10']);
});

test('discovers unique app ids across every catalog page', async () => {
  const pages = {
    1: 'data-ds-appid="10" data-ds-appid="20"',
    2: 'data-ds-appid="20" data-ds-appid="30"',
    3: '',
  };

  assert.deepEqual(await discoverAllDlcs(async page => pages[page]), ['10', '20', '30']);
});

test('discovers official app ids from Steam paginator JSON using successive offsets', async () => {
  const offsets = [];
  const pages = {
    0: catalogPage(['10', '20'], 0, 3, 2),
    2: catalogPage(['30'], 2, 3, 1),
  };

  const result = await discoverOfficialDlcs(async (start, options) => {
    offsets.push([start, options.count]);
    return pages[start];
  }, { pageSize: 2 });

  assert.deepEqual(result, ['10', '20', '30']);
  assert.deepEqual(offsets, [[0, 2], [2, 2]]);
});

test('validates Steam paginator shape and refuses empty or repeated windows before total count', async () => {
  assert.deepEqual(parseCatalogPage(catalogPage(['10'], 0, 1, 1)), {
    appids: ['10'], start: 0, pageSize: 1, totalCount: 1,
  });
  assert.throws(() => parseCatalogPage({ success: 1, results_html: '' }), /pagesize|total_count|paginator/i);

  await assert.rejects(() => discoverOfficialDlcs(async start => (
    start === 0
      ? catalogPage(['10', '20'], 0, 4, 2)
      : catalogPage(['10', '20'], 2, 4, 2)
  ), { pageSize: 2 }), /no new|repeated|coverage/i);

  await assert.rejects(() => discoverOfficialDlcs(async start => (
    start === 0
      ? catalogPage(['10', '20'], 0, 4, 2)
      : catalogPage([], 2, 4, 2)
  ), { pageSize: 2 }), /empty|coverage/i);
});

test('accepts only DLC owned by RPG Maker MZ', () => {
  assert.equal(isRpgMakerMzDlc({ type: 'dlc', fullgame: { appid: '1096900' } }), true);
  assert.equal(isRpgMakerMzDlc({ type: 'dlc', fullgame: { appid: '363890' } }), false);
  assert.equal(isRpgMakerMzDlc({ type: 'game', fullgame: { appid: '1096900' } }), false);
});

test('keeps verified products, rejected products, and request failures separate', async () => {
  const products = {
    '10': { type: 'dlc', fullgame: { appid: '1096900' }, name: 'Verified DLC' },
    '20': { type: 'dlc', fullgame: { appid: '363890' }, name: 'Wrong parent' },
    '30': { type: 'game', fullgame: { appid: '1096900' }, name: 'Not DLC' },
  };

  const result = await verifyProducts(['10', '20', '30', '40'], async appid => {
    if (appid === '40') throw new Error('request timed out');
    return products[appid];
  });

  assert.deepEqual(result.valid, [
    { steam_appid: '10', type: 'dlc', fullgame: { appid: '1096900' }, name: 'Verified DLC' },
  ]);
  assert.deepEqual(result.rejected, [
    { steam_appid: '20', type: 'dlc', fullgame: { appid: '363890' }, name: 'Wrong parent' },
    { steam_appid: '30', type: 'game', fullgame: { appid: '1096900' }, name: 'Not DLC' },
  ]);
  assert.deepEqual(result.failures, [{ steam_appid: '40', error: 'request timed out' }]);
});

test('preserves curated fields only when app ids match', () => {
  const result = mergeCatalog(
    [{ steam_appid: '10', title_en: 'Official' }],
    [{ steam_appid: '10', title_zh: '中文', rating: 4.8 }],
  );

  assert.equal(result[0].title_en, 'Official');
  assert.equal(result[0].title_zh, '中文');
  assert.equal(result[0].manual_rating, 4.8);
  assert.equal(result[0].recommendation_score, 87.6);
  assert.equal(mergeCatalog([{ steam_appid: '10', title_en: 'Official' }], [
    { steam_appid: '20', title_zh: '不应合并' },
  ])[0].title_zh, undefined);
});

test('does not merge a curated record that shares an official title but not its app id', () => {
  const [result] = mergeCatalog(
    [{ steam_appid: '10', title_en: 'Shared Official Title' }],
    [{
      steam_appid: '20',
      title_en: 'Shared Official Title',
      title_zh: '不应按标题关联',
      category: 'plugin',
      rating: 5,
    }],
  );

  assert.equal(result.title_zh, undefined);
  assert.equal(result.manual_rating, undefined);
  assert.equal(result.category, 'other');
});

test('keeps official fields current while retaining curated classification and description', () => {
  const result = mergeCatalog(
    [{
      steam_appid: '10',
      title_en: 'Official title',
      description: 'Official description',
      steam_url: 'https://store.steampowered.com/app/10/',
      header_image: 'https://cdn.example/official-header.jpg',
      screenshots: ['https://cdn.example/official-screenshot.jpg'],
      movies: [{ mp4: 'https://cdn.example/official-trailer.mp4' }],
      price_cny: 48,
      steam_rating: 80,
      steam_review_count: 30,
      release_date: '2026-08-05',
      is_available: true,
    }],
    [{
      steam_appid: '10',
      title_en: 'Stale title',
      description: 'Curated description',
      title_zh: '人工中文标题',
      category: 'plugin',
      sub_category: 'Tool',
      tags: ['utility'],
      rating: 4.4,
      steam_url: 'https://stale.example/app/10/',
      header_image: 'https://stale.example/header.jpg',
      screenshots: ['https://stale.example/screenshot.jpg'],
      movies: [{ mp4: 'https://stale.example/trailer.mp4' }],
      price_cny: 999,
      steam_rating: 1,
      steam_review_count: 1,
      release_date: '2000-01-01',
      is_available: false,
    }],
  );

  assert.deepEqual(result[0], {
    steam_appid: '10',
    title_en: 'Official title',
    description: 'Curated description',
    steam_url: 'https://store.steampowered.com/app/10/',
    header_image: 'https://cdn.example/official-header.jpg',
    screenshots: ['https://cdn.example/official-screenshot.jpg'],
    movies: [{ mp4: 'https://cdn.example/official-trailer.mp4' }],
    price_cny: 48,
    steam_rating: 80,
    steam_review_count: 30,
    release_date: '2026-08-05',
    is_available: true,
    title_zh: '人工中文标题',
    category: 'plugin',
    sub_category: 'Tool',
    tags: ['utility'],
    manual_rating: 4.4,
    recommendation_score: 83.4,
  });
});

test('bilingual official descriptions are not overwritten by legacy curated Chinese-only description', () => {
  const [result] = mergeCatalog(
    [{
      steam_appid: '10',
      description_en: 'Official English',
      description_zh: '官方中文',
      description: '官方中文',
    }],
    [{ steam_appid: '10', description: '旧的人工中文' }],
  );

  assert.equal(result.description_en, 'Official English');
  assert.equal(result.description_zh, '官方中文');
  assert.notEqual(result.description, '旧的人工中文');
});

test('large-sample high approval outranks one-review perfection', () => {
  const mature = calculateRecommendation({ steam_rating: 95, steam_review_count: 500 });
  const tiny = calculateRecommendation({ steam_rating: 100, steam_review_count: 1 });

  assert.ok(mature > tiny);
});

test('blends a five-point curated rating with Steam quality', () => {
  assert.equal(calculateRecommendation(
    { steam_rating: 75, steam_review_count: 0 },
    { manual_rating: 4.8 },
  ), 87.6);
});

test('infers stable categories and falls back to other', () => {
  assert.equal(inferCategory({ name: 'Epic Battle Music Pack' }), 'music');
  assert.equal(inferCategory({ name: 'Forest Tileset' }), 'tileset');
  assert.equal(inferCategory({ name: 'Dungeon Sound Effects Pack' }), 'sfx');
  assert.equal(inferCategory({ name: 'Quest Log Plugin' }), 'plugin');
  assert.equal(inferCategory({ name: 'Hero Character Generator Parts' }), 'character');
  assert.equal(inferCategory({ name: 'Side-View Battlers' }), 'battler');
  assert.equal(inferCategory({ name: 'Unclassified Resource' }), 'other');
});

test('infers categories from title and description without a product name', () => {
  assert.equal(inferCategory({ title_en: 'Forest Tileset' }), 'tileset');
  assert.equal(inferCategory({ description: 'Adds a quest log plugin to your project.' }), 'plugin');
  assert.equal(inferCategory({
    title_en: 'Mystery resource',
    description_en: 'Adds a quest log plugin to your project.',
    description: '为项目添加任务日志功能。',
  }), 'plugin');
  assert.equal(inferCategory({
    title_en: 'Mystery resource',
    description: 'A collection of unrelated illustrated objects.',
  }), 'other');
});

test('other DLC subcategory classifier covers each allowed key and its priority', () => {
  const {
    OTHER_SUBCATEGORY_KEYS,
    inferOtherSubcategory,
  } = require('./lib/dlc-taxonomy');

  assert.equal(Object.isFrozen(OTHER_SUBCATEGORY_KEYS), true);
  assert.deepEqual(OTHER_SUBCATEGORY_KEYS, [
    'background',
    'ui-window',
    'vfx-animation',
    'illustration-cg',
    'mixed-assets',
    'education',
    'other',
  ]);

  const examples = [
    [{ title_en: 'Sunset Parallax Backdrops' }, 'background'],
    [{ title_en: 'Crystal Window-Skins UI Pack' }, 'ui-window'],
    [{ title_en: 'Fire Visual-Effects Animation Pack' }, 'vfx-animation'],
    [{ title_en: 'Hero Portraits and Event-CG Illustrations' }, 'illustration-cg'],
    [{ title_en: 'Fantasy Complete Collection' }, 'mixed-assets'],
    [{ description_en: 'A tutorial handbook template project for beginners.' }, 'education'],
    [{ name: 'World Building Toolkit' }, 'other'],
  ];

  for (const [product, expected] of examples) {
    assert.equal(inferOtherSubcategory(product), expected);
  }
  assert.equal(inferOtherSubcategory({ title_en: 'Moonlit Parallax' }), 'background');
  assert.equal(
    inferOtherSubcategory({ title_en: 'Forest Tiles and Character Sprites Pack' }),
    'mixed-assets',
  );
  assert.equal(
    inferOtherSubcategory({ title_en: 'Complete Collection Window Skin' }),
    'mixed-assets',
  );
  for (const title of [
    'Character Sprites and Animations',
    'Forest Tiles and Magic Effects',
    'Fantasy Bundle',
    'Fantasy Bundles',
    'Complete Collection',
    'Complete Collections',
    'Complete-Collection',
    'Complete-Collections',
  ]) {
    assert.equal(inferOtherSubcategory({ title_en: title }), 'mixed-assets');
  }
  for (const title of [
    'Dungeon Sound Effects Pack',
    'Audio Effects Pack',
    'Music and Sound Effects',
  ]) {
    assert.equal(inferOtherSubcategory({ title_en: title }), 'other');
  }
  assert.equal(
    inferOtherSubcategory({ title_en: 'Music and Visual Effects' }),
    'mixed-assets',
  );
});

test('other DLC subcategory normalization preserves legal curation and infers legacy values', () => {
  const { normalizeSubcategory } = require('./lib/dlc-taxonomy');

  assert.equal(
    normalizeSubcategory('other', 'education', { title_en: 'Fire VFX Pack' }),
    'education',
  );
  assert.equal(
    normalizeSubcategory('other', 'Legacy free text', { title_en: 'Sky Parallax Background' }),
    'background',
  );
  assert.equal(
    normalizeSubcategory('other', '', { title_en: 'Sky Parallax Background' }),
    'background',
  );
  assert.equal(
    normalizeSubcategory('plugin', 'Tool', { title_en: 'Sky Parallax Background' }),
    'Tool',
  );
});

test('other DLC merge guarantees a legal subcategory without changing non-other values', () => {
  const catalog = mergeCatalog(
    [
      { steam_appid: '10', title_en: 'Flame Effect Animation Pack' },
      { steam_appid: '20', title_en: 'Forest Parallax Backdrop' },
      { steam_appid: '30', title_en: 'Quest Plugin' },
    ],
    [
      { steam_appid: '10', category: 'other', sub_category: 'education' },
      { steam_appid: '20', category: 'other', sub_category: 'Legacy subtype' },
      { steam_appid: '30', category: 'plugin', sub_category: 'Tool' },
    ],
  );

  assert.deepEqual(
    catalog.map(item => [item.category, item.sub_category]),
    [
      ['other', 'education'],
      ['other', 'background'],
      ['plugin', 'Tool'],
    ],
  );
});

test('other DLC catalog entries always infer a non-empty allowed subcategory', () => {
  const { OTHER_SUBCATEGORY_KEYS, inferOtherSubcategory } = require('./lib/dlc-taxonomy');
  const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/dlc-catalog.json'), 'utf8'));
  const otherItems = catalog.filter(product => product.category === 'other');

  assert.ok(otherItems.length > 0);
  for (const product of otherItems) {
    const subcategory = inferOtherSubcategory(product);
    assert.ok(OTHER_SUBCATEGORY_KEYS.includes(subcategory));
    assert.notEqual(subcategory, '');
  }
});

test('builds browser-safe catalog and media artifacts from official CNY data', () => {
  const artifacts = buildArtifacts(
    [officialFixture('10', { name: 'RPG Maker MZ - </script> Music Pack' })],
    [
      { steam_appid: '10', title_zh: '人工标题', rating: 4.8, steam_verified: false },
      { steam_appid: '20', title_en: 'Removed legacy item' },
    ],
    TIMESTAMP,
  );

  assert.equal(artifacts.catalog.length, 1);
  assert.equal(artifacts.catalog[0].price_cny, 48);
  assert.equal(artifacts.catalog[0].title_zh, '人工标题');
  assert.equal(artifacts.catalog[0].steam_verified, true);
  assert.equal(artifacts.catalog[0].last_verified_at, TIMESTAMP);
  assert.match(artifacts.catalogScript, /^window\.ALL_STEAM_DLCS = /);
  assert.doesNotMatch(artifacts.catalogScript, /<\/script>/i);
  assert.match(artifacts.mediaScript, /^window\.STEAM_IMAGES_DATA = /);
  assert.equal(
    artifacts.media['10'].movies[0].mp4,
    'https://cdn.akamai.steamstatic.com/steam/apps/10/movie_max.mp4',
  );
  assert.equal(
    artifacts.media['10'].movies[0].webm,
    'https://cdn.akamai.steamstatic.com/steam/apps/10/movie_max.webm',
  );
  assert.equal(
    artifacts.media['10'].movies[0].hls,
    'https://cdn.akamai.steamstatic.com/steam/apps/10/master.m3u8',
  );
  assert.equal(
    artifacts.media['10'].movies[0].dash,
    'https://cdn.akamai.steamstatic.com/steam/apps/10/manifest.mpd',
  );
  assert.equal(artifacts.report.summary.missing_cover, 0);
  assert.equal(artifacts.report.summary.duplicate_appids, 0);
  assert.equal(artifacts.report.summary.media_coverage, 1);
  assert.equal(artifacts.report.summary.added_count, 0);
  assert.equal(artifacts.report.summary.updated_count, 1);
  assert.equal(artifacts.report.summary.removed_count, 1);
  assert.equal(artifacts.report.summary.delisted_count, 0);
  assert.equal(artifacts.report.summary.region_unavailable_count, 0);
});

test('normalizes other DLC subcategory values for curated and newly discovered products', () => {
  const artifacts = buildArtifacts(
    [officialFixture('10'), officialFixture('20')],
    [{ steam_appid: '10', sub_category: 'Curated subtype' }],
    TIMESTAMP,
  );

  assert.deepEqual(
    artifacts.catalog.map(item => [item.steam_appid, item.sub_category]),
    [['10', 'other'], ['20', 'other']],
  );
});

test('rejects arbitrary Akamai tenants from every official media field', () => {
  const attacker = filename => `https://attacker.akamaihd.net/${filename}`;
  const steam = filename => `https://cdn.akamai.steamstatic.com/steam/apps/10/${filename}`;

  assert.equal(isOfficialSteamMediaUrl(attacker('cover.jpg')), false);
  assert.throws(() => buildArtifacts([
    officialFixture('10', { header_image: attacker('cover.jpg') }),
  ], [], TIMESTAMP), /official Steam cover/i);

  const artifacts = buildArtifacts([officialFixture('10', {
    capsule_image: attacker('capsule.jpg'),
    background_raw: attacker('background.jpg'),
    screenshots: [
      { path_full: attacker('screenshot.jpg'), path_thumbnail: steam('thumb-ok.jpg') },
      { path_full: steam('screenshot-ok.jpg'), path_thumbnail: attacker('thumb.jpg') },
    ],
    movies: [
      { thumbnail: attacker('movie-thumb.jpg'), mp4: { max: steam('movie-ok.mp4') } },
      { thumbnail: steam('movie-thumb-ok.jpg'), mp4: { max: attacker('movie.mp4') }, hls_h264: steam('ok.m3u8') },
      { webm: { max: attacker('movie.webm') }, mp4: { max: steam('ok-2.mp4') } },
      { hls_h264: attacker('master.m3u8'), mp4: { max: steam('ok-3.mp4') } },
      { dash_h264: attacker('manifest.mpd'), mp4: { max: steam('ok-4.mp4') } },
    ],
  })], [], TIMESTAMP);
  const media = artifacts.media['10'];

  assert.equal(media.capsule_image, '');
  assert.equal(media.background, '');
  assert.deepEqual(media.screenshots, [{ full: steam('screenshot-ok.jpg'), thumb: '' }]);
  assert.equal(media.movies[0].thumbnail, '');
  assert.equal(media.movies[1].mp4, '');
  assert.equal(media.movies[2].webm, '');
  assert.equal(media.movies[3].hls, '');
  assert.equal(media.movies[4].dash, '');
});

test('appdetails language URLs pin English and Simplified Chinese to the same App ID and CNY', () => {
  const firstCatalogUrl = new URL(catalogPageUrl(0, 100));
  const secondCatalogUrl = new URL(catalogPageUrl(100, 100));
  const detailsUrl = new URL(appDetailsUrl('10', 'english'));
  const chineseDetailsUrl = new URL(appDetailsUrl('10', 'schinese'));
  const reviewsUrl = new URL(reviewSummaryUrl('10'));

  assert.equal(firstCatalogUrl.hostname, 'store.steampowered.com');
  assert.equal(firstCatalogUrl.pathname, '/dlc/1096900/RPG_Maker_MZ/ajaxgetfilteredrecommendations/');
  assert.equal(firstCatalogUrl.searchParams.get('start'), '0');
  assert.equal(firstCatalogUrl.searchParams.get('count'), '100');
  assert.equal(firstCatalogUrl.searchParams.get('cc'), 'cn');
  assert.equal(secondCatalogUrl.searchParams.get('start'), '100');
  assert.equal(detailsUrl.pathname, '/api/appdetails');
  assert.equal(detailsUrl.searchParams.get('appids'), '10');
  assert.equal(detailsUrl.searchParams.get('cc'), 'cn');
  assert.equal(detailsUrl.searchParams.get('l'), 'english');
  assert.equal(chineseDetailsUrl.searchParams.get('appids'), '10');
  assert.equal(chineseDetailsUrl.searchParams.get('cc'), 'cn');
  assert.equal(chineseDetailsUrl.searchParams.get('l'), 'schinese');
  assert.equal(reviewsUrl.pathname, '/appreviews/10');
  assert.equal(reviewsUrl.searchParams.get('json'), '1');
  assert.equal(reviewsUrl.searchParams.get('filter'), 'all');
  assert.equal(reviewsUrl.searchParams.get('num_per_page'), '0');
});

test('appdetails language option is honored by the real details fetch boundary', async () => {
  const originalGet = https.get;
  let requestedUrl;
  https.get = (url, options, callback) => {
    requestedUrl = String(url);
    const request = new EventEmitter();
    request.destroy = error => request.emit('error', error);
    const response = new EventEmitter();
    response.statusCode = 200;
    response.headers = {};
    response.setEncoding = () => {};
    response.resume = () => {};
    queueMicrotask(() => {
      callback(response);
      queueMicrotask(() => {
        response.emit('data', JSON.stringify({
          '10': { success: true, data: { name: '中文详情' } },
        }));
        response.emit('end');
      });
    });
    return request;
  };

  try {
    assert.deepEqual(await fetchAppDetails('10', { language: 'schinese' }), { name: '中文详情' });
  } finally {
    https.get = originalGet;
  }

  const parsed = new URL(requestedUrl);
  assert.equal(parsed.searchParams.get('appids'), '10');
  assert.equal(parsed.searchParams.get('cc'), 'cn');
  assert.equal(parsed.searchParams.get('l'), 'schinese');
});

test('bilingual completeness gate names every affected App ID before publication can run', async () => {
  let publicationCount = 0;

  await assert.rejects(() => syncSteamDlcs({
    fetchPage: async start => catalogPage(['10', '20'], start, 2, 2),
    fetchDetails: async (appid, options) => officialFixture(appid, options.language === 'schinese'
      ? { short_description: appid === '10' ? '中文十' : '' }
      : { short_description: appid === '10' ? '' : 'English twenty' }),
    fetchReviews: async () => ({ success: 1, query_summary: { total_reviews: 0 } }),
    curated: [],
    previousCatalog: [],
    fallbackTranslations: {},
    timestamp: TIMESTAMP,
    sleep: async () => {},
    publish: () => { publicationCount += 1; },
  }), /10.*20|20.*10/);

  assert.equal(publicationCount, 0);
});

test('bilingual artifact gate rejects descriptions that normalize empty and names exact App IDs', () => {
  assert.throws(() => buildArtifacts([
    officialFixture('10', {
      description_en: '<script>not visible</script>',
      description_zh: '中文十',
    }),
    officialFixture('20', {
      description_en: 'English twenty',
      description_zh: '<style>.hidden {}</style>',
    }),
  ], [], TIMESTAMP), /10.*20|20.*10/);
});

test('bilingual artifact gate reached by sync prevents the publish callback', async () => {
  let buildCount = 0;
  let publicationCount = 0;

  await assert.rejects(() => syncSteamDlcs({
    fetchPage: async start => catalogPage(['10'], start, 1, 1),
    fetchDetails: async (appid, options) => officialFixture(appid, options.language === 'schinese'
      ? { short_description: '官方中文' }
      : { short_description: 'Official English' }),
    fetchReviews: async () => ({ success: 1, query_summary: { total_reviews: 0 } }),
    buildArtifacts: (verified, curated, timestamp, audit) => {
      buildCount += 1;
      return buildArtifacts(verified.map(product => ({
        ...product,
        description_zh: '<style>not visible</style>',
      })), curated, timestamp, audit);
    },
    curated: [],
    previousCatalog: [],
    fallbackTranslations: {},
    timestamp: TIMESTAMP,
    sleep: async () => {},
    publish: () => { publicationCount += 1; },
  }), /bilingual.*10|10.*bilingual/i);

  assert.equal(buildCount, 1);
  assert.equal(publicationCount, 0);
});

test('refuses artifacts whose verified product lacks an official Steam cover', () => {
  assert.throws(
    () => buildArtifacts([officialFixture('10', { header_image: '' })], [], TIMESTAMP),
    /cover/i,
  );
  assert.throws(
    () => buildArtifacts([officialFixture('10', { header_image: 'https://example.com/header.jpg' })], [], TIMESTAMP),
    /official Steam cover/i,
  );
});

test('refuses duplicate app ids before publication artifacts are produced', () => {
  assert.throws(
    () => buildArtifacts([officialFixture('10'), officialFixture('10')], [], TIMESTAMP),
    /duplicate/i,
  );
});

test('preflights every atomic publication file before replacing existing artifacts', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-sync-publication-'));
  const catalogFile = path.join(directory, 'dlc-catalog.json');
  const mediaFile = path.join(directory, 'steam-images.json');
  fs.writeFileSync(catalogFile, '[{"old":true}]');
  fs.writeFileSync(mediaFile, '{"old":true}');

  assert.throws(() => publishAtomically({
    [catalogFile]: '[{"new":true}]',
    [mediaFile]: '{invalid json',
  }), /parse|json/i);
  assert.equal(fs.readFileSync(catalogFile, 'utf8'), '[{"old":true}]');
  assert.equal(fs.readFileSync(mediaFile, 'utf8'), '{"old":true}');

  publishAtomically({
    [catalogFile]: '[{"new":true}]',
    [mediaFile]: '{"new":true}',
  });
  assert.equal(fs.readFileSync(catalogFile, 'utf8'), '[{"new":true}]');
  assert.equal(fs.readFileSync(mediaFile, 'utf8'), '{"new":true}');
});

test('keeps newly published artifacts when obsolete-backup cleanup fails', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-sync-cleanup-'));
  const catalogFile = path.join(directory, 'dlc-catalog.json');
  const mediaFile = path.join(directory, 'steam-images.json');
  fs.writeFileSync(catalogFile, '[{"old":true}]');
  fs.writeFileSync(mediaFile, '{"old":true}');
  const originalUnlinkSync = fs.unlinkSync;
  let backupUnlinks = 0;

  fs.unlinkSync = filename => {
    if (String(filename).includes('.bak-')) {
      backupUnlinks += 1;
      if (backupUnlinks === 2) throw new Error('simulated backup cleanup failure');
    }
    return originalUnlinkSync(filename);
  };
  try {
    publishAtomically({
      [catalogFile]: '[{"new":true}]',
      [mediaFile]: '{"new":true}',
    });
  } finally {
    fs.unlinkSync = originalUnlinkSync;
  }

  assert.equal(fs.readFileSync(catalogFile, 'utf8'), '[{"new":true}]');
  assert.equal(fs.readFileSync(mediaFile, 'utf8'), '{"new":true}');
});

test('restores all five old artifacts for faults at every write, backup, and publish position', async t => {
  const artifactNames = [
    'dlc-catalog.json',
    'dlc-catalog.js',
    'steam-images.json',
    'steam-images.js',
    'steam-full-sync-report.json',
  ];
  const contentFor = (name, generation) => {
    if (name === 'dlc-catalog.json') return `[{"generation":"${generation}"}]`;
    if (name === 'dlc-catalog.js') return `window.ALL_STEAM_DLCS = [{"generation":"${generation}"}];\n`;
    if (name === 'steam-images.js') return `window.STEAM_IMAGES_DATA = {"generation":"${generation}"};\n`;
    return `{"generation":"${generation}"}`;
  };

  for (const stage of ['write', 'backup', 'publish']) {
    for (let failAt = 1; failAt <= artifactNames.length; failAt += 1) {
      await t.test(`${stage} failure at artifact ${failAt}`, () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), `steam-sync-${stage}-`));
        const oldFiles = Object.fromEntries(artifactNames.map(name => [
          path.join(directory, name), contentFor(name, 'old'),
        ]));
        const newFiles = Object.fromEntries(artifactNames.map(name => [
          path.join(directory, name), contentFor(name, 'new'),
        ]));
        Object.entries(oldFiles).forEach(([filename, content]) => fs.writeFileSync(filename, content));

        const originalWriteFileSync = fs.writeFileSync;
        const originalRenameSync = fs.renameSync;
        let mutations = 0;
        fs.writeFileSync = (filename, ...args) => {
          if (stage === 'write' && String(filename).includes('.tmp-')) {
            mutations += 1;
            if (mutations === failAt) throw new Error(`injected ${stage} failure ${failAt}`);
          }
          return originalWriteFileSync(filename, ...args);
        };
        fs.renameSync = (source, target) => {
          const isBackup = String(target).includes('.bak-');
          const isPublish = String(source).includes('.tmp-');
          if ((stage === 'backup' && isBackup) || (stage === 'publish' && isPublish)) {
            mutations += 1;
            if (mutations === failAt) throw new Error(`injected ${stage} failure ${failAt}`);
          }
          return originalRenameSync(source, target);
        };
        try {
          assert.throws(() => publishAtomically(newFiles), /Atomic publication failed/);
        } finally {
          fs.writeFileSync = originalWriteFileSync;
          fs.renameSync = originalRenameSync;
        }

        for (const [filename, content] of Object.entries(oldFiles)) {
          assert.equal(fs.readFileSync(filename, 'utf8'), content);
        }
        assert.deepEqual(fs.readdirSync(directory).sort(), artifactNames.slice().sort());
      });
    }
  }
});

test('sync retries official requests, limits concurrency, enriches reviews, and publishes five artifacts', async () => {
  const detailAttempts = new Map();
  const sleeps = [];
  const pageOptions = [];
  const detailOptions = [];
  const reviewOptions = [];
  const requestScheduler = {
    waitForSlot: async () => {},
    observeStatus: () => {},
  };
  let active = 0;
  let maximumActive = 0;
  let published;

  const result = await syncSteamDlcs({
    fetchPage: async (start, options) => {
      pageOptions.push(options);
      return catalogPage(['10', '20', '30', '40'], start, 4, 4);
    },
    fetchDetails: async (appid, options) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      detailOptions.push(options);
      const attempt = (detailAttempts.get(appid) || 0) + 1;
      detailAttempts.set(appid, attempt);
      await Promise.resolve();
      active -= 1;
      if (appid === '20' && options.language === 'english' && attempt < 3) throw new Error('temporary detail failure');
      if (appid === '30') return officialFixture(appid, { fullgame: { appid: '363890' } });
      return officialFixture(appid, options.language === 'schinese'
        ? { short_description: `官方中文 ${appid}` }
        : {});
    },
    fetchReviews: async (appid, options) => {
      reviewOptions.push(options);
      return {
        success: 1,
        query_summary: {
          total_positive: appid === '10' ? 90 : 45,
          total_reviews: appid === '10' ? 100 : 50,
        },
      };
    },
    curated: [{ steam_appid: '10', title_zh: '人工标题' }],
    timestamp: TIMESTAMP,
    sleep: async milliseconds => { sleeps.push(milliseconds); },
    publish: files => { published = files; },
    outputDir: '/virtual/data',
    requestScheduler,
  });

  assert.ok(maximumActive <= 3);
  assert.equal(detailAttempts.get('20'), 4);
  assert.deepEqual(sleeps, [250, 500]);
  assert.ok(pageOptions.every(options => options.requestScheduler === requestScheduler));
  assert.ok(detailOptions.every(options => (
    options.country === 'cn'
    && ['english', 'schinese'].includes(options.language)
    && options.timeoutMs === 15000
    && options.requestScheduler === requestScheduler
  )));
  assert.ok(reviewOptions.every(options => (
    options.language === 'all'
    && options.timeoutMs === 15000
    && options.requestScheduler === requestScheduler
  )));
  assert.equal(result.artifacts.catalog.length, 3);
  assert.equal(result.artifacts.catalog.find(item => item.steam_appid === '10').steam_rating, 90);
  assert.equal(result.artifacts.catalog.find(item => item.steam_appid === '40').steam_review_count, 50);
  assert.equal(result.artifacts.report.summary.official_discovered, 4);
  assert.equal(result.artifacts.report.summary.verified_count, 3);
  assert.equal(result.artifacts.report.summary.rejected_count, 1);
  assert.equal(result.artifacts.report.retries.length, 2);
  assert.deepEqual(Object.keys(published).sort(), [
    '/virtual/data/dlc-catalog.js',
    '/virtual/data/dlc-catalog.json',
    '/virtual/data/steam-full-sync-report.json',
    '/virtual/data/steam-images.js',
    '/virtual/data/steam-images.json',
  ]);
});

test('localized sync calls both languages on one scheduler and keeps English metadata authoritative', async () => {
  const detailCalls = [];
  const requestScheduler = { waitForSlot: async () => {}, observeStatus: () => {} };

  const result = await syncSteamDlcs({
    fetchPage: async start => catalogPage(['10'], start, 1, 1),
    fetchDetails: async (appid, options) => {
      detailCalls.push({ appid, ...options });
      if (options.language === 'schinese') {
        return officialFixture(appid, {
          name: '不应替换英文名',
          short_description: '简体中文介绍',
          fullgame: { appid: '363890' },
          price_overview: { currency: 'CNY', final: 1 },
          header_image: 'https://example.com/untrusted.jpg',
          screenshots: [],
          movies: [],
        });
      }
      return officialFixture(appid, {
        name: 'Authoritative English name',
        short_description: 'Authoritative English description',
      });
    },
    fetchReviews: async () => ({ success: 1, query_summary: { total_reviews: 0 } }),
    curated: [],
    previousCatalog: [],
    fallbackTranslations: {},
    timestamp: TIMESTAMP,
    sleep: async () => {},
    publish: () => {},
    requestScheduler,
  });

  assert.deepEqual(detailCalls.map(call => [call.appid, call.language]), [
    ['10', 'english'],
    ['10', 'schinese'],
  ]);
  assert.ok(detailCalls.every(call => call.requestScheduler === requestScheduler));
  const [product] = result.artifacts.catalog;
  assert.equal(product.title_en, 'Authoritative English name');
  assert.equal(product.description_en, 'Authoritative English description');
  assert.equal(product.description_zh, '简体中文介绍');
  assert.equal(product.description, '简体中文介绍');
  assert.equal(product.parent_appid, '1096900');
  assert.equal(product.price_cny, 48);
  assert.match(product.header_image, /steamstatic\.com/);
  assert.equal(product.screenshots.length, 1);
  assert.equal(product.movies.length, 1);
});

test('localized sync audits either locale failure as details and prevents publication', async t => {
  for (const failedLanguage of ['english', 'schinese']) {
    await t.test(failedLanguage, async () => {
      let publicationCount = 0;
      await assert.rejects(() => syncSteamDlcs({
        fetchPage: async start => catalogPage(['10'], start, 1, 1),
        fetchDetails: async (appid, options) => {
          if (options.language === failedLanguage) throw new Error(`${failedLanguage} unavailable`);
          return officialFixture(appid, { short_description: '简体中文介绍' });
        },
        fetchReviews: async () => ({ success: 1, query_summary: { total_reviews: 0 } }),
        curated: [],
        previousCatalog: [],
        fallbackTranslations: {},
        timestamp: TIMESTAMP,
        sleep: async () => {},
        publish: () => { publicationCount += 1; },
      }), new RegExp(`details.*10.*${failedLanguage}`, 'i'));
      assert.equal(publicationCount, 0);
    });
  }
});

test('does not publish when exhausted retries leave official coverage uncertain', async () => {
  let attempts = 0;
  let publicationCount = 0;

  await assert.rejects(() => syncSteamDlcs({
    fetchPage: async start => catalogPage(['10'], start, 1, 1),
    fetchDetails: async () => {
      attempts += 1;
      throw new Error('Steam unavailable');
    },
    fetchReviews: async () => ({ success: 1, query_summary: { total_reviews: 0 } }),
    curated: [],
    previousCatalog: [],
    timestamp: TIMESTAMP,
    sleep: async () => {},
    publish: () => { publicationCount += 1; },
  }), /aborted|coverage|failure/i);

  assert.equal(attempts, 3);
  assert.equal(publicationCount, 0);
});

test('does not publish an empty catalog when discovery returns no official app ids', async () => {
  let publicationCount = 0;

  await assert.rejects(() => syncSteamDlcs({
    fetchPage: async () => catalogPage([], 0, 0, 10),
    curated: [],
    timestamp: TIMESTAMP,
    sleep: async () => {},
    publish: () => { publicationCount += 1; },
  }), /aborted|empty|discovery|coverage/i);

  assert.equal(publicationCount, 0);
});

test('does not publish when every discovered candidate fails parent validation', async () => {
  let publicationCount = 0;

  await assert.rejects(() => syncSteamDlcs({
    fetchPage: async start => catalogPage(['10'], start, 1, 1),
    fetchDetails: async () => officialFixture('10', { fullgame: { appid: '363890' } }),
    fetchReviews: async () => ({ success: 1, query_summary: { total_reviews: 0 } }),
    curated: [],
    previousCatalog: [],
    timestamp: TIMESTAMP,
    sleep: async () => {},
    publish: () => { publicationCount += 1; },
  }), /aborted|empty|validation|coverage/i);

  assert.equal(publicationCount, 0);
});

test('does not publish an unexpected inventory shrink without explicit approval', async () => {
  let publicationCount = 0;

  await assert.rejects(() => syncSteamDlcs({
    fetchPage: async start => catalogPage(['10', '30'], start, 2, 2),
    fetchDetails: async appid => appid === '30'
      ? officialFixture(appid, { fullgame: { appid: '363890' } })
      : officialFixture(appid),
    fetchReviews: async () => ({ success: 1, query_summary: { total_reviews: 0 } }),
    curated: [],
    previousCatalog: [{ steam_appid: '10' }, { steam_appid: '20' }],
    timestamp: TIMESTAMP,
    sleep: async () => {},
    publish: () => { publicationCount += 1; },
  }), /aborted|shrink|coverage/i);

  assert.equal(publicationCount, 0);
});

test('keeps official discovery order when concurrent enrichment finishes out of order', async () => {
  const result = await syncSteamDlcs({
    fetchPage: async start => catalogPage(['10', '20'], start, 2, 2),
    fetchDetails: async (appid, options) => {
      if (appid === '10') await new Promise(resolve => setTimeout(resolve, 10));
      return officialFixture(appid, options.language === 'schinese'
        ? { short_description: `官方中文 ${appid}` }
        : {});
    },
    fetchReviews: async () => ({
      success: 1,
      query_summary: { total_positive: 1, total_reviews: 1 },
    }),
    curated: [],
    previousCatalog: [],
    timestamp: TIMESTAMP,
    sleep: async () => {},
    publish: () => {},
    concurrency: 2,
  });

  assert.deepEqual(result.artifacts.catalog.map(item => item.steam_appid), ['10', '20']);
});
