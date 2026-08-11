(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.projectCollections = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  class ProjectCollectionError extends Error {
    constructor(code, message) { super(message); this.name = 'ProjectCollectionError'; this.code = code; }
  }
  const fail = (code, message) => { throw new ProjectCollectionError(code, message); };
  const clone = value => JSON.parse(JSON.stringify(value));
  const normalizedName = value => String(value ?? '').trim().toLocaleLowerCase();
  const newId = () => globalThis.crypto?.randomUUID?.() || `node-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  function createEmptyCollections() { return { nodes: {}, assignments: {}, expandedNodeIds: [] }; }
  function childrenOf(c, parentId) {
    return Object.values(c.nodes).filter(n => n.parentId === parentId).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  }
  function validateCollections(value) {
    if (!value || typeof value !== 'object' || !value.nodes || !value.assignments) fail('INVALID_COLLECTIONS', '项目收藏夹数据无效');
    for (const [id, node] of Object.entries(value.nodes)) {
      if (node.id !== id || !['project', 'folder'].includes(node.type)) fail('INVALID_NODE', `无效节点: ${id}`);
      if (!normalizedName(node.name)) fail('INVALID_NAME', '名称不能为空');
      if (node.type === 'project' && node.parentId !== null) fail('INVALID_PARENT', '项目必须位于根级');
      if (node.type === 'folder' && !value.nodes[node.parentId]) fail('MISSING_PARENT', `缺少父节点: ${id}`);
      const seen = new Set([id]); let cursor = node;
      while (cursor.parentId !== null) {
        if (seen.has(cursor.parentId)) fail('CYCLE', '目录不能形成循环');
        seen.add(cursor.parentId); cursor = value.nodes[cursor.parentId];
        if (!cursor) fail('MISSING_PARENT', `缺少父节点: ${id}`);
      }
    }
    const groups = new Map();
    for (const node of Object.values(value.nodes)) {
      const key = String(node.parentId); const names = groups.get(key) || new Set(); const name = normalizedName(node.name);
      if (names.has(name)) fail('DUPLICATE_NAME', '同一目录下名称不能重复');
      names.add(name); groups.set(key, names);
    }
    for (const ids of Object.values(value.assignments)) for (const id of ids) if (!value.nodes[id]) fail('INVALID_ASSIGNMENT', `归类目标不存在: ${id}`);
    return { valid: true };
  }
  function normalizeOrders(c) {
    const parents = new Set(Object.values(c.nodes).map(n => n.parentId));
    for (const parent of parents) childrenOf(c, parent).forEach((node, index) => { c.nodes[node.id].order = index; });
    return c;
  }
  function assertUnique(c, parentId, name, exceptId) {
    if (childrenOf(c, parentId).some(n => n.id !== exceptId && normalizedName(n.name) === normalizedName(name))) fail('DUPLICATE_NAME', '同一目录下名称不能重复');
  }
  function createNode(collections, input) {
    const c = clone(collections); const name = String(input.name ?? '').trim();
    if (!name) fail('INVALID_NAME', '名称不能为空');
    if (!['project', 'folder'].includes(input.type)) fail('INVALID_NODE', '节点类型无效');
    if (input.type === 'project' && input.parentId !== null) fail('INVALID_PARENT', '项目必须位于根级');
    if (input.type === 'folder' && !c.nodes[input.parentId]) fail('MISSING_PARENT', '父节点不存在');
    assertUnique(c, input.parentId, name);
    const id = input.id || newId(); if (c.nodes[id]) fail('DUPLICATE_ID', '节点 ID 已存在');
    const now = new Date().toISOString();
    c.nodes[id] = { id, type: input.type, name, parentId: input.parentId, order: childrenOf(c, input.parentId).length, createdAt: input.createdAt || now, updatedAt: now };
    validateCollections(c); return c;
  }
  function renameNode(collections, nodeId, nameValue) {
    const c = clone(collections); const node = c.nodes[nodeId]; if (!node) fail('NOT_FOUND', '节点不存在');
    const name = String(nameValue ?? '').trim(); if (!name) fail('INVALID_NAME', '名称不能为空');
    assertUnique(c, node.parentId, name, nodeId); node.name = name; node.updatedAt = new Date().toISOString(); validateCollections(c); return c;
  }
  function getDescendantIds(c, nodeId) {
    const result = []; const visit = id => childrenOf(c, id).forEach(n => { result.push(n.id); visit(n.id); }); visit(nodeId); return result;
  }
  function moveNode(collections, nodeId, targetParentId, targetIndex) {
    const c = clone(collections); const node = c.nodes[nodeId]; if (!node) fail('NOT_FOUND', '节点不存在');
    if (node.type === 'project') fail('PROJECT_MOVE', '项目不能移入其他目录');
    if (!c.nodes[targetParentId]) fail('MISSING_PARENT', '目标目录不存在');
    if (nodeId === targetParentId || getDescendantIds(c, nodeId).includes(targetParentId)) fail('CYCLE', '不能移动到自身或后代');
    assertUnique(c, targetParentId, node.name, nodeId); node.parentId = targetParentId;
    const siblings = childrenOf(c, targetParentId).filter(n => n.id !== nodeId); siblings.splice(Math.max(0, Math.min(Number(targetIndex) || 0, siblings.length)), 0, node);
    siblings.forEach((n, i) => { c.nodes[n.id].order = i; }); node.updatedAt = new Date().toISOString(); normalizeOrders(c); validateCollections(c); return c;
  }
  function deleteNode(collections, nodeId) {
    const c = clone(collections); if (!c.nodes[nodeId]) fail('NOT_FOUND', '节点不存在');
    const removed = new Set([nodeId, ...getDescendantIds(c, nodeId)]); removed.forEach(id => delete c.nodes[id]);
    for (const appId of Object.keys(c.assignments)) { c.assignments[appId] = c.assignments[appId].filter(id => !removed.has(id)); if (!c.assignments[appId].length) delete c.assignments[appId]; }
    c.expandedNodeIds = (c.expandedNodeIds || []).filter(id => !removed.has(id)); normalizeOrders(c); validateCollections(c); return c;
  }
  function setAssignments(collections, steamAppId, nodeIds) {
    const c = clone(collections); const appId = String(steamAppId); const ids = [...new Set(nodeIds)];
    ids.forEach(id => { if (!c.nodes[id]) fail('INVALID_ASSIGNMENT', '归类目标不存在'); });
    if (ids.length) c.assignments[appId] = ids; else delete c.assignments[appId]; validateCollections(c); return c;
  }
  function addAssignments(collections, steamAppIds, nodeIds) {
    return steamAppIds.reduce((c, appId) => setAssignments(c, appId, [...(c.assignments[String(appId)] || []), ...nodeIds]), collections);
  }
  function getAssignedAppIds(c, nodeId, includeDescendants) {
    const targets = new Set([nodeId, ...(includeDescendants ? getDescendantIds(c, nodeId) : [])]);
    return Object.keys(c.assignments).filter(appId => c.assignments[appId].some(id => targets.has(id))).sort();
  }
  return { ProjectCollectionError, createEmptyCollections, validateCollections, createNode, renameNode, moveNode, deleteNode, setAssignments, addAssignments, getAssignedAppIds, getDescendantIds };
});
