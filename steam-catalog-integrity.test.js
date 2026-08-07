const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildArtifacts } = require('./sync-steam-dlcs');

const DATA_DIR = path.join(__dirname, 'data');
const OTHER_SUBCATEGORY_KEYS = new Set([
  'background', 'ui-window', 'vfx-animation', 'illustration-cg',
  'mixed-assets', 'education', 'other',
]);

function readArtifact(name) {
  const filename = path.join(DATA_DIR, name);
  assert.ok(fs.existsSync(filename), `missing generated canonical artifact: ${filename}`);
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

function verifiedProduct(appid = '10') {
  return {
    steam_appid: appid,
    type: 'dlc',
    fullgame: { appid: '1096900' },
    name: 'RPG Maker MZ - Official Pack',
    description_en: 'Official English description.',
    description_zh: '官方中文介绍。',
    header_image: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`,
    screenshots: [{
      path_full: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/screenshot.jpg`,
    }],
    movies: [{
      mp4: { max: `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/trailer.mp4` },
    }],
    is_free: true,
  };
}

function assertCanonicalAppIdSetEquality(catalog, media, report) {
  const catalogAppids = catalog.map(item => String(item.steam_appid));
  const reportAppids = report.items.map(item => String(item.steam_appid));
  const mediaAppids = Object.keys(media).map(String);

  assert.equal(
    new Set(catalogAppids).size,
    catalogAppids.length,
    'canonical catalog contains duplicate App IDs',
  );
  assert.equal(
    new Set(reportAppids).size,
    reportAppids.length,
    'canonical report contains duplicate App-ID evidence',
  );
  assert.deepEqual(
    [...new Set(catalogAppids)].sort(),
    [...new Set(reportAppids)].sort(),
    'canonical report item App-ID set must equal catalog App-ID set',
  );
  assert.deepEqual(
    [...new Set(catalogAppids)].sort(),
    [...new Set(mediaAppids)].sort(),
    'canonical media App-ID set must equal catalog App-ID set',
  );
}

test('canonical artifacts require exact catalog, audit, and media App-ID sets', () => {
  const catalog = [{ steam_appid: '10' }, { steam_appid: '20' }];
  const media = { '10': {}, '20': {} };
  const report = { items: [{ steam_appid: '10' }, { steam_appid: '20' }] };

  assert.doesNotThrow(() => assertCanonicalAppIdSetEquality(catalog, media, report));
  assert.throws(
    () => assertCanonicalAppIdSetEquality(catalog, media, {
      items: [{ steam_appid: '10' }, { steam_appid: '10' }],
    }),
    /duplicate|report item/i,
  );
  assert.throws(
    () => assertCanonicalAppIdSetEquality(catalog, { ...media, '30': {} }, report),
    /media App-ID set/i,
  );
});

test('publication audit records all release-gate counts and App-ID evidence', () => {
  const product = verifiedProduct();
  product.screenshots.push({
    path_full: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/10/screenshot-two.jpg',
  });
  product.movies.push({
    mp4: { max: 'https://cdn.akamai.steamstatic.com/steam/apps/10/trailer-two.mp4' },
  });
  const artifacts = buildArtifacts([product], [], '2026-08-05T00:00:00.000Z', {
    discoveredCount: 2,
    rejected: [{ steam_appid: '20', fullgame: { appid: '363890' } }],
    failures: [{ steam_appid: '30', stage: 'details', error: 'timeout' }],
    retries: [{ steam_appid: '10', stage: 'reviews', attempt: 1 }],
  });

  assert.deepEqual(
    Object.fromEntries([
      'discovered', 'verified', 'rejected', 'unavailable', 'added', 'updated', 'removed',
      'duplicate', 'missing_cover', 'bilingual_missing', 'screenshot', 'video', 'retry',
      'failure', 'published',
    ].map(name => [name, artifacts.report.summary[name]])),
    {
      discovered: 2,
      verified: 1,
      rejected: 1,
      unavailable: 0,
      added: 1,
      updated: 0,
      removed: 0,
      duplicate: 0,
      missing_cover: 0,
      bilingual_missing: 0,
      screenshot: 2,
      video: 2,
      retry: 1,
      failure: 1,
      published: 1,
    },
  );
  assert.deepEqual(artifacts.report.items, [{
    steam_appid: '10',
    title_en: 'RPG Maker MZ - Official Pack',
    parent_appid: '1096900',
    verified: true,
    is_available: true,
    has_cover: true,
    screenshot_count: 2,
    movie_count: 2,
  }]);
});

test('published inventory is unique, verified, and media-complete', () => {
  const catalog = readArtifact('dlc-catalog.json');
  const media = readArtifact('steam-images.json');
  const report = readArtifact('steam-full-sync-report.json');

  assert.ok(Array.isArray(catalog) && catalog.length > 0, 'catalog must contain published DLCs');
  assertCanonicalAppIdSetEquality(catalog, media, report);
  assert.ok(catalog.every(item => item.parent_appid === '1096900'));
  assert.ok(catalog.every(item => item.header_image && media[item.steam_appid]?.header_image));
  assert.ok(catalog.every(item => media[item.steam_appid].header_image === item.header_image));
  assert.equal(report.summary.verified, catalog.length);
  assert.equal(report.summary.published, catalog.length);
  assert.equal(report.summary.verified, report.summary.published);
  assert.equal(report.items.length, catalog.length);
  for (const field of [
    'rejected_count', 'request_failure_count', 'duplicate_appids', 'wrong_parent',
    'missing_cover', 'bilingual_missing', 'rejected', 'duplicate', 'failure',
  ]) {
    assert.equal(report.summary[field], 0, `report summary ${field} must be zero`);
  }
  assert.ok(report.items.every(item => (
    item.parent_appid === '1096900' && item.verified === true && item.has_cover === true
  )));
});

test('live-artifact bilingual integrity gate requires the new schema for every published App ID', () => {
  const catalog = readArtifact('dlc-catalog.json');
  const incomplete = catalog.filter(item => (
    typeof item.description_en !== 'string'
    || item.description_en.trim() === ''
    || typeof item.description_zh !== 'string'
    || item.description_zh.trim() === ''
  ));

  assert.deepEqual(
    incomplete.map(item => String(item.steam_appid)),
    [],
    'published bilingual fields are missing for one or more exact Steam App IDs',
  );
  assert.deepEqual(
    catalog
      .filter(item => item.category === 'other' && !OTHER_SUBCATEGORY_KEYS.has(item.sub_category))
      .map(item => String(item.steam_appid)),
    [],
    'published other entries must use one of the seven exact subcategory keys',
  );
});
