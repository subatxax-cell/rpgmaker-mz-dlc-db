# README v1.1.0 Screenshot Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用当前 v1.1.0 真实界面截图和双语功能说明替换 GitHub 首页的旧内容，同时将宣传片区域留空供用户手动上传。

**Architecture:** 使用本地 HTTP 页面和浏览器控制生成可复现的演示状态，按固定视口截取真实 UI；旧功能图片覆盖原文件名，新功能使用三个新增文件名。README 只引用仓库内 PNG，不引用视频或用户附件。

**Tech Stack:** 原生静态站点、Codex 内置浏览器、PNG、Markdown、Node.js `node:test`、GitHub Pages。

## Global Constraints

- 中文 `README.md` 与英文 `README_EN.md` 同步更新。
- 视频区域渲染为空，仅保留 HTML 注释占位；不删除本地视频文件。
- 不修改 DLC 数据、应用功能、Steam 链接或个人数据结构。
- 截图不得包含账号、令牌、私人备注或其他敏感信息。
- 旧功能截图覆盖原文件名；新增 `project-tree.png`、`project-picker.png`、`batch-assign.png`。
- 本次发布版本为 `v1.1.1`，只描述 README 和截图修订，不宣称新增应用功能。

---

### Task 1: Add README media contract tests

**Files:**
- Create: `readme-media.test.js`

**Interfaces:**
- Consumes: `README.md`, `README_EN.md`, and files under `docs/media/`.
- Produces: automated contract that checks image existence, PNG signatures, bilingual screenshot parity, required v1.1 content, and absence of video references.

- [ ] **Step 1: Write the failing README media tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const zh = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const en = fs.readFileSync(path.join(root, 'README_EN.md'), 'utf8');
const required = ['project-tree.png', 'project-picker.png', 'batch-assign.png'];

test('both READMEs describe v1.1 project collections and use the same PNGs', () => {
  for (const name of required) {
    assert.match(zh, new RegExp(`docs/media/${name}`));
    assert.match(en, new RegExp(`docs/media/${name}`));
  }
  assert.match(zh, /无限层级/);
  assert.match(en, /unlimited nested folders/i);
});

test('README media references exist and videos are left blank', () => {
  for (const readme of [zh, en]) {
    assert.doesNotMatch(readme, /user-attachments|promo\.(?:mp4|webm)|promo-poster/);
    for (const [, relative] of readme.matchAll(/<img[^>]+src="([^"]+)"/g)) {
      const bytes = fs.readFileSync(path.join(root, relative));
      assert.deepEqual([...bytes.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
    }
  }
});
```

- [ ] **Step 2: Verify the tests fail for the current README and missing images**

Run: `node --test readme-media.test.js`

Expected: FAIL because the three v1.1 screenshots are missing and both READMEs still reference old video content.

- [ ] **Step 3: Commit the failing contract test**

```bash
git add readme-media.test.js
git commit -m "test: define README v1.1 media contract"
```

---

### Task 2: Capture the current v1.1 interface

**Files:**
- Replace: `docs/media/hero-light.png`
- Replace: `docs/media/hero-dark.png`
- Replace: `docs/media/filters-sidebar.png`
- Replace: `docs/media/search-filter.png`
- Replace: `docs/media/table-view.png`
- Replace: `docs/media/detail-meta.png`
- Replace: `docs/media/detail-score-source.png`
- Replace: `docs/media/detail-bilingual.png`
- Replace: `docs/media/detail-tags.png`
- Replace: `docs/media/detail-personal.png`
- Replace: `docs/media/detail-steam-link.png`
- Create: `docs/media/project-tree.png`
- Create: `docs/media/project-picker.png`
- Create: `docs/media/batch-assign.png`

**Interfaces:**
- Consumes: current local site served from `http://127.0.0.1:8765/`.
- Produces: fourteen PNG assets referenced by both README files.

- [ ] **Step 1: Start the local server and establish clean demo data**

Run: `python3 -m http.server 8765`

In the browser, use only demonstration names: project `勇者物语`, folders `序章`, `第一章`, `第二章`; do not enter personal notes. Create assignments for representative high-ranked DLCs so direct counts and recursive filtering are visible.

- [ ] **Step 2: Capture the five browsing screenshots**

At a 1440×1000 viewport capture full or clipped UI states:

- `hero-light.png`: card view, light theme, expanded project tree.
- `hero-dark.png`: same data in dark theme.
- `filters-sidebar.png`: crop the complete left sidebar with project tree and official filters.
- `search-filter.png`: search for `fantasy` with a visible result count and recommendation-high-first sorting.
- `table-view.png`: table view with the batch button visible.

- [ ] **Step 3: Capture the six detail screenshots**

Open one DLC with complete media, bilingual descriptions, tags and Steam link. Capture stable clips for metadata, recommendation source, bilingual description, tags, personal area, and Steam link using the existing filenames.

- [ ] **Step 4: Capture the three v1.1 feature screenshots**

- `project-tree.png`: expanded `勇者物语` tree with three chapter folders and counts.
- `project-picker.png`: detail picker open with multiple checked directories.
- `batch-assign.png`: batch mode with at least two selected DLC cards and the assignment toolbar.

- [ ] **Step 5: Validate image files**

Run: `file docs/media/*.png`

Expected: every listed asset reports PNG image data and no asset is zero bytes.

- [ ] **Step 6: Commit screenshots**

```bash
git add docs/media/*.png
git commit -m "docs: refresh v1.1 interface screenshots"
```

---

### Task 3: Rewrite the bilingual GitHub introduction

**Files:**
- Modify: `README.md`
- Modify: `README_EN.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: screenshot names from Task 2.
- Produces: matching Chinese and English documentation with no video references.

- [ ] **Step 1: Replace both video blocks with invisible placeholders**

Use exactly these comments below the headings:

```html
<!-- 宣传片：在 GitHub 网页编辑器中拖拽上传后，把视频链接放在这里。 -->
```

```html
<!-- Promo video: drag the finished video into the GitHub web editor and place its link here. -->
```

Remove the current `user-attachments` URL, `<a>` poster block, old video-upload reminder, and the rendered “点击下载观看” prose.

- [ ] **Step 2: Add matching v1.1 project collection sections**

Both sections must cover unlimited folders, multi-folder membership, detail picker, batch assignment, drag/move, recursive filter, local-only storage, import/export compatibility, and deletion semantics. Place `project-tree.png`, `project-picker.png`, and `batch-assign.png` immediately after the paragraphs they demonstrate.

- [ ] **Step 3: Refresh existing feature prose and image alt text**

Keep existing capabilities but update numbering and descriptions to match the current UI. Reference only the refreshed PNG files from Task 2. Chinese text uses Chinese punctuation; English text is a faithful functional equivalent rather than a literal machine translation.

- [ ] **Step 4: Record v1.1.1 in the changelog**

Add a `v1.1.1 — 2026-08-11` section above v1.1.0 stating that GitHub introduction, screenshots and bilingual documentation were refreshed, and the promo area was intentionally left blank for manual upload.

- [ ] **Step 5: Run the README media contract**

Run: `node --test readme-media.test.js`

Expected: PASS for required v1.1 copy, matching screenshot references, valid PNGs and no video references.

- [ ] **Step 6: Commit documentation**

```bash
git add README.md README_EN.md CHANGELOG.md
git commit -m "docs: update bilingual v1.1 feature guide"
```

---

### Task 4: Verify and publish v1.1.1

**Files:**
- Verify only; no application file changes expected.

**Interfaces:**
- Consumes: all commits from Tasks 1–3.
- Produces: pushed `main`, annotated tag `v1.1.1`, GitHub Release, and successful GitHub Pages deployment.

- [ ] **Step 1: Run full verification**

Run:

```bash
node --check js/project-collections.js
node --check js/personal-store.js
node --check js/project-tree-view.js
node --check js/app.js
node --test '*.test.js'
git diff --check
git status --short --branch
```

Expected: all syntax checks exit 0, all tests pass, no tracked changes remain, and `.superpowers/` is the only unrelated untracked path.

- [ ] **Step 2: Push main**

```bash
git fetch origin
git push origin main
```

Expected: push succeeds without force.

- [ ] **Step 3: Create the release**

```bash
git tag -a v1.1.1 -m "RPGMZ DLC Database v1.1.1"
git push origin v1.1.1
gh release create v1.1.1 --repo subatxax-cell/rpgmaker-mz-dlc-db --title "v1.1.1 — README 与界面截图更新" --notes-file CHANGELOG.md
```

- [ ] **Step 4: Verify GitHub Pages and repository rendering**

Use `gh run watch <run-id> --repo subatxax-cell/rpgmaker-mz-dlc-db --exit-status`, then open the GitHub repository page and confirm the bilingual README links, all fourteen images, v1.1.1 badge and blank promo area render correctly.

---

## Final Acceptance

- [ ] Chinese and English README content describe the same current feature set.
- [ ] All old screenshots are visibly replaced with current v1.1 UI.
- [ ] Three new project collection screenshots are present and readable.
- [ ] No README contains a video, poster, download link, or `user-attachments` reference.
- [ ] Application data and behavior files remain unchanged.
- [ ] All automated tests pass and GitHub Pages deployment succeeds.
