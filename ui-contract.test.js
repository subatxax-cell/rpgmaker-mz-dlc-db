const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = __dirname;
const index = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(projectRoot, 'js/app.js'), 'utf8');
const css = fs.readFileSync(path.join(projectRoot, 'css/style.css'), 'utf8');

test('recommendation select uses clear high-first and low-first labels', () => {
  const sortSelect = index.match(/<select class="sort-select" id="sort-select">([\s\S]*?)<\/select>/);

  assert.ok(sortSelect, 'sort select markup must exist');
  assert.match(index, />推荐度高优先</);
  assert.match(index, />推荐度低优先</);
  assert.doesNotMatch(index, /推荐度 ↓/);
  assert.doesNotMatch(index, /推荐度 ↑/);
  assert.match(index, /<option value="recommendation-desc" selected>推荐度高优先<\/option>/);
  assert.match(index, /<option value="recommendation-asc">推荐度低优先<\/option>/);
  assert.doesNotMatch(sortSelect[1], /value="rating-desc"/);
  assert.doesNotMatch(sortSelect[1], /value="rating-asc"/);
});

test('Fuse indexes both canonical descriptions ahead of the legacy compatibility field', () => {
  const weights = Object.fromEntries(
    [...app.matchAll(/\{ name: '(description(?:_en|_zh)?)', weight: ([0-9.]+) \}/g)]
      .map((match) => [match[1], Number(match[2])]),
  );

  assert.ok(Number.isFinite(weights.description_en), 'Fuse must index description_en');
  assert.ok(Number.isFinite(weights.description_zh), 'Fuse must index description_zh');
  assert.ok(Number.isFinite(weights.description), 'Fuse must retain legacy description compatibility');
  assert.ok(weights.description > 0, 'legacy description compatibility weight must remain positive');
  assert.ok(weights.description < weights.description_en, 'legacy description weight must be lower than English');
  assert.ok(weights.description < weights.description_zh, 'legacy description weight must be lower than Chinese');
});

test('rating filter exposes only four-stars-and-up, three-stars-and-up, and all', () => {
  const ratingSection = index.match(/<div class="rating-filter" id="rating-filter">([\s\S]*?)<\/div>/);
  assert.ok(ratingSection, 'rating filter markup must exist');
  const ratings = [...ratingSection[1].matchAll(/data-rating="(\d+)"/g)].map((match) => match[1]);

  assert.deepEqual(ratings, ['4', '3', '0']);
});

test('detail markup places English before Simplified Chinese and application assigns text safely', () => {
  const englishLabel = index.indexOf('<div class="description-language">English</div>');
  const englishDescription = index.indexOf('id="modal-description-en"');
  const chineseLabel = index.indexOf('<div class="description-language">中文</div>');
  const chineseDescription = index.indexOf('id="modal-description-zh"');

  assert.notEqual(englishLabel, -1, 'English detail label must exist');
  assert.notEqual(englishDescription, -1, 'English description container must exist');
  assert.notEqual(chineseLabel, -1, 'Chinese detail label must exist');
  assert.notEqual(chineseDescription, -1, 'Chinese description container must exist');
  assert.ok(englishLabel < englishDescription, 'English label must precede its content');
  assert.ok(englishDescription < chineseLabel, 'English detail must precede Chinese detail');
  assert.ok(chineseLabel < chineseDescription, 'Chinese label must precede its content');
  assert.match(css, /\.modal-description\s*\{[^}]*white-space:\s*pre-line/);
  assert.match(app, /\$\('#modal-description-en'\)\.textContent\s*=\s*detailView\.descriptionEn/);
  assert.match(app, /\$\('#modal-description-zh'\)\.textContent\s*=\s*detailView\.descriptionZh/);
});

test('filter and display scripts both load before the application', () => {
  const filtersScript = index.indexOf('src="js/dlc-filters.js"');
  const displayScript = index.indexOf('src="js/dlc-display.js"');
  const appScript = index.indexOf('src="js/app.js"');

  assert.notEqual(filtersScript, -1, 'index.html must load js/dlc-filters.js');
  assert.notEqual(displayScript, -1, 'index.html must load js/dlc-display.js');
  assert.notEqual(appScript, -1, 'index.html must load js/app.js');
  assert.ok(filtersScript < appScript, 'js/dlc-filters.js must load before js/app.js');
  assert.ok(displayScript < appScript, 'js/dlc-display.js must load before js/app.js');
});

test('project collection sidebar loads its dependencies and composes with existing filters', () => {
  for (const id of ['project-collections', 'new-project-btn', 'project-tree', 'include-project-descendants']) {
    assert.match(index, new RegExp(`id="${id}"`), `${id} must exist`);
  }
  const modelScript = index.indexOf('src="js/project-collections.js"');
  const storeScript = index.indexOf('src="js/personal-store.js"');
  const treeScript = index.indexOf('src="js/project-tree-view.js"');
  const appScript = index.indexOf('src="js/app.js"');
  assert.ok(modelScript < storeScript && storeScript < treeScript && treeScript < appScript);
  assert.match(app, /getAssignedAppIds/);
  assert.match(app, /steam_appid/);
  assert.match(app, /includeProjectDescendants/);
  assert.match(app, /window\.dlcFilters\.filterByCategory/);
  assert.match(app, /window\.sortDlcs/);
});

test('project management provides menus, move controls, detail assignment, and batch assignment', () => {
  for (const id of ['project-node-menu', 'move-node-dialog', 'move-node-target', 'delete-node-dialog',
    'modal-project-assign', 'project-picker-overlay', 'project-picker-search', 'project-picker-tree',
    'project-picker-save', 'batch-mode-btn', 'batch-toolbar', 'batch-selected-count',
    'batch-assign-btn', 'batch-cancel-btn']) assert.match(index, new RegExp(`id="${id}"`));
  for (const eventName of ['dragstart', 'dragover', 'drop', 'dragend']) assert.match(app, new RegExp(eventName));
  assert.match(app, /addAssignments/);
  assert.match(app, /setAssignments/);
  assert.match(app, /batch-select-checkbox/);
});
