const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  buildCategoryNavigation,
  filterByCategory,
} = require('./js/dlc-filters.js');

const fixtures = [
  { id: 'tile-1', category: 'tileset' },
  { id: 'music-1', category: 'music' },
  { id: 'other-background', category: 'other', sub_category: 'background' },
  { id: 'other-window', category: 'other', sub_category: 'ui-window' },
  { id: 'other-misc', category: 'other', sub_category: 'other' },
];

test('places all first at level zero and keeps other beside level-one categories', () => {
  const navigation = buildCategoryNavigation(fixtures, fixtures, { category: null, subcategory: null });
  const all = navigation[0];
  const other = navigation.find((item) => item.key === 'other');

  assert.equal(all.key, 'all');
  assert.equal(all.level, 0);
  assert.equal(other.level, 1);
  assert.equal(navigation.find((item) => item.key === 'tileset').level, 1);
  assert.equal(navigation.find((item) => item.key === 'music').level, 1);
  assert.deepEqual(other.children.map((item) => item.level), [2, 2, 2]);
});

test('orders present other children by the fixed taxonomy order', () => {
  const navigation = buildCategoryNavigation(fixtures, fixtures, { category: 'other', subcategory: null });
  const other = navigation.find((item) => item.key === 'other');

  assert.deepEqual(other.children.map((item) => item.key), ['background', 'ui-window', 'other']);
});

test('selecting top-level other returns every other item', () => {
  assert.deepEqual(
    filterByCategory(fixtures, { category: 'other', subcategory: null }).map((item) => item.id),
    ['other-background', 'other-window', 'other-misc'],
  );
});

test('selecting other background returns only its exact child', () => {
  assert.deepEqual(
    filterByCategory(fixtures, { category: 'other', subcategory: 'background' }).map((item) => item.id),
    ['other-background'],
  );
});

test('non-other category selection ignores a stale subcategory', () => {
  assert.deepEqual(
    filterByCategory(fixtures, { category: 'tileset', subcategory: 'background' }).map((item) => item.id),
    ['tile-1'],
  );
});

test('category filtering returns a new array without mutating its input', () => {
  const originalIds = fixtures.map((item) => item.id);
  const result = filterByCategory(fixtures, { category: 'other', subcategory: null });

  assert.notEqual(result, fixtures);
  assert.deepEqual(fixtures.map((item) => item.id), originalIds);
});

test('navigation uses visible DLCs for counts and all DLCs for tree presence', () => {
  const visible = [fixtures[0], fixtures[2]];
  const navigation = buildCategoryNavigation(fixtures, visible, { category: null, subcategory: null });
  const other = navigation.find((item) => item.key === 'other');

  assert.equal(navigation[0].count, 2);
  assert.equal(other.count, 1);
  assert.deepEqual(other.children.map((item) => [item.key, item.count]), [
    ['background', 1],
    ['ui-window', 0],
    ['other', 0],
  ]);
});

test('loads filters before the application and declares subcategory state', () => {
  const projectRoot = __dirname;
  const index = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(projectRoot, 'js/app.js'), 'utf8');

  const filtersScript = index.indexOf('src="js/dlc-filters.js"');
  const appScript = index.indexOf('src="js/app.js"');

  assert.notEqual(filtersScript, -1, 'index.html must load js/dlc-filters.js');
  assert.notEqual(appScript, -1, 'index.html must load js/app.js');
  assert.ok(filtersScript < appScript, 'js/dlc-filters.js must load before js/app.js');
  assert.match(app, /activeSubcategory:\s*null/);
  assert.match(app, /data-category="\$\{escapeHtmlAttribute\(item\.key\)\}"/);
});
