(function (root, factory) {
  const model = root?.projectCollections || (typeof require === 'function' ? require('./project-collections.js') : null);
  const api = factory(model);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.personalStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (model) {
  class PersonalStoreError extends Error {
    constructor(code, message) { super(message); this.name = 'PersonalStoreError'; this.code = code; }
  }
  const fail = (code, message) => { throw new PersonalStoreError(code, message); };
  const clone = value => JSON.parse(JSON.stringify(value));
  function createEmptyDocument() { return { version: 2, personalData: {}, projectCollections: model.createEmptyCollections() }; }
  function migrateStoredValue(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return createEmptyDocument();
    if (value.version === 2) return clone(value);
    if (value.personalData && typeof value.personalData === 'object') return { version: 2, personalData: clone(value.personalData), projectCollections: model.createEmptyCollections() };
    return { version: 2, personalData: clone(value), projectCollections: model.createEmptyCollections() };
  }
  function validateDocument(value) {
    if (!value || value.version !== 2) fail('INVALID_VERSION', '不支持的个人数据版本');
    if (!value.personalData || typeof value.personalData !== 'object' || Array.isArray(value.personalData)) fail('INVALID_PERSONAL_DATA', '个人标记数据无效');
    try { model.validateCollections(value.projectCollections); } catch (error) { fail(error.code || 'INVALID_COLLECTIONS', error.message); }
    for (const appId of Object.keys(value.projectCollections.assignments)) if (!/^\d+$/.test(appId)) fail('INVALID_APP_ID', `Steam App ID 无效: ${appId}`);
    return { valid: true };
  }
  function load(storage, key) {
    const raw = storage.getItem(key); if (!raw) return { document: createEmptyDocument(), error: null };
    try { const document = migrateStoredValue(JSON.parse(raw)); validateDocument(document); return { document, error: null }; }
    catch (error) { return { document: createEmptyDocument(), error }; }
  }
  function save(storage, key, document) {
    try { validateDocument(document); storage.setItem(key, JSON.stringify(document)); return { ok: true }; }
    catch (error) { return { ok: false, error }; }
  }
  function parseImport(text) {
    let value; try { value = JSON.parse(text); } catch { fail('INVALID_JSON', 'JSON 文件无法解析'); }
    const document = migrateStoredValue(value); validateDocument(document); return document;
  }
  function serializeExport(document, now = () => new Date().toISOString()) {
    validateDocument(document);
    return JSON.stringify({ version: 2, exportDate: now(), personalData: document.personalData, projectCollections: document.projectCollections }, null, 2);
  }
  return { PersonalStoreError, createEmptyDocument, migrateStoredValue, validateDocument, load, save, parseImport, serializeExport };
});
