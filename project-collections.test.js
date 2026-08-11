const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('./js/project-collections.js');

function fixture() {
  let c = model.createEmptyCollections();
  c = model.createNode(c, { id: 'p1', type: 'project', name: '勇者物语', parentId: null });
  c = model.createNode(c, { id: 'f1', type: 'folder', name: '序章', parentId: 'p1' });
  c = model.createNode(c, { id: 'f2', type: 'folder', name: '村庄', parentId: 'f1' });
  c = model.createNode(c, { id: 'p2', type: 'project', name: '第二项目', parentId: null });
  return c;
}

test('creates unlimited nested folders without mutating input', () => {
  const empty = model.createEmptyCollections();
  const nested = fixture();
  assert.equal(empty.nodes.p1, undefined);
  assert.equal(nested.nodes.f2.parentId, 'f1');
  assert.equal(model.validateCollections(nested).valid, true);
});

test('rejects blank and duplicate sibling names', () => {
  const c = fixture();
  assert.throws(() => model.createNode(c, { id: 'f3', type: 'folder', name: ' 序章 ', parentId: 'p1' }), { code: 'DUPLICATE_NAME' });
  assert.throws(() => model.renameNode(c, 'f1', '   '), { code: 'INVALID_NAME' });
});

test('rejects illegal moves and supports reparenting', () => {
  const c = fixture();
  assert.throws(() => model.moveNode(c, 'p1', 'p2', 0), { code: 'PROJECT_MOVE' });
  assert.throws(() => model.moveNode(c, 'f1', 'f2', 0), { code: 'CYCLE' });
  const moved = model.moveNode(c, 'f2', 'p2', 0);
  assert.equal(moved.nodes.f2.parentId, 'p2');
  assert.equal(c.nodes.f2.parentId, 'f1');
});

test('assigns one DLC to many nodes and recursively deduplicates results', () => {
  let c = fixture();
  c = model.setAssignments(c, '123', ['p1', 'f1', 'f1']);
  c = model.addAssignments(c, ['123', '456'], ['f2']);
  assert.deepEqual(c.assignments['123'], ['p1', 'f1', 'f2']);
  assert.deepEqual(model.getAssignedAppIds(c, 'p1', true), ['123', '456']);
  assert.deepEqual(model.getAssignedAppIds(c, 'p1', false), ['123']);
});

test('recursive deletion removes only affected nodes and assignments', () => {
  let c = fixture();
  c = model.setAssignments(c, '123', ['f1', 'p2']);
  const deleted = model.deleteNode(c, 'f1');
  assert.equal(deleted.nodes.f1, undefined);
  assert.equal(deleted.nodes.f2, undefined);
  assert.deepEqual(deleted.assignments['123'], ['p2']);
  assert.ok(deleted.nodes.p1);
});
