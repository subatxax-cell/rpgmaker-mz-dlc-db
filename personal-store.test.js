const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('./js/project-collections.js');
const store = require('./js/personal-store.js');

test('migrates legacy marks unchanged', () => {
  const legacy = { x: { owned: true, wanted: false, rating: 4, notes: '主角用' } };
  const result = store.migrateStoredValue(legacy);
  assert.equal(result.version, 2);
  assert.deepEqual(result.personalData, legacy);
  assert.deepEqual(result.projectCollections, model.createEmptyCollections());
});

test('accepts old export and validates version two export', () => {
  const old = store.parseImport(JSON.stringify({ exportDate: 'x', personalData: { x: { wanted: true } } }));
  assert.equal(old.personalData.x.wanted, true);
  assert.equal(store.validateDocument(old).valid, true);
});

test('rejects malformed imports and invalid assignment targets', () => {
  assert.throws(() => store.parseImport('{bad'), { code: 'INVALID_JSON' });
  const doc = store.createEmptyDocument(); doc.projectCollections.assignments['123'] = ['missing'];
  assert.throws(() => store.validateDocument(doc));
});

test('save reports write failure without changing the document', () => {
  const storage = { getItem: () => 'old', setItem: () => { throw new Error('quota'); } };
  const doc = store.createEmptyDocument();
  const result = store.save(storage, 'key', doc);
  assert.equal(result.ok, false);
  assert.equal(doc.version, 2);
});

test('exports the complete versioned document', () => {
  const text = store.serializeExport(store.createEmptyDocument(), () => '2026-08-11T00:00:00.000Z');
  const value = JSON.parse(text);
  assert.deepEqual(Object.keys(value), ['version', 'exportDate', 'personalData', 'projectCollections']);
});
