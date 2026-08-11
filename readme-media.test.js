const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const zh = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const en = fs.readFileSync(path.join(root, 'README_EN.md'), 'utf8');
const required = ['project-tree.png', 'project-picker.png', 'batch-assign.png'];

function imagePaths(markdown) {
  return [...markdown.matchAll(/<img[^>]+src="([^"]+)"/g)].map(match => match[1]);
}

test('both READMEs describe project collections and reference the new screenshots', () => {
  for (const name of required) {
    assert.match(zh, new RegExp(`docs/media/${name}`));
    assert.match(en, new RegExp(`docs/media/${name}`));
  }
  assert.match(zh, /无限层级/);
  assert.match(en, /unlimited nested folders/i);
});

test('README image references exist and decode as PNG signatures', () => {
  for (const relative of new Set([...imagePaths(zh), ...imagePaths(en)])) {
    const bytes = fs.readFileSync(path.join(root, relative));
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], relative);
  }
});

test('promo sections contain no rendered video, poster, or download reference', () => {
  for (const readme of [zh, en]) {
    assert.doesNotMatch(readme, /user-attachments|promo\.(?:mp4|webm)|promo-poster/);
  }
  assert.doesNotMatch(zh, /点击上方图片下载/);
  assert.doesNotMatch(en, /click to download/i);
});
