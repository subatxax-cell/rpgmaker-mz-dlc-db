const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function catalogPage(appids) {
  return {
    success: 1,
    pagesize: appids.length || 10,
    total_count: appids.length,
    start: 0,
    results_html: appids.map(appid => `data-ds-appid="${appid}"`).join(' '),
  };
}

function readArtifact(name) {
  const filename = path.join(__dirname, 'data', name);
  assert.ok(fs.existsSync(filename), `missing generated canonical artifact: ${filename}`);
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

function assertCanonicalAppIdSetEquality(catalog, media, report) {
  const catalogAppids = catalog.map(item => String(item.steam_appid));
  const reportAppids = report.items.map(item => String(item.steam_appid));
  const mediaAppids = Object.keys(media).map(String);

  assert.equal(new Set(catalogAppids).size, catalogAppids.length, 'catalog has duplicate App IDs');
  assert.equal(new Set(reportAppids).size, reportAppids.length, 'report has duplicate App-ID evidence');
  assert.deepEqual(
    [...new Set(catalogAppids)].sort(),
    [...new Set(reportAppids)].sort(),
    'report item App-ID set must equal catalog App-ID set',
  );
  assert.deepEqual(
    [...new Set(catalogAppids)].sort(),
    [...new Set(mediaAppids)].sort(),
    'media App-ID set must equal catalog App-ID set',
  );
}

const {
  parseSteamTarget,
  mergeMediaRecord,
  mergeSuccessfulResults,
  extractStoreMedia,
  normalizeMovie,
  resolveRedirectUrl,
  toBrowserDataScript,
  extractVerifiedTargets,
  main: refreshMediaCompatibility,
} = require('./fetch-steam-images.js');

test('generated media maps every published App ID and reports media evidence', () => {
  const catalog = readArtifact('dlc-catalog.json');
  const media = readArtifact('steam-images.json');
  const report = readArtifact('steam-full-sync-report.json');

  assert.ok(Array.isArray(catalog) && catalog.length > 0, 'catalog must contain published DLCs');
  assertCanonicalAppIdSetEquality(catalog, media, report);
  assert.ok(catalog.every(item => (
    media[item.steam_appid]
    && media[item.steam_appid].appid === item.steam_appid
    && media[item.steam_appid].header_image === item.header_image
  )));

  const screenshotCount = catalog.reduce(
    (total, item) => total + media[item.steam_appid].screenshots.length,
    0,
  );
  const videoCount = catalog.reduce(
    (total, item) => total + media[item.steam_appid].movies.length,
    0,
  );
  assert.equal(report.summary.screenshot, screenshotCount);
  assert.equal(report.summary.video, videoCount);
  assert.equal(report.summary.media_coverage, 1);
  assert.ok(report.items.every(item => {
    const record = media[item.steam_appid];
    return record
      && item.screenshot_count === record.screenshots.length
      && item.movie_count === record.movies.length;
  }));
});

test('parses both app and bundle Steam store links', () => {
  assert.deepEqual(
    parseSteamTarget('https://store.steampowered.com/app/3243580/example/'),
    { type: 'app', id: '3243580' },
  );
  assert.deepEqual(
    parseSteamTarget('https://store.steampowered.com/bundle/60511/example/'),
    { type: 'bundle', id: '60511' },
  );
});

test('does not refresh catalog records explicitly marked unverified', () => {
  const source = `const ALL_DLCS = [
    { steam_url: "https://store.steampowered.com/app/123/ok/", steam_verified: true },
    { steam_url: "https://store.steampowered.com/app/456/bad/", steam_verified: false }
  ];`;
  assert.deepEqual(extractVerifiedTargets(source), [{ type: 'app', id: '123' }]);
});

test('serializes media cache as a script loadable from file URLs', () => {
  const source = toBrowserDataScript({ '123': { name: '</script><x>' } });
  assert.equal(source, 'window.STEAM_IMAGES_DATA = {"123":{"name":"\\u003c/script>\\u003cx>"}};\n');
});

test('resolves Steam relative redirects', () => {
  assert.equal(
    resolveRedirectUrl('/agecheck/bundle/60511/', 'https://store.steampowered.com/bundle/60511/'),
    'https://store.steampowered.com/agecheck/bundle/60511/',
  );
});

test('keeps Steam current HLS and DASH trailer fields', () => {
  assert.deepEqual(normalizeMovie({
    name: 'Trailer', thumbnail: 'thumb.jpg',
    hls_h264: 'https://video.example/master.m3u8',
    dash_h264: 'https://video.example/manifest.mpd',
  }), {
    name: 'Trailer', thumbnail: 'thumb.jpg', mp4: '', webm: '',
    hls: 'https://video.example/master.m3u8',
    dash: 'https://video.example/manifest.mpd',
  });
});

test('extracts original screenshots and videos from a Steam store page', () => {
  const html = `
    <meta property="og:title" content="Bundle Name">
    <meta property="og:image" content="https://cdn.example/header.jpg">
    <a href="https:\\/\\/cdn.example\\/ss_abc.1920x1080.jpg?t=1"></a>
    <source src="https:\/\/cdn.example\/movie_max.mp4?t=2">
  `;
  assert.deepEqual(extractStoreMedia(html, 'bundle', '60511'), {
    appid: '60511',
    type: 'bundle',
    name: 'Bundle Name',
    header_image: 'https://cdn.example/header.jpg',
    capsule_image: '',
    screenshots: [{ full: 'https://cdn.example/ss_abc.1920x1080.jpg?t=1', thumb: '' }],
    movies: [{ mp4: 'https://cdn.example/movie_max.mp4?t=2', webm: '', thumbnail: '' }],
    background: '',
  });
});

test('merges manual screenshots with Steam screenshots without duplicates', () => {
  const merged = mergeMediaRecord(
    { screenshots: ['manual.jpg', 'same.jpg'] },
    { screenshots: [{ full: 'same.jpg' }, { full: 'steam.jpg' }] },
  );
  assert.deepEqual(merged.screenshots, ['manual.jpg', 'same.jpg', 'steam.jpg']);
});

test('keeps cached records when a refresh fails', () => {
  const cached = { '123': { appid: '123', screenshots: [{ full: 'old.jpg' }] } };
  const refreshed = [
    { appid: '123', error: 'timeout' },
    { appid: '456', screenshots: [{ full: 'new.jpg' }] },
  ];
  assert.deepEqual(mergeSuccessfulResults(cached, refreshed), {
    '123': cached['123'],
    '456': refreshed[1],
  });
});

test('compatibility CLI delegates to the shared five-artifact full sync', async () => {
  let published;
  await refreshMediaCompatibility({
    fetchPage: async () => catalogPage(['10']),
    fetchDetails: async (appid, options) => ({
      type: 'dlc',
      fullgame: { appid: '1096900' },
      name: 'RPG Maker MZ - Official Pack',
      short_description: options.language === 'schinese'
        ? '官方简体中文介绍。'
        : 'Official English description.',
      header_image: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/10/header.jpg',
      screenshots: [],
      movies: [],
      is_free: true,
    }),
    fetchReviews: async () => ({
      success: 1,
      query_summary: { total_positive: 0, total_reviews: 0 },
    }),
    curated: [],
    timestamp: '2026-08-05T00:00:00.000Z',
    sleep: async () => {},
    publish: files => { published = files; },
    outputDir: '/virtual/data',
  });

  assert.ok(published['/virtual/data/dlc-catalog.json']);
  assert.ok(published['/virtual/data/steam-images.json']);
  assert.ok(published['/virtual/data/steam-full-sync-report.json']);
  assert.equal(Object.keys(published).length, 5);
});
