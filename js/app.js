/**
 * RPG Maker MZ DLC Database - Application Logic
 * Notion-inspired database system for browsing Steam DLCs
 */

// ===== State =====
const state = {
  allDlcs: [],
  filteredDlcs: [],
  activeCategory: null,
  activeSubcategory: null,
  activeRating: 0,
  priceMin: 0,
  priceMax: 500,
  view: 'card',
  sort: 'recommendation-desc',
  searchQuery: '',
  fuse: null,
  personalData: {},
  personalDocument: null,
  activeProjectNodeId: null,
  includeProjectDescendants: false,
  batchMode: false,
  selectedDlcIds: new Set(),
  projectMenuNodeId: null,
  pickerMode: null,
  pickerSelectedNodeIds: new Set(),
  movingNodeId: null,
  showOwned: false,
  showWanted: false,
  showReviewed: false,
  currentModalDlc: null,
};

// ===== DOM Refs =====
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const dom = {
  cardGrid: $('#card-grid'),
  tableView: $('#table-view'),
  tableBody: $('#table-body'),
  searchInput: $('#search-input'),
  resultCount: $('#result-count'),
  categoryFilters: $('#category-filters'),
  ratingFilter: $('#rating-filter'),
  sortSelect: $('#sort-select'),
  contentArea: $('#content-area'),
  emptyState: $('#empty-state'),
  modalOverlay: $('#modal-overlay'),
  modal: $('#modal'),
  toast: $('#toast'),
  menuBtn: $('#menu-btn'),
  sidebar: $('#sidebar'),
  projectTree: $('#project-tree'),
};

// ===== localStorage =====
function loadPersonalData() {
  const loaded = window.personalStore.load(localStorage, 'rpgmz-dlc-personal');
  state.personalDocument = loaded.document;
  state.personalData = state.personalDocument.personalData;
  if (loaded.error) setTimeout(() => showToast('个人数据读取失败，已使用安全空数据'), 0);
}

function savePersonalData() {
  state.personalDocument.personalData = state.personalData;
  const result = window.personalStore.save(localStorage, 'rpgmz-dlc-personal', state.personalDocument);
  if (!result.ok) showToast('保存失败，请导出备份或释放浏览器空间');
  return result.ok;
}

function getPersonal(dlcId) {
  return state.personalData[dlcId] || { owned: false, wanted: false, rating: 0, notes: '' };
}

function setPersonal(dlcId, data) {
  const existing = getPersonal(dlcId);
  state.personalData[dlcId] = { ...existing, ...data };
  savePersonalData();
}

// ===== Fuse.js Search =====
function initSearch() {
  state.fuse = new Fuse(state.allDlcs, {
    keys: [
      { name: 'title_en', weight: 0.35 },
      { name: 'title_zh', weight: 0.25 },
      { name: 'description_en', weight: 0.15 },
      { name: 'description_zh', weight: 0.15 },
      { name: 'description', weight: 0.04 },
      { name: 'tags', weight: 0.1 },
      { name: 'theme', weight: 0.05 },
      { name: 'category', weight: 0.05 },
      { name: 'sub_category', weight: 0.03 },
    ],
    threshold: 0.4,
    distance: 100,
    includeScore: true,
    minMatchCharLength: 1,
    ignoreLocation: true,
  });
}

// ===== Filtering & Sorting =====
function applySearchFilter(dlcs) {
  let result = [...dlcs];
  const q = state.searchQuery.trim();
  if (q && state.fuse) {
    result = state.fuse.search(q).map(r => r.item);
  }
  return result;
}

function applyNonCategoryFilters(dlcs) {
  let result = [...dlcs];
  if (state.activeRating > 0) {
    result = result.filter(d => d.rating >= state.activeRating);
  }

  // Price range
  result = result.filter(d => {
    const price = d.price_cny || 0;
    return price >= state.priceMin && (state.priceMax >= 500 || price <= state.priceMax);
  });

  // Personal filters
  if (state.showOwned) {
    result = result.filter(d => getPersonal(d.id).owned);
  }
  if (state.showWanted) {
    result = result.filter(d => getPersonal(d.id).wanted);
  }
  if (state.showReviewed) {
    result = result.filter(d => getPersonal(d.id).rating > 0);
  }

  return result;
}

function visibleDlcsWithoutCategoryFilter() {
  return applyNonCategoryFilters(applySearchFilter(state.allDlcs));
}

function applyFilters() {
  let result = applySearchFilter(state.allDlcs);

  // Keep the pure category step after search and before all other filters.
  result = window.dlcFilters.filterByCategory(result, {
    category: state.activeCategory,
    subcategory: state.activeSubcategory,
  });

  result = applyProjectFilter(result);

  result = applyNonCategoryFilters(result);

  // Fuse supplies candidates only; the selected sort determines their display order.
  result = window.sortDlcs(result, state.sort);

  state.filteredDlcs = result;
  render();
}

function applyProjectFilter(dlcs) {
  if (!state.activeProjectNodeId) return dlcs;
  const ids = new Set(window.projectCollections.getAssignedAppIds(
    state.personalDocument.projectCollections,
    state.activeProjectNodeId,
    state.includeProjectDescendants,
  ));
  return dlcs.filter(dlc => ids.has(String(dlc.steam_appid)));
}

function renderProjectTree() {
  const collections = state.personalDocument.projectCollections;
  const counts = {};
  Object.values(collections.assignments).forEach(ids => ids.forEach(id => { counts[id] = (counts[id] || 0) + 1; }));
  const tree = window.projectTreeView.buildTree(collections, counts);
  dom.projectTree.innerHTML = tree.length
    ? window.projectTreeView.renderTreeHtml(tree, { activeNodeId: state.activeProjectNodeId })
    : '<div class="project-tree-empty">尚未创建项目</div>';
}

function updateCollections(next) {
  state.personalDocument.projectCollections = next;
  if (savePersonalData()) { renderProjectTree(); applyFilters(); }
}

// ===== Rendering =====
function starsHtml(rating) {
  let h = '';
  for (let i = 1; i <= 5; i++) {
    h += `<span class="star${i <= Math.round(rating) ? ' filled' : ''}">★</span>`;
  }
  return h;
}

function renderCard(dlc) {
  const p = getPersonal(dlc.id);
  const catClass = dlc.category || 'other';

  let badges = '';
  if (p.owned) badges += '<span class="badge owned">已拥有</span>';
  if (p.wanted) badges += '<span class="badge wanted">想买</span>';

  let personalStars = '';
  if (p.rating > 0) {
    personalStars = `<div class="card-personal-stars">我的评分: ${'★'.repeat(p.rating)}${'☆'.repeat(5-p.rating)}</div>`;
  }

  const catLabel = CATEGORY_LABELS[dlc.category] || dlc.category;

  const steamRating = dlc.steam_rating ? `${dlc.steam_rating}% 好评` : '';

  const imgUrl = getDlcHeaderImage(dlc);
  const catIcon = CATEGORY_ICONS[dlc.category] || '📋';
  const apiMovies = getDlcMovies(dlc);
  const hasVideo = !!(dlc.video_url || apiMovies.length > 0);
  const customImg = dlc.preview_image || '';
  const currentPrice = window.dlcDisplay.formatDlcPrice(dlc, '¥?');

  return `
    <div class="card${state.selectedDlcIds.has(dlc.id) ? ' batch-selected' : ''}" data-id="${dlc.id}" onclick="handleDlcClick('${dlc.id}')">
      ${state.batchMode ? `<input class="batch-select-checkbox" type="checkbox" ${state.selectedDlcIds.has(dlc.id) ? 'checked' : ''} aria-label="选择 ${escapeHtml(dlc.title_en)}">` : ''}
      <div class="card-image">
        <img src="${imgUrl}" alt="${escapeHtml(dlc.title_en)}"
             loading="lazy"
             onerror="this.style.display='none';var fb=this.parentElement.querySelector('.img-fallback');if(fb)fb.style.display='flex';var ld=this.parentElement.querySelector('.img-loading');if(ld)ld.style.display='none';"
             onload="var ld=this.parentElement.querySelector('.img-loading');if(ld)ld.style.display='none';">
        <div class="img-loading">⏳</div>
        <div class="img-fallback" style="display:none;">${catIcon}</div>
        ${hasVideo ? '<div class="img-category-badge">🎬 视频</div>' : ''}
        <div class="img-category-badge" style="${hasVideo ? 'top:32px;' : ''}">${catLabel}</div>
      </div>
      <div class="card-title-en">${escapeHtml(dlc.title_en)}</div>
      ${dlc.title_zh ? `<div class="card-title-zh">${escapeHtml(dlc.title_zh)}</div>` : ''}
      <div class="card-stars">
        ${starsHtml(dlc.rating)}
        <span class="rating-num">${dlc.rating.toFixed(1)}</span>
      </div>
      ${personalStars}
      <div class="card-footer">
        <div class="card-price">
          ${currentPrice}
          ${dlc.price_cny_lowest && dlc.price_cny_lowest < dlc.price_cny ? `<span class="price-lowest">史低 ¥${dlc.price_cny_lowest}</span>` : ''}
        </div>
        <div class="card-badges">${badges}</div>
      </div>
    </div>
  `;
}

function renderTableRow(dlc) {
  const p = getPersonal(dlc.id);
  const catLabel = CATEGORY_LABELS[dlc.category] || dlc.category;
  const currentPrice = window.dlcDisplay.formatDlcPrice(dlc, '¥?');

  return `
    <tr class="${state.selectedDlcIds.has(dlc.id) ? 'batch-selected' : ''}" data-id="${dlc.id}" onclick="handleDlcClick('${dlc.id}')">
      <td class="td-title">${state.batchMode ? `<input class="batch-select-checkbox" type="checkbox" ${state.selectedDlcIds.has(dlc.id) ? 'checked' : ''}>` : ''}${escapeHtml(dlc.title_en)}${dlc.title_zh ? `<br><small style="color:var(--text-tertiary)">${escapeHtml(dlc.title_zh)}</small>` : ''}</td>
      <td><span class="card-category ${dlc.category || 'other'}" style="font-size:10px">${catLabel}</span></td>
      <td>${starsHtml(dlc.rating)} <small>${dlc.rating.toFixed(1)}</small></td>
      <td>${currentPrice}</td>
      <td>${dlc.price_cny_lowest ? '¥'+dlc.price_cny_lowest : '-'}</td>
      <td>${dlc.steam_rating ? dlc.steam_rating + '%' : '-'}</td>
      <td>${dlc.theme || '-'}</td>
    </tr>
  `;
}

function render() {
  const dlcs = state.filteredDlcs;

  // Card view
  dom.cardGrid.innerHTML = dlcs.map(renderCard).join('');

  // Table view
  dom.tableBody.innerHTML = dlcs.map(renderTableRow).join('');

  // Result count
  dom.resultCount.textContent = `${dlcs.length} / ${state.allDlcs.length} 个结果`;

  // Empty state
  if (dlcs.length === 0) {
    dom.emptyState.style.display = 'block';
  } else {
    dom.emptyState.style.display = 'none';
  }

  // Update category counts
  renderCategoryFilters();
  renderProjectTree();
}

function handleDlcClick(id) {
  if (!state.batchMode) return openDetail(id);
  state.selectedDlcIds.has(id) ? state.selectedDlcIds.delete(id) : state.selectedDlcIds.add(id);
  renderBatchToolbar(); render();
}

function renderBatchToolbar() {
  $('#batch-toolbar').hidden = !state.batchMode;
  $('#batch-selected-count').textContent = `已选择 ${state.selectedDlcIds.size} 项`;
  $('#batch-assign-btn').disabled = state.selectedDlcIds.size === 0;
}

// ===== Category Filters =====
const CATEGORY_LABELS = window.dlcFilters.CATEGORY_LABELS;

function renderCategoryFilters() {
  const navigation = window.dlcFilters.buildCategoryNavigation(
    state.allDlcs,
    visibleDlcsWithoutCategoryFilter(),
    { category: state.activeCategory, subcategory: state.activeSubcategory },
  );

  dom.categoryFilters.innerHTML = navigation.map((item) => {
    const activeClass = item.selected ? ' active' : '';
    const expandedClass = item.expanded ? ' expanded' : '';
    const children = item.expanded
      ? `<div class="filter-children">${item.children.map((child) => `
          <div class="filter-item subcategory${child.selected ? ' active' : ''}" data-category="other" data-subcategory="${escapeHtmlAttribute(child.key)}">
            <span>${escapeHtml(child.label)}</span><span class="count">${child.count}</span>
          </div>`).join('')}
        </div>`
      : '';
    return `
      <div class="filter-item category level-${item.level}${activeClass}${expandedClass}" data-category="${escapeHtmlAttribute(item.key)}">
        <span>${escapeHtml(item.label)}</span><span class="count">${item.count}</span>
      </div>${children}`;
  }).join('');
}

// ===== Detail Modal =====
function openDetail(id) {
  const dlc = state.allDlcs.find(d => d.id === id);
  if (!dlc) return;
  state.currentModalDlc = dlc;
  const p = getPersonal(id);
  const detailView = window.dlcDisplay.buildDlcDetailView(dlc);

  $('#modal-category').textContent = CATEGORY_LABELS[dlc.category] || dlc.category;
  $('#modal-category').className = 'modal-category card-category ' + (dlc.category || 'other');
  $('#modal-title').textContent = dlc.title_en;
  $('#modal-title-zh').textContent = dlc.title_zh || '';

  // Build carousel slides from all available images
  const slides = buildCarouselSlides(dlc);
  initCarousel(slides, dlc);

  // Video
  const videoSection = $('#modal-video-section');
  const videoContainer = $('#modal-video');
  const steamMovie = getDlcMovies(dlc)[0];
  const detailVideoUrl = dlc.video_url || steamMovie?.mp4 || steamMovie?.webm || steamMovie?.hls || '';
  if (detailVideoUrl) {
    videoSection.style.display = 'block';
    const videoId = extractYouTubeId(detailVideoUrl);
    if (videoId) {
      videoContainer.innerHTML = `<iframe src="https://www.youtube.com/embed/${videoId}"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowfullscreen loading="lazy"></iframe>`;
    } else if (/\.(mp4|webm|m3u8)(\?|$)/i.test(detailVideoUrl)) {
      videoContainer.innerHTML = `<video src="${escapeHtml(detailVideoUrl)}" controls preload="metadata" playsinline></video>`;
      attachHlsVideo(videoContainer.querySelector('video'), detailVideoUrl);
    } else {
      videoContainer.innerHTML = `
        <div class="video-placeholder" onclick="window.open('${escapeHtml(detailVideoUrl)}', '_blank')">
          <div class="play-icon">▶️</div>
          <div class="play-text">点击查看预告片</div>
        </div>`;
    }
  } else {
    videoSection.style.display = 'none';
  }
  $('#modal-rating').textContent = detailView.recommendationScore;
  $('#modal-recommendation-source').textContent = detailView.recommendationSource;
  $('#modal-steam-rating').textContent = detailView.steamRating;
  $('#modal-review-count').textContent = detailView.reviewCount;
  $('#modal-price').textContent = detailView.price;
  $('#modal-price-lowest').textContent = detailView.lowestPrice;
  $('#modal-theme').textContent = dlc.theme || '通用';
  $('#modal-subcategory').textContent = dlc.sub_category || '-';
  $('#modal-description-en').textContent = detailView.descriptionEn;
  $('#modal-description-zh').textContent = detailView.descriptionZh;
  $('#modal-review').textContent = detailView.reviewSummary;
  $('#modal-steam-link').href = dlc.steam_url || `https://store.steampowered.com/app/${dlc.steam_appid}/`;

  // Tags
  const tags = dlc.tags || [];
  $('#modal-tags').innerHTML = tags.map(t => `<span class="tag">${t}</span>`).join('');
  $('#modal-tags-section').style.display = tags.length > 0 ? 'block' : 'none';

  // Features
  const features = dlc.gameplay_features || [];
  $('#modal-features').innerHTML = features.map(f => `<span class="tag">${f}</span>`).join('');
  $('#modal-features-section').style.display = features.length > 0 ? 'block' : 'none';

  // Personal
  $('#modal-toggle-owned').className = 'toggle-btn' + (p.owned ? ' active owned' : '');
  $('#modal-toggle-owned').textContent = p.owned ? '✅ 已拥有 (点击取消)' : '✅ 已拥有';
  $('#modal-toggle-wanted').className = 'toggle-btn' + (p.wanted ? ' active wanted' : '');
  $('#modal-toggle-wanted').textContent = p.wanted ? '🔖 想买 (点击取消)' : '🔖 想买';
  $('#modal-notes').value = p.notes || '';
  const memberships = state.personalDocument.projectCollections.assignments[String(dlc.steam_appid)] || [];
  $('#modal-project-assign').textContent = `📁 加入项目目录 (${memberships.length})`;

  // Personal stars
  const starBtns = $('#modal-personal-stars').querySelectorAll('button');
  starBtns.forEach(btn => {
    const s = parseInt(btn.dataset.star);
    btn.textContent = s <= p.rating ? '★' : '☆';
    btn.className = s <= p.rating ? 'filled' : '';
  });

  dom.modalOverlay.classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeDetail() {
  dom.modalOverlay.classList.remove('active');
  document.body.style.overflow = '';
  state.currentModalDlc = null;
}

function openProjectPicker(mode) {
  state.pickerMode = mode;
  const collections = state.personalDocument.projectCollections;
  if (!Object.keys(collections.nodes).length) return showToast('请先在左侧新建项目');
  if (mode === 'replace' && state.currentModalDlc) state.pickerSelectedNodeIds = new Set(collections.assignments[String(state.currentModalDlc.steam_appid)] || []);
  else state.pickerSelectedNodeIds = new Set();
  $('#project-picker-search').value = '';
  renderProjectPicker();
  $('#project-picker-overlay').classList.add('active');
}

function renderProjectPicker() {
  const tree = window.projectTreeView.buildTree(state.personalDocument.projectCollections, {});
  $('#project-picker-tree').innerHTML = window.projectTreeView.renderPickerHtml(tree, [...state.pickerSelectedNodeIds], $('#project-picker-search').value);
  $('#project-picker-count').textContent = `已选择 ${state.pickerSelectedNodeIds.size} 个目录`;
}

function saveProjectPicker() {
  const nodeIds = [...state.pickerSelectedNodeIds];
  let collections = state.personalDocument.projectCollections;
  if (state.pickerMode === 'replace') collections = window.projectCollections.setAssignments(collections, String(state.currentModalDlc.steam_appid), nodeIds);
  else {
    const appIds = [...state.selectedDlcIds].map(id => state.allDlcs.find(d => d.id === id)).filter(Boolean).map(d => String(d.steam_appid));
    collections = window.projectCollections.addAssignments(collections, appIds, nodeIds);
  }
  updateCollections(collections);
  $('#project-picker-overlay').classList.remove('active');
  if (state.pickerMode === 'add') { state.batchMode = false; state.selectedDlcIds.clear(); renderBatchToolbar(); render(); }
  showToast('项目归类已保存');
}

function openMoveDialog(nodeId) {
  state.movingNodeId = nodeId;
  const targets = window.projectTreeView.buildMoveTargets(state.personalDocument.projectCollections, nodeId);
  $('#move-node-target').innerHTML = targets.map(t => `<option value="${escapeHtmlAttribute(t.id)}">${'—'.repeat(Math.max(0,t.depth-1))} ${escapeHtml(t.name)}</option>`).join('');
  if (!targets.length) return showToast('没有可移动到的目录');
  $('#move-node-dialog').showModal();
}

// ===== Event Handlers =====
function setupEventHandlers() {
  $('#new-project-btn').addEventListener('click', () => {
    const name = prompt('请输入项目名称');
    if (!name) return;
    try { updateCollections(window.projectCollections.createNode(state.personalDocument.projectCollections, { type: 'project', name, parentId: null })); }
    catch (error) { showToast(error.message); }
  });

  dom.projectTree.addEventListener('click', event => {
    const menu = event.target.closest('[data-project-menu]');
    if (menu) {
      const nodeId = menu.dataset.projectMenu;
      state.projectMenuNodeId = nodeId;
      const popup = $('#project-node-menu'); popup.hidden = false;
      popup.style.left = `${Math.min(event.clientX, innerWidth - 160)}px`; popup.style.top = `${Math.min(event.clientY, innerHeight - 180)}px`;
      popup.querySelector('[data-node-action="move"]').hidden = state.personalDocument.projectCollections.nodes[nodeId].type === 'project';
      return;
    }
    const select = event.target.closest('[data-project-select]');
    if (!select) return;
    const nodeId = select.dataset.projectSelect;
    const collections = JSON.parse(JSON.stringify(state.personalDocument.projectCollections));
    const expanded = new Set(collections.expandedNodeIds || []);
    expanded.has(nodeId) ? expanded.delete(nodeId) : expanded.add(nodeId);
    collections.expandedNodeIds = [...expanded];
    state.activeProjectNodeId = state.activeProjectNodeId === nodeId ? null : nodeId;
    updateCollections(collections);
  });

  $('#project-node-menu').addEventListener('click', event => {
    const action = event.target.dataset.nodeAction; if (!action) return;
    const id = state.projectMenuNodeId; const node = state.personalDocument.projectCollections.nodes[id]; $('#project-node-menu').hidden = true;
    try {
      if (action === 'child') { const name = prompt('请输入子目录名称'); if (name) updateCollections(window.projectCollections.createNode(state.personalDocument.projectCollections, { type:'folder', name, parentId:id })); }
      if (action === 'rename') { const name = prompt('请输入新名称', node.name); if (name) updateCollections(window.projectCollections.renameNode(state.personalDocument.projectCollections, id, name)); }
      if (action === 'move') openMoveDialog(id);
      if (action === 'delete') { state.movingNodeId = id; const descendants = window.projectCollections.getDescendantIds(state.personalDocument.projectCollections,id); $('#delete-node-summary').textContent = `将删除“${node.name}”和 ${descendants.length} 个子目录。DLC、已拥有、想买、评分和备注不会被删除。`; $('#delete-node-dialog').showModal(); }
    } catch (error) { showToast(error.message); }
  });

  $('#move-node-confirm').addEventListener('click', event => { event.preventDefault(); try { updateCollections(window.projectCollections.moveNode(state.personalDocument.projectCollections, state.movingNodeId, $('#move-node-target').value, 9999)); $('#move-node-dialog').close(); } catch(error) { showToast(error.message); } });
  $('#delete-node-confirm').addEventListener('click', event => { event.preventDefault(); updateCollections(window.projectCollections.deleteNode(state.personalDocument.projectCollections, state.movingNodeId)); if (!state.personalDocument.projectCollections.nodes[state.activeProjectNodeId]) state.activeProjectNodeId=null; $('#delete-node-dialog').close(); });

  let draggedNodeId = null;
  dom.projectTree.addEventListener('dragstart', event => { const row=event.target.closest('[data-node-id]'); if(!row)return; draggedNodeId=row.dataset.nodeId; row.classList.add('dragging'); });
  dom.projectTree.addEventListener('dragover', event => { if(event.target.closest('[data-node-id]')) event.preventDefault(); });
  dom.projectTree.addEventListener('drop', event => { event.preventDefault(); const row=event.target.closest('[data-node-id]'); if(!row||!draggedNodeId)return; try { updateCollections(window.projectCollections.moveNode(state.personalDocument.projectCollections,draggedNodeId,row.dataset.nodeId,9999)); } catch(error){ showToast(error.message); } });
  dom.projectTree.addEventListener('dragend', () => { draggedNodeId=null; dom.projectTree.querySelectorAll('.dragging').forEach(x=>x.classList.remove('dragging')); });

  $('#modal-project-assign').addEventListener('click', () => openProjectPicker('replace'));
  $('#project-picker-close').addEventListener('click', () => $('#project-picker-overlay').classList.remove('active'));
  $('#project-picker-search').addEventListener('input', renderProjectPicker);
  $('#project-picker-tree').addEventListener('change', event => { if(!event.target.matches('input[type="checkbox"]'))return; event.target.checked ? state.pickerSelectedNodeIds.add(event.target.value) : state.pickerSelectedNodeIds.delete(event.target.value); renderProjectPicker(); });
  $('#project-picker-save').addEventListener('click', saveProjectPicker);
  $('#batch-mode-btn').addEventListener('click', () => { state.batchMode=true; renderBatchToolbar(); render(); });
  $('#batch-cancel-btn').addEventListener('click', () => { state.batchMode=false; state.selectedDlcIds.clear(); renderBatchToolbar(); render(); });
  $('#batch-assign-btn').addEventListener('click', () => openProjectPicker('add'));

  $('#include-project-descendants').addEventListener('change', event => {
    state.includeProjectDescendants = event.target.checked;
    applyFilters();
  });

  // Category navigation uses one delegated listener, so repeated renders never
  // accumulate stale handlers on replaced sidebar items.
  dom.categoryFilters.addEventListener('click', (event) => {
    const item = event.target.closest('.filter-item');
    if (!item || !dom.categoryFilters.contains(item)) return;

    const category = item.dataset.category;
    const subcategory = item.dataset.subcategory;
    if (!category || category === 'all') {
      state.activeCategory = null;
      state.activeSubcategory = null;
    } else if (subcategory) {
      state.activeCategory = 'other';
      state.activeSubcategory = subcategory;
    } else {
      state.activeCategory = category;
      state.activeSubcategory = null;
    }
    applyFilters();
  });

  // Search
  dom.searchInput.addEventListener('input', debounce(() => {
    state.searchQuery = dom.searchInput.value;
    applyFilters();
  }, 150));

  // Keyboard shortcut for search
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      dom.searchInput.focus();
    }
    if (e.key === 'Escape') {
      closeDetail();
    }
  });

  // Rating filter
  $('#rating-filter').addEventListener('click', (e) => {
    const btn = e.target.closest('.star-btn');
    if (!btn) return;
    $('#rating-filter').querySelectorAll('.star-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.activeRating = parseInt(btn.dataset.rating);
    applyFilters();
  });

  // Price sliders
  $('#price-min').addEventListener('input', () => {
    state.priceMin = parseInt($('#price-min').value);
    if (state.priceMin > state.priceMax) {
      state.priceMax = state.priceMin;
      $('#price-max').value = state.priceMin;
    }
    updatePriceLabels();
    applyFilters();
  });

  $('#price-max').addEventListener('input', () => {
    state.priceMax = parseInt($('#price-max').value);
    if (state.priceMax < state.priceMin) {
      state.priceMin = state.priceMax;
      $('#price-min').value = state.priceMax;
    }
    updatePriceLabels();
    applyFilters();
  });

  // Sort
  dom.sortSelect.addEventListener('change', () => {
    state.sort = dom.sortSelect.value;
    applyFilters();
  });

  // View toggle
  $$('.view-toggle .btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.view = btn.dataset.view;
      $$('.view-toggle .btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      if (state.view === 'card') {
        dom.cardGrid.classList.add('active');
        dom.tableView.classList.remove('active');
      } else {
        dom.cardGrid.classList.remove('active');
        dom.tableView.classList.add('active');
      }
    });
  });

  // Personal filter toggles
  $('#filter-owned').addEventListener('change', () => {
    state.showOwned = $('#filter-owned').checked;
    applyFilters();
  });
  $('#filter-wanted').addEventListener('change', () => {
    state.showWanted = $('#filter-wanted').checked;
    applyFilters();
  });
  $('#filter-reviewed').addEventListener('change', () => {
    state.showReviewed = $('#filter-reviewed').checked;
    applyFilters();
  });

  // Table headers sort
  dom.tableView.querySelectorAll('th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (state.sort.startsWith(key)) {
        state.sort = key + (state.sort.endsWith('asc') ? '-desc' : '-asc');
      } else {
        state.sort = key + '-desc';
      }
      dom.sortSelect.value = state.sort;
      applyFilters();
    });
  });

  // Carousel navigation
  const carouselPrev = document.getElementById('carousel-prev');
  const carouselNext = document.getElementById('carousel-next');
  const carouselFsBtn = document.getElementById('carousel-fs-btn');
  const carouselMain = document.getElementById('carousel-main');

  if (carouselPrev) carouselPrev.addEventListener('click', (e) => { e.stopPropagation(); prevSlide(); });
  if (carouselNext) carouselNext.addEventListener('click', (e) => { e.stopPropagation(); nextSlide(); });

  // Carousel fullscreen toggle
  if (carouselFsBtn) {
    carouselFsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const carousel = document.getElementById('modal-carousel');
      if (!carousel) return;
      const isFs = carousel.classList.toggle('carousel-fullscreen');
      carouselFsBtn.textContent = isFs ? '⛶ 退出全屏' : '⛶ 全屏';
      document.body.style.overflow = isFs ? 'hidden' : '';
    });
  }

  // Carousel keyboard navigation (when modal is open)
  document.addEventListener('keydown', (e) => {
    const modalActive = document.getElementById('modal-overlay')?.classList.contains('active');
    if (!modalActive) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); prevSlide(); }
    if (e.key === 'ArrowRight') { e.preventDefault(); nextSlide(); }
  });

  // Carousel touch/swipe support
  if (carouselMain) {
    let touchStartX = 0, touchStartY = 0;
    carouselMain.addEventListener('touchstart', (e) => {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }, { passive: true });
    carouselMain.addEventListener('touchend', (e) => {
      const dx = e.changedTouches[0].clientX - touchStartX;
      const dy = e.changedTouches[0].clientY - touchStartY;
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 50) {
        if (dx > 0) prevSlide();
        else nextSlide();
      }
    });
  }

  // Modal close
  $('#modal-close').addEventListener('click', closeDetail);
  dom.modalOverlay.addEventListener('click', (e) => {
    if (e.target === dom.modalOverlay) closeDetail();
  });

  // Modal - toggle owned
  $('#modal-toggle-owned').addEventListener('click', () => {
    if (!state.currentModalDlc) return;
    const p = getPersonal(state.currentModalDlc.id);
    setPersonal(state.currentModalDlc.id, { owned: !p.owned });
    openDetail(state.currentModalDlc.id);
    applyFilters();
    showToast(p.owned ? '已取消"已拥有"标记' : '已标记为"已拥有"');
  });

  // Modal - toggle wanted
  $('#modal-toggle-wanted').addEventListener('click', () => {
    if (!state.currentModalDlc) return;
    const p = getPersonal(state.currentModalDlc.id);
    setPersonal(state.currentModalDlc.id, { wanted: !p.wanted });
    openDetail(state.currentModalDlc.id);
    applyFilters();
    showToast(p.wanted ? '已取消"想买"标记' : '已标记为"想买"');
  });

  // Modal - personal stars
  $('#modal-personal-stars').addEventListener('click', (e) => {
    if (!state.currentModalDlc) return;
    const btn = e.target.closest('button');
    if (!btn) return;
    const star = parseInt(btn.dataset.star);
    setPersonal(state.currentModalDlc.id, { rating: star });
    openDetail(state.currentModalDlc.id);
    applyFilters();
    showToast(`个人评分: ${'★'.repeat(star)}${'☆'.repeat(5-star)}`);
  });

  // Modal - notes
  $('#modal-notes').addEventListener('input', debounce(() => {
    if (!state.currentModalDlc) return;
    setPersonal(state.currentModalDlc.id, { notes: $('#modal-notes').value });
  }, 300));

  // Theme toggle
  $('#theme-toggle').addEventListener('click', () => {
    const html = document.documentElement;
    const isDark = html.getAttribute('data-theme') === 'dark';
    html.setAttribute('data-theme', isDark ? 'light' : 'dark');
    $('#theme-toggle').textContent = isDark ? '🌙' : '☀️';
    localStorage.setItem('rpgmz-theme', isDark ? 'light' : 'dark');
  });

  // Export
  $('#export-btn').addEventListener('click', exportData);

  // Import
  $('#import-btn').addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const document = window.personalStore.parseImport(ev.target.result);
          if (!confirm('导入将替换当前个人标记和项目目录，是否继续？')) return;
          const saved = window.personalStore.save(localStorage, 'rpgmz-dlc-personal', document);
          if (!saved.ok) throw saved.error;
          state.personalDocument = document; state.personalData = document.personalData; state.activeProjectNodeId = null;
          applyFilters(); showToast('数据导入成功！');
        } catch (error) {
          showToast(`导入失败：${error.message || '请检查文件格式'}`);
        }
      };
      reader.readAsText(file);
    });
    input.click();
  });

  // Mobile menu
  dom.menuBtn.addEventListener('click', () => {
    dom.sidebar.classList.toggle('mobile-open');
  });

  // Image viewer
  const imageViewerOverlay = document.getElementById('image-viewer-overlay');
  if (imageViewerOverlay) {
    imageViewerOverlay.addEventListener('click', (e) => {
      if (e.target === imageViewerOverlay || e.target.id === 'image-viewer-close') {
        closeImageViewer();
      }
    });
    document.getElementById('image-viewer-close')?.addEventListener('click', closeImageViewer);
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && imageViewerOverlay?.classList.contains('active')) {
      closeImageViewer();
    }
  });

  // Close sidebar on click outside (mobile)
  document.addEventListener('click', (e) => {
    if (window.innerWidth <= 768) {
      if (!dom.sidebar.contains(e.target) && e.target !== dom.menuBtn && !dom.menuBtn.contains(e.target)) {
        dom.sidebar.classList.remove('mobile-open');
      }
    }
  });
}

function updatePriceLabels() {
  $('#price-min-label').textContent = `¥${state.priceMin}`;
  $('#price-max-label').textContent = state.priceMax >= 500 ? '¥500+' : `¥${state.priceMax}`;
}

// ===== Export / Import =====
function exportData() {
  const blob = new Blob([window.personalStore.serializeExport(state.personalDocument)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `rpgmz-dlc-backup-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('个人数据已导出！');
}

// ===== Toast =====
function showToast(msg) {
  const t = dom.toast;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timeout);
  t._timeout = setTimeout(() => t.classList.remove('show'), 2000);
}

// ===== Steam Image Helpers =====
let steamImagesData = {};

// Load pre-fetched Steam API images data
function loadSteamImages() {
  if (window.STEAM_IMAGES_DATA) {
    steamImagesData = window.STEAM_IMAGES_DATA;
    console.log('Steam images loaded:', Object.keys(steamImagesData).length, 'apps');
    if (state.filteredDlcs.length > 0) render();
    return;
  }
  fetch('data/steam-images.json')
    .then(r => r.json())
    .then(data => {
      steamImagesData = data;
      console.log('Steam images loaded:', Object.keys(data).length, 'apps');
      if (state.filteredDlcs.length > 0) render();
    })
    .catch(() => console.log('Steam images data not available'));
}

function getSteamImage(appid, type = 'header') {
  if (!appid) return '';
  const apiData = steamImagesData[appid];
  if (apiData) {
    if (type === 'header' && apiData.header_image) return apiData.header_image;
    if (type === 'capsule' && apiData.capsule_image) return apiData.capsule_image;
    if (type === 'background' && apiData.background) return apiData.background;
  }
  const base = 'https://shared.steamstatic.com/store_item_assets/steam/apps';
  const images = {
    header: `${base}/${appid}/header.jpg`,
    capsule: `${base}/${appid}/capsule_616x353.jpg`,
    library: `${base}/${appid}/library_600x900.jpg`,
    background: `${base}/${appid}/page_bg_raw.jpg`,
  };
  return images[type] || images.header;
}

function getDlcScreenshots(dlc) {
  const apiData = steamImagesData[dlc.steam_appid];
  const manual = (dlc.screenshots || []).filter(Boolean);
  const steam = (apiData?.screenshots || []).map(s => s.full).filter(Boolean);
  return [...new Set([...manual, ...steam])];
}

function getDlcMovies(dlc) {
  const apiData = steamImagesData[dlc.steam_appid];
  return (apiData?.movies || []).filter(m => m.mp4 || m.webm || m.hls || m.dash);
}

function getDlcHeaderImage(dlc) {
  if (dlc.preview_image) return dlc.preview_image;
  return getSteamImage(dlc.steam_appid, 'header');
}

const CATEGORY_ICONS = {
  tileset: '🗺️', plugin: '🔌', music: '🎵', sfx: '🔊',
  character: '👤', battler: '⚔️', animation: '✨', icon: '🖼️',
  generator: '🧑‍🎨', weather: '🌦️', bundle: '📦', window: '🪟',
  tool: '🛠️', theme: '🎨', retro: '👾', scifi: '🚀',
};

// ===== Carousel =====
let carouselState = { slides: [], current: 0 };

function buildCarouselSlides(dlc) {
  const slides = [];
  const seen = new Set();

  function addSlide(type, url, label) {
    if (!url || seen.has(url)) return;
    seen.add(url);
    slides.push({ type, url, label });
  }

  // 1. Steam API screenshots (full resolution)
  const apiScreenshots = getDlcScreenshots(dlc);
  apiScreenshots.forEach(url => addSlide('image', url, '截图'));

  // 2. Custom preview_image from data
  if (dlc.preview_image) addSlide('image', dlc.preview_image, '预览');

  // 3. Steam header image
  const headerUrl = getDlcHeaderImage(dlc);
  addSlide('image', headerUrl, '封面');

  // 4. Steam capsule image
  const capsuleUrl = getSteamImage(dlc.steam_appid, 'capsule');
  addSlide('image', capsuleUrl, '头图');

  // 5. Videos from Steam API (mp4/webm)
  const movies = getDlcMovies(dlc);
  movies.forEach(m => {
    const url = m.mp4 || m.webm || m.hls || m.dash || '';
    if (url) addSlide('video', url, '🎬 Steam预告片');
  });

  // 6. Manual video_url from data
  if (dlc.video_url) addSlide('video', dlc.video_url, '🎬 视频');

  return slides;
}

function initCarousel(slides, dlc) {
  carouselState = { slides, current: 0, dlc };
  const carousel = document.getElementById('modal-carousel');
  if (!carousel) return;

  if (slides.length === 0) {
    // No slides at all - show fallback
    renderCarouselSlide(null);
    renderCarouselDots(0);
    renderCarouselThumbs([]);
    updateCarouselCounter(-1, 0);
    carousel.style.display = 'block';
    return;
  }

  carouselState.current = 0;
  renderCarouselSlide(slides[0]);
  renderCarouselDots(slides.length);
  renderCarouselThumbs(slides);
  updateCarouselCounter(0, slides.length);
  carousel.style.display = 'block';
}

function renderCarouselSlide(slide) {
  const main = document.getElementById('carousel-main');
  const placeholder = document.getElementById('carousel-placeholder');
  if (!main) return;

  // Remove existing img/video
  main.querySelectorAll('img,video').forEach(el => el.remove());

  if (!slide) {
    if (placeholder) placeholder.style.display = 'flex';
    return;
  }

  if (placeholder) placeholder.style.display = 'none';

  if (slide.type === 'video') {
    const videoId = extractYouTubeId(slide.url);
    const isDirectVideo = slide.url.match(/\.(mp4|webm|m3u8)(\?|$)/i);

    if (isDirectVideo) {
      // Direct video file (from Steam API)
      const video = document.createElement('video');
      video.src = slide.url;
      video.controls = true;
      video.preload = 'metadata';
      video.style.cssText = 'max-width:100%;max-height:100%;';
      video.setAttribute('playsinline', '');
      main.appendChild(video);
      attachHlsVideo(video, slide.url);
    } else if (videoId) {
      // YouTube embed
      const iframe = document.createElement('iframe');
      iframe.src = `https://www.youtube.com/embed/${videoId}?autoplay=0`;
      iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
      iframe.allowFullscreen = true;
      iframe.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:none;';
      main.appendChild(iframe);
    } else {
      // Unknown video URL
      if (placeholder) {
        placeholder.innerHTML = '<span class="icon">🎬</span><span class="text">点击查看预告片</span>';
        placeholder.style.display = 'flex';
        placeholder.style.cursor = 'pointer';
        placeholder.onclick = () => window.open(slide.url, '_blank');
      }
    }
  } else {
    const img = document.createElement('img');
    img.src = slide.url;
    img.alt = slide.label || '';
    img.loading = 'lazy';
    img.onerror = function() {
      this.style.display = 'none';
      if (placeholder) {
        placeholder.style.display = 'flex';
        placeholder.innerHTML = '<span class="icon">🖼️</span><span class="text">图片加载失败</span>';
      }
    };
    main.appendChild(img);
  }
}

function attachHlsVideo(video, url) {
  if (!/\.m3u8(\?|$)/i.test(url) || video.canPlayType('application/vnd.apple.mpegurl')) return;
  if (window.Hls?.isSupported()) {
    const hls = new Hls();
    hls.loadSource(url);
    hls.attachMedia(video);
  }
}

function renderCarouselDots(count) {
  const dots = document.getElementById('carousel-dots');
  if (!dots) return;
  if (count <= 1) { dots.innerHTML = ''; return; }
  dots.innerHTML = Array.from({ length: count }, (_, i) =>
    `<button class="carousel-dot${i === carouselState.current ? ' active' : ''}" data-index="${i}" title="第${i+1}张"></button>`
  ).join('');

  dots.querySelectorAll('.carousel-dot').forEach(dot => {
    dot.addEventListener('click', () => {
      goToSlide(parseInt(dot.dataset.index));
    });
  });
}

function renderCarouselThumbs(slides) {
  const thumbs = document.getElementById('carousel-thumbs');
  if (!thumbs) return;
  if (slides.length <= 1) { thumbs.innerHTML = ''; thumbs.style.display = 'none'; return; }
  thumbs.style.display = 'flex';
  const imageSlides = slides.filter(s => s.type === 'image');
  if (imageSlides.length <= 1) { thumbs.innerHTML = ''; thumbs.style.display = 'none'; return; }

  thumbs.innerHTML = imageSlides.map((s, i) => {
    const slideIndex = slides.indexOf(s);
    return `<div class="carousel-thumb${slideIndex === carouselState.current ? ' active' : ''}" data-index="${slideIndex}">
      <img src="${s.url}" alt="" loading="lazy" onerror="this.parentElement.remove();">
    </div>`;
  }).join('');

  thumbs.querySelectorAll('.carousel-thumb').forEach(thumb => {
    thumb.addEventListener('click', () => {
      goToSlide(parseInt(thumb.dataset.index));
      thumb.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    });
  });
}

function goToSlide(index) {
  const { slides } = carouselState;
  if (index < 0 || index >= slides.length) return;
  carouselState.current = index;
  renderCarouselSlide(slides[index]);
  renderCarouselDots(slides.length);
  renderCarouselThumbs(slides);
  updateCarouselCounter(index, slides.length);

  // Scroll active thumb into view
  const activeThumb = document.querySelector('.carousel-thumb.active');
  if (activeThumb) {
    activeThumb.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }
}

function nextSlide() {
  const { slides, current } = carouselState;
  if (current < slides.length - 1) goToSlide(current + 1);
}

function prevSlide() {
  if (carouselState.current > 0) goToSlide(carouselState.current - 1);
}

function updateCarouselCounter(current, total) {
  const counter = document.getElementById('carousel-counter');
  if (!counter) return;
  if (total <= 1) { counter.style.display = 'none'; return; }
  counter.style.display = 'block';
  counter.textContent = `${current + 1} / ${total}`;
}

function isPlaceholderAppId(appid) {
  // Check if this looks like a placeholder/fake app ID
  const num = parseInt(appid);
  return isNaN(num) || num < 100000 || /^(38|39|40|41|42|43)\d{4}[015]$/.test(appid);
}

async function fetchSteamScreenshots(appid) {
  // Try to fetch screenshot data from Steam store page
  // This is a best-effort approach; CORS may block it
  try {
    const proxyUrl = `https://store.steampowered.com/app/${appid}/`;
    const resp = await fetch(proxyUrl, { mode: 'no-cors' });
    // With no-cors we can't read the response, so this is limited
    // Screenshots must be manually added to data.js for reliable display
    console.log('Screenshot fetch attempted for app', appid);
  } catch (e) {
    // Silently fail - screenshots are optional
  }
}

// ===== Image Viewer =====
function openImageViewer(url) {
  const overlay = document.getElementById('image-viewer-overlay');
  const img = document.getElementById('image-viewer-img');
  if (!overlay || !img) return;
  img.src = url;
  overlay.classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeImageViewer() {
  const overlay = document.getElementById('image-viewer-overlay');
  const img = document.getElementById('image-viewer-img');
  if (!overlay) return;
  overlay.classList.remove('active');
  if (img) img.src = '';
  if (!document.getElementById('modal-overlay').classList.contains('active')) {
    document.body.style.overflow = '';
  }
}

// ===== YouTube Helper =====
function extractYouTubeId(url) {
  if (!url) return null;
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/
  ];
  for (const p of patterns) {
    const match = url.match(p);
    if (match) return match[1];
  }
  return null;
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeHtmlAttribute(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

// ===== Init =====
function init() {
  loadPersonalData();

  // Load theme
  const savedTheme = localStorage.getItem('rpgmz-theme');
  if (savedTheme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
    $('#theme-toggle').textContent = '☀️';
  }

  // Load the canonical Steam inventory. Legacy js/data.js remains available as
  // curated merge input, but is no longer the browser inventory authority.
  if (!Array.isArray(window.ALL_STEAM_DLCS)) {
    console.error('Canonical Steam DLC catalog not loaded! Make sure data/dlc-catalog.js is loaded before js/app.js');
    state.allDlcs = [];
  } else {
    state.allDlcs = window.ALL_STEAM_DLCS
      .filter(dlc => dlc.steam_verified !== false)
      .map(dlc => ({
        ...dlc,
        id: dlc.id || String(dlc.steam_appid),
        rating: Number.isFinite(Number(dlc.rating))
          ? Number(dlc.rating)
          : Number.isFinite(Number(dlc.recommendation_score))
            ? Number(dlc.recommendation_score) / 20
            : 0,
      }));
  }

  dom.sortSelect.value = state.sort;
  initSearch();
  loadSteamImages();
  setupEventHandlers();
  applyFilters();
}

// Start app when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
