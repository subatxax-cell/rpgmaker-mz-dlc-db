(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.projectTreeView = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const escapeHtml = value => String(value).replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
  const sortedChildren = (c, parentId) => Object.values(c.nodes).filter(n => n.parentId === parentId).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  function buildTree(collections, counts = {}) {
    const expanded = new Set(collections.expandedNodeIds || []);
    const visit = (parentId, depth) => sortedChildren(collections, parentId).map(node => ({
      ...node, depth, expanded: expanded.has(node.id), directCount: counts[node.id] || 0,
      children: visit(node.id, depth + 1),
    })).map(node => ({ ...node, hasChildren: node.children.length > 0 }));
    return visit(null, 1);
  }
  function flatten(tree) { return tree.flatMap(node => [node, ...flatten(node.children)]); }
  function renderTreeHtml(tree, options = {}) {
    const render = nodes => nodes.map(node => `<div class="project-tree-node${options.activeNodeId === node.id ? ' active' : ''}" role="treeitem" aria-level="${node.depth}" aria-expanded="${node.hasChildren ? node.expanded : false}" data-node-id="${escapeHtml(node.id)}" draggable="true" style="--tree-depth:${Math.min(node.depth, 6)}"><button class="project-tree-main" data-project-select="${escapeHtml(node.id)}">${node.hasChildren ? '<span class="project-tree-arrow">▸</span>' : '<span class="project-tree-spacer"></span>'}<span class="project-tree-icon">${node.type === 'project' ? '📁' : '📂'}</span><span class="project-tree-name">${escapeHtml(node.name)}</span><span class="project-tree-count">${node.directCount}</span></button><button class="project-tree-actions" data-project-menu="${escapeHtml(node.id)}" aria-label="${escapeHtml(node.name)} 操作">⋯</button>${node.expanded ? `<div role="group">${render(node.children)}</div>` : ''}</div>`).join('');
    return render(tree);
  }
  function descendantIds(collections, id) {
    const out = []; const visit = parent => sortedChildren(collections, parent).forEach(n => { out.push(n.id); visit(n.id); }); visit(id); return out;
  }
  function buildMoveTargets(collections, movingNodeId) {
    const moving = collections.nodes[movingNodeId]; if (!moving) return [];
    const excluded = new Set([movingNodeId, moving.parentId, ...descendantIds(collections, movingNodeId)]);
    return flatten(buildTree(collections, {})).filter(n => !excluded.has(n.id)).map(({ id, name, type, depth }) => ({ id, name, type, depth }));
  }
  function renderPickerHtml(tree, selectedNodeIds = [], query = '') {
    const selected = new Set(selectedNodeIds); const needle = query.trim().toLocaleLowerCase();
    const keep = node => !needle || node.name.toLocaleLowerCase().includes(needle) || node.children.some(keep);
    const render = nodes => nodes.filter(keep).map(node => `<div class="project-picker-node" data-picker-node-id="${escapeHtml(node.id)}" style="--tree-depth:${Math.min(node.depth, 6)}"><label><input type="checkbox" value="${escapeHtml(node.id)}"${selected.has(node.id) ? ' checked' : ''}><span>${node.type === 'project' ? '📁' : '📂'} ${escapeHtml(node.name)}</span></label>${render(node.children)}</div>`).join('');
    return render(tree);
  }
  return { buildTree, renderTreeHtml, buildMoveTargets, renderPickerHtml };
});
