# Project Collection Folders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有静态 DLC 数据库上增量增加项目收藏夹、无限层级目录、多目录归类、拖拽移动和批量归类，同时完整保留现有浏览与个人标记功能。

**Architecture:** 保持当前无构建步骤的浏览器脚本架构，新建三个可同时在浏览器和 Node 测试中使用的 UMD 模块：目录模型、版本化个人存储、项目视图辅助。`js/app.js` 继续负责页面状态和事件协调，但所有树结构、迁移和归类算法下沉到独立模块；现有 DLC 数据文件、Steam 媒体逻辑和筛选模块不改写。

**Tech Stack:** 原生 HTML/CSS/JavaScript、浏览器 `localStorage`、Node.js 内置 `node:test`、现有 Fuse.js 与 HLS.js CDN 脚本。

## Global Constraints

- 直接在现有页面和现有数据基础上增量修改，不重新设计或替换已有功能。
- 项目为根节点；文件夹支持无限层级；项目不能成为其他节点的子节点。
- 同一个 DLC 可加入多个项目或文件夹，并以稳定的 `steam_appid` 保存关系。
- 删除节点只删除节点与归类关系，不修改 DLC、“已拥有”“想买”、个人评分和备注。
- 目录筛选必须可与搜索、官方分类、推荐度、价格、个人标记及现有排序组合。
- 默认只显示当前节点直接归类的 DLC；“包含子目录”开启后递归汇总并去重。
- 桌面支持拖拽排序和改变父级；手机和键盘用户可使用“移动到……”完成同等操作。
- 新旧个人数据与导入备份必须兼容；无效导入不得覆盖现有数据。
- 不引入框架、后端、账号、云同步或新的运行时依赖。

---

## File Map

- Create `js/project-collections.js`: 纯目录树与归类模型，包括验证、增删改移、排序、子树查询和 App ID 去重。
- Create `js/personal-store.js`: 版本 2 本地数据文档、旧格式迁移、原子保存、导入验证和导出。
- Create `js/project-tree-view.js`: 无状态 HTML 生成与移动目标列表辅助，供左侧树和选择器复用。
- Create `project-collections.test.js`: 目录模型单元测试。
- Create `personal-store.test.js`: 迁移、导入验证和写入回滚测试。
- Create `project-tree-view.test.js`: 树渲染、层级和安全转义测试。
- Modify `index.html`: 新增项目收藏夹区、批量工具栏、详情归类入口、目录选择器与节点操作对话框，并按依赖顺序加载模块。
- Modify `css/style.css`: 项目树、拖拽状态、批量模式、选择器、对话框和窄屏样式。
- Modify `js/app.js`: 接入版本化存储、项目过滤、树操作、详情归类、批量选择、拖拽和导入导出。
- Modify `ui-contract.test.js`: 固化新增 DOM、模块加载顺序和原功能仍存在的静态契约。

---

### Task 1: Project collection data model

**Files:**
- Create: `js/project-collections.js`
- Create: `project-collections.test.js`

**Interfaces:**
- Produces: `window.projectCollections` and CommonJS export with `createEmptyCollections()`, `validateCollections(value)`, `createNode(collections, input)`, `renameNode(collections, nodeId, name)`, `moveNode(collections, nodeId, targetParentId, targetIndex)`, `deleteNode(collections, nodeId)`, `setAssignments(collections, steamAppId, nodeIds)`, `addAssignments(collections, steamAppIds, nodeIds)`, `getAssignedAppIds(collections, nodeId, includeDescendants)`, `getDescendantIds(collections, nodeId)`.
- All mutators return a new validated object and do not mutate their input; validation failures throw `ProjectCollectionError` with a stable `code`.

- [ ] **Step 1: Write failing creation and validation tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('./js/project-collections.js');

test('creates projects and unlimited nested folders without mutating input', () => {
  const empty = model.createEmptyCollections();
  const withProject = model.createNode(empty, { id: 'p1', type: 'project', name: '勇者物语', parentId: null });
  const withChapter = model.createNode(withProject, { id: 'f1', type: 'folder', name: '序章', parentId: 'p1' });
  const nested = model.createNode(withChapter, { id: 'f2', type: 'folder', name: '村庄', parentId: 'f1' });
  assert.equal(empty.nodes.p1, undefined);
  assert.equal(nested.nodes.f2.parentId, 'f1');
  assert.equal(model.validateCollections(nested).valid, true);
});

test('rejects blank and duplicate sibling names', () => {
  const base = model.createNode(model.createEmptyCollections(), { id: 'p1', type: 'project', name: 'Game', parentId: null });
  const one = model.createNode(base, { id: 'f1', type: 'folder', name: '序章', parentId: 'p1' });
  assert.throws(() => model.createNode(one, { id: 'f2', type: 'folder', name: ' 序章 ', parentId: 'p1' }), { code: 'DUPLICATE_NAME' });
  assert.throws(() => model.renameNode(one, 'f1', '   '), { code: 'INVALID_NAME' });
});
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `node --test project-collections.test.js`

Expected: FAIL because `js/project-collections.js` does not exist.

- [ ] **Step 3: Implement the UMD module and immutable node operations**

Implement normalized names with `name.trim().toLocaleLowerCase()`, stable sibling order normalization, project/folder parent rules, missing-parent checks and full graph cycle validation. Use supplied test IDs when present and `crypto.randomUUID()` with a timestamp/random fallback in the browser.

```js
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.projectCollections = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  class ProjectCollectionError extends Error {
    constructor(code, message) { super(message); this.name = 'ProjectCollectionError'; this.code = code; }
  }
  function createEmptyCollections() { return { nodes: {}, assignments: {}, expandedNodeIds: [] }; }
  // Complete the exported interfaces listed above with cloned inputs and continuous sibling order values.
  return { ProjectCollectionError, createEmptyCollections, validateCollections, createNode, renameNode, moveNode, deleteNode, setAssignments, addAssignments, getAssignedAppIds, getDescendantIds };
});
```

- [ ] **Step 4: Add movement, deletion and assignment tests**

Cover: project cannot move, folder cannot move beneath itself/descendant, same-parent reorder, cross-parent move, recursive delete, multi-node assignment, add-only batch assignment, subtree query and duplicate App ID removal. Assert recursive deletion leaves an unrelated `personalData` fixture byte-for-byte unchanged.

- [ ] **Step 5: Run model tests**

Run: `node --test project-collections.test.js`

Expected: all project collection model tests PASS.

- [ ] **Step 6: Commit the model**

```bash
git add js/project-collections.js project-collections.test.js
git commit -m "feat: add project collection data model"
```

---

### Task 2: Versioned personal storage and safe import/export

**Files:**
- Create: `js/personal-store.js`
- Create: `personal-store.test.js`

**Interfaces:**
- Consumes: `projectCollections.createEmptyCollections()` and `projectCollections.validateCollections()`.
- Produces: `createEmptyDocument()`, `migrateStoredValue(rawValue)`, `validateDocument(value)`, `load(storage, key)`, `save(storage, key, document)`, `parseImport(jsonText)`, `serializeExport(document, now)`.
- Canonical key remains `rpgmz-dlc-personal`; `load` accepts both the old plain personal map and version 2 document.

- [ ] **Step 1: Write failing migration tests**

```js
test('migrates the legacy personal map without changing marks', () => {
  const legacy = { 'dlc-1': { owned: true, wanted: false, rating: 4, notes: '主角用' } };
  const result = store.migrateStoredValue(legacy);
  assert.equal(result.version, 2);
  assert.deepEqual(result.personalData, legacy);
  assert.deepEqual(result.projectCollections, model.createEmptyCollections());
});

test('accepts old exported backups containing personalData', () => {
  const result = store.parseImport(JSON.stringify({ exportDate: '2026-01-01', personalData: { x: { wanted: true } } }));
  assert.equal(result.version, 2);
  assert.equal(result.personalData.x.wanted, true);
});
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `node --test personal-store.test.js`

Expected: FAIL because the storage module does not exist.

- [ ] **Step 3: Implement migration, validation and deterministic export**

Validate version `2`, plain-object personal records, node graph integrity, assignment target existence and numeric-string Steam App IDs. Preserve assignments for App IDs not present in the current catalog. `serializeExport` must output `{ version, exportDate, personalData, projectCollections }`.

- [ ] **Step 4: Add atomic failure tests**

Use an in-memory storage double and a throwing storage double. Assert `save` restores the previous serialized value after a failed write when restoration is possible, and returns `{ ok: false, error }`; assert malformed JSON, cycles and missing assignment targets are rejected without invoking `setItem`.

- [ ] **Step 5: Run storage tests**

Run: `node --test personal-store.test.js project-collections.test.js`

Expected: all tests PASS.

- [ ] **Step 6: Commit storage support**

```bash
git add js/personal-store.js personal-store.test.js
git commit -m "feat: add versioned personal data storage"
```

---

### Task 3: Reusable project tree presentation helpers

**Files:**
- Create: `js/project-tree-view.js`
- Create: `project-tree-view.test.js`

**Interfaces:**
- Consumes: validated collection objects from `project-collections.js`.
- Produces: `buildTree(collections, counts)`, `renderTreeHtml(tree, options)`, `buildMoveTargets(collections, movingNodeId)`, `renderPickerHtml(tree, selectedNodeIds, query)`.
- Returned tree rows include `id`, `name`, `type`, `depth`, `order`, `expanded`, `hasChildren`, `directCount`.

- [ ] **Step 1: Write failing tree and escaping tests**

```js
test('renders unlimited depth with data attributes and escaped names', () => {
  const tree = view.buildTree(collectionsFixture, { p1: 2, f1: 1 });
  const html = view.renderTreeHtml(tree, { activeNodeId: 'f1' });
  assert.match(html, /data-node-id="f1"/);
  assert.match(html, /aria-level="2"/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('excludes a moving folder and its descendants from move targets', () => {
  assert.deepEqual(view.buildMoveTargets(collectionsFixture, 'f1').map(x => x.id), ['p2']);
});
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `node --test project-tree-view.test.js`

Expected: FAIL because the view helper does not exist.

- [ ] **Step 3: Implement pure tree builders and HTML renderers**

Render semantic buttons with `aria-expanded`, `aria-level`, `draggable="true"`, `data-node-id`, a capped CSS depth variable `--tree-depth: min(depth, 6)`, direct count, and a separate `⋯` action button. Picker results retain ancestors when a descendant matches the search.

- [ ] **Step 4: Run helper tests**

Run: `node --test project-tree-view.test.js`

Expected: all helper tests PASS.

- [ ] **Step 5: Commit tree helpers**

```bash
git add js/project-tree-view.js project-tree-view.test.js
git commit -m "feat: add project tree view helpers"
```

---

### Task 4: Sidebar tree and project filtering integration

**Files:**
- Modify: `index.html`
- Modify: `css/style.css`
- Modify: `js/app.js`
- Modify: `ui-contract.test.js`

**Interfaces:**
- Consumes: all APIs from Tasks 1–3.
- Adds state: `personalDocument`, `activeProjectNodeId`, `includeProjectDescendants`, `projectMenuNodeId`.
- Adds app functions: `renderProjectTree()`, `createProject()`, `createFolder(parentId)`, `renameProjectNode(nodeId)`, `deleteProjectNode(nodeId)`, `moveProjectNode(nodeId, parentId, index)`, `applyProjectFilter(dlcs)`.

- [ ] **Step 1: Extend static UI contract tests before markup changes**

Assert `index.html` contains `#project-collections`, `#new-project-btn`, `#project-tree`, `#include-project-descendants`; scripts load in this order: `project-collections.js`, `personal-store.js`, `project-tree-view.js`, `app.js`. Keep existing assertions for filters, bilingual description, media and personal controls.

- [ ] **Step 2: Run contract tests and confirm failure**

Run: `node --test ui-contract.test.js`

Expected: FAIL for the missing project UI and scripts.

- [ ] **Step 3: Add sidebar markup and styles**

Place “📁 项目收藏夹” as a new top-level sidebar section alongside official categories, with a visible `＋ 新建项目` button, tree container and “包含子目录” checkbox. Add active, hover, focus, collapsed, drop-before, drop-inside and invalid-drop states. Keep the existing sidebar width and scrolling behavior.

- [ ] **Step 4: Replace direct personal storage calls with the versioned adapter**

On startup call `personalStore.load(localStorage, 'rpgmz-dlc-personal')`, assign `state.personalDocument`, and keep `state.personalData` referencing `state.personalDocument.personalData` so existing `getPersonal` and `setPersonal` behavior remains unchanged. All saves write the full version 2 document and show a toast on failure.

- [ ] **Step 5: Integrate project tree CRUD and filtering**

Use small prompt/confirm dialogs for the first functional increment. Apply `applyProjectFilter` after search and official category filtering but before existing personal/price filters and sorting. Use `steam_appid` converted to `String`; if active node disappears after deletion, set it to `null` and show all DLC.

- [ ] **Step 6: Add app integration assertions**

In `ui-contract.test.js`, assert the app calls `getAssignedAppIds`, references `steam_appid`, keeps `window.dlcFilters.filterByCategory`, keeps `window.sortDlcs`, and exposes the direct/descendant toggle listener.

- [ ] **Step 7: Run regression tests**

Run: `node --test *.test.js`

Expected: all existing and new tests PASS.

- [ ] **Step 8: Commit sidebar integration**

```bash
git add index.html css/style.css js/app.js ui-contract.test.js
git commit -m "feat: add project collection sidebar"
```

---

### Task 5: Node menus, drag-and-drop and accessible move dialog

**Files:**
- Modify: `index.html`
- Modify: `css/style.css`
- Modify: `js/app.js`
- Modify: `ui-contract.test.js`

**Interfaces:**
- Consumes: `moveNode`, `buildMoveTargets`, and sidebar tree rows.
- Adds app functions: `openProjectNodeMenu(nodeId, anchor)`, `openMoveNodeDialog(nodeId)`, `commitNodeMove(nodeId, parentId, index)`, `describeDeleteImpact(nodeId)`.

- [ ] **Step 1: Add failing menu/dialog contract assertions**

Require `#project-node-menu`, `#move-node-dialog`, `#move-node-target`, `#delete-node-dialog` and accessible labels. Require drag event names `dragstart`, `dragover`, `drop`, `dragend` in `js/app.js`.

- [ ] **Step 2: Run contract tests and confirm failure**

Run: `node --test ui-contract.test.js`

Expected: FAIL for missing menu, dialog and drag handlers.

- [ ] **Step 3: Implement contextual actions and delete impact confirmation**

The `⋯` menu exposes new child folder, rename, move and delete; project roots omit move. Deletion text includes descendant node count and unique removed assignment count and explicitly says “DLC、已拥有、想买、评分和备注不会被删除”.

- [ ] **Step 4: Implement drag reorder and reparent**

Use delegated HTML5 drag events on `#project-tree`. Divide a row into top 25% (before), middle 50% (inside for folders/projects), bottom 25% (after). Validate through `moveNode` before saving; rejected operations show a toast and leave DOM/state unchanged. Re-render from saved state after every successful drop.

- [ ] **Step 5: Implement keyboard/mobile move alternative**

Populate `#move-node-target` from `buildMoveTargets`; include “项目根目录” as a target only for folders and a sibling-position select. Escape closes the topmost project dialog before the DLC detail modal. Focus returns to the originating action button.

- [ ] **Step 6: Run all tests and perform syntax check**

Run: `node --check js/app.js && node --test *.test.js`

Expected: syntax check exits 0 and all tests PASS.

- [ ] **Step 7: Commit node interactions**

```bash
git add index.html css/style.css js/app.js ui-contract.test.js
git commit -m "feat: add project folder move and delete controls"
```

---

### Task 6: Detail multi-folder assignment picker

**Files:**
- Modify: `index.html`
- Modify: `css/style.css`
- Modify: `js/app.js`
- Modify: `ui-contract.test.js`

**Interfaces:**
- Consumes: `setAssignments`, `buildTree`, `renderPickerHtml`.
- Adds app functions: `openProjectPicker(options)`, `renderProjectPicker()`, `saveCurrentDlcAssignments()`.
- `openProjectPicker` receives `{ mode: 'replace', steamAppIds: string[], initialNodeIds: string[] }` for detail editing.

- [ ] **Step 1: Add failing picker contract assertions**

Require `#modal-project-assign`, `#project-picker-overlay`, `#project-picker-search`, `#project-picker-tree`, `#project-picker-save`, checkbox markup and both “加入项目目录” and “保存归类” copy.

- [ ] **Step 2: Run contract tests and confirm failure**

Run: `node --test ui-contract.test.js`

Expected: FAIL for missing picker controls.

- [ ] **Step 3: Add picker markup and responsive styles**

Add the detail button inside `.modal-personal`. The picker is a modal sheet on narrow screens and centered dialog on desktop, with a sticky search field/footer, scrollable tree, visible selected count, focus outline and dark theme variables.

- [ ] **Step 4: Implement detail assignment flow**

When detail opens, display the current assignment count. The picker checks all existing memberships for the current DLC App ID. Search filters by node name while retaining ancestors. Save calls `setAssignments` in replace mode, persists once, refreshes tree counts and detail count, and leaves owned/wanted/rating/notes untouched.

- [ ] **Step 5: Run all tests**

Run: `node --check js/app.js && node --test *.test.js`

Expected: all tests PASS.

- [ ] **Step 6: Commit detail assignment**

```bash
git add index.html css/style.css js/app.js ui-contract.test.js
git commit -m "feat: assign DLCs from detail view"
```

---

### Task 7: Card/table batch selection and add-only assignment

**Files:**
- Modify: `index.html`
- Modify: `css/style.css`
- Modify: `js/app.js`
- Modify: `ui-contract.test.js`

**Interfaces:**
- Consumes: `addAssignments` and the picker from Task 6.
- Adds state: `batchMode`, `selectedDlcIds` as a `Set`.
- Adds app functions: `enterBatchMode()`, `toggleBatchDlc(dlcId)`, `renderBatchToolbar()`, `openBatchProjectPicker()`, `exitBatchMode()`.

- [ ] **Step 1: Add failing batch-mode contract tests**

Require `#batch-mode-btn`, `#batch-toolbar`, `#batch-selected-count`, `#batch-assign-btn`, `#batch-cancel-btn`, `.batch-select-checkbox` in both card and table render paths, and an `addAssignments` call.

- [ ] **Step 2: Run contract tests and confirm failure**

Run: `node --test ui-contract.test.js`

Expected: FAIL for missing batch UI.

- [ ] **Step 3: Add batch toolbar and selection styles**

Place “批量选择” in the top bar. In batch mode, cards and rows display checkboxes and selected outlines; the sticky toolbar reports `已选择 N 项`. On narrow screens the toolbar buttons wrap without covering result content.

- [ ] **Step 4: Implement selection without opening details**

Replace inline card/row behavior with event delegation so normal mode still opens detail and batch mode toggles selection. Re-rendering after filters retains selected DLC IDs even when some are temporarily hidden; cancel clears the set.

- [ ] **Step 5: Implement add-only batch assignment**

Open the existing picker in `{ mode: 'add' }`; saving calls `addAssignments` for selected DLC Steam App IDs. It must never remove any existing membership. Show a summary toast and exit batch mode after a successful single save.

- [ ] **Step 6: Run all tests and syntax checks**

Run: `node --check js/app.js && node --test *.test.js`

Expected: all tests PASS.

- [ ] **Step 7: Commit batch assignment**

```bash
git add index.html css/style.css js/app.js ui-contract.test.js
git commit -m "feat: add batch project assignment"
```

---

### Task 8: Import/export integration and full regression verification

**Files:**
- Modify: `js/app.js`
- Modify: `ui-contract.test.js`
- Modify: `README.md`

**Interfaces:**
- Consumes: `personalStore.parseImport`, `personalStore.serializeExport`, and complete project UI.
- Existing import/export buttons retain their IDs and user workflow.

- [ ] **Step 1: Add failing import/export integration assertions**

Assert `exportData()` invokes `serializeExport`; the import reader invokes `parseImport`; imported state refreshes `state.personalData`, project tree and current filters; no direct assignment from unvalidated `data.personalData` remains.

- [ ] **Step 2: Run contract tests and confirm failure**

Run: `node --test ui-contract.test.js`

Expected: FAIL until the old direct import/export path is replaced.

- [ ] **Step 3: Integrate validated import and complete export**

Export the full version 2 document with date. Import parses and validates entirely in memory, asks for confirmation, saves once, then swaps state and re-renders. Old `{ personalData }` backups migrate to an empty project tree. Failure displays the validation message and preserves current memory/localStorage.

- [ ] **Step 4: Document local-only project data and backup format**

Add a README section explaining that project folders are stored only in the current browser, export includes project folders and memberships, import accepts old backups, and deleting a folder does not delete DLC or personal marks. Do not change the existing feature descriptions or deployment instructions.

- [ ] **Step 5: Run the full automated suite**

Run: `node --check js/project-collections.js && node --check js/personal-store.js && node --check js/project-tree-view.js && node --check js/app.js && node --test *.test.js`

Expected: every syntax check exits 0 and every test passes with zero failures.

- [ ] **Step 6: Run desktop and narrow-screen smoke tests**

Serve with `python3 -m http.server 8000`, then verify at desktop and 390px width:

1. Existing search, category, rating, price, owned/wanted, sort, card/table, dark mode, detail media and bilingual text still work.
2. Create two projects, nest at least three folder levels, rename and reorder them.
3. Assign one DLC to multiple folders from detail; confirm direct and recursive filters.
4. Batch-add several DLCs in both card and table views; confirm previous memberships remain.
5. Move a folder by drag and by dialog; reject a cycle.
6. Delete a parent folder; confirm DLC and all personal marks remain.
7. Export, clear browser data in a disposable profile, import, and confirm exact round trip.

- [ ] **Step 7: Inspect the final diff for unintended data/media changes**

Run: `git diff --stat HEAD~7..HEAD && git status --short`

Expected: only planned JS, HTML, CSS, tests and README documentation changed; `data/`, Steam URLs and media catalogs remain untouched.

- [ ] **Step 8: Commit final integration and documentation**

```bash
git add js/app.js ui-contract.test.js README.md
git commit -m "feat: complete project collection workflow"
```

---

## Final Acceptance

- [ ] Run `node --test *.test.js` with zero failures.
- [ ] Run `node --check` on every changed JavaScript file with zero syntax errors.
- [ ] Confirm no DLC catalog, Steam link, image or video data changed.
- [ ] Confirm legacy personal marks survive automatic migration and old backup import.
- [ ] Confirm project/folder deletion never changes owned, wanted, rating or notes.
- [ ] Confirm all existing filters and both display modes compose with the selected project node.
- [ ] Confirm desktop drag operations and mobile/keyboard move dialog are equivalent.
- [ ] Confirm `.superpowers/` remains excluded from Git and only `docs/superpowers/specs` plus `docs/superpowers/plans` are force-added when documentation commits are desired.
