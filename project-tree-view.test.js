const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('./js/project-collections.js');
const view = require('./js/project-tree-view.js');

function fixture() {
  let c = model.createEmptyCollections();
  c = model.createNode(c, { id: 'p1', type: 'project', name: '<script>', parentId: null });
  c = model.createNode(c, { id: 'f1', type: 'folder', name: '序章', parentId: 'p1' });
  c = model.createNode(c, { id: 'f2', type: 'folder', name: '村庄', parentId: 'f1' });
  c = model.createNode(c, { id: 'p2', type: 'project', name: '第二项目', parentId: null });
  c.expandedNodeIds = ['p1', 'f1'];
  return c;
}

test('builds and safely renders an accessible nested tree', () => {
  const html = view.renderTreeHtml(view.buildTree(fixture(), { p1: 2 }), { activeNodeId: 'f1' });
  assert.match(html, /data-node-id="f1"/);
  assert.match(html, /aria-level="2"/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test('move targets exclude a node and all descendants', () => {
  assert.deepEqual(view.buildMoveTargets(fixture(), 'f1').map(x => x.id), ['p2']);
});

test('picker search retains ancestors of matching folders', () => {
  const tree = view.buildTree(fixture(), {});
  const html = view.renderPickerHtml(tree, ['f2'], '村庄');
  assert.match(html, /data-picker-node-id="p1"/);
  assert.match(html, /data-picker-node-id="f2"/);
  assert.match(html, /checked/);
});
