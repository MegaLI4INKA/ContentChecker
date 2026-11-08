/* ── State ─────────────────────────────────────────────────────────────────── */
const state = {
  root: localStorage.getItem("cc_root") || "",
  path: "",
  flat: false,
  search: "",        // filename search
  searchDeep: localStorage.getItem("cc_search_deep") === "1",  // search the whole subtree
  searchFolder: "",  // folder name search
  categories: new Set(),
  bestFolder: 0,
  bestFile: 0,
  mediaFilter: "all",
  photoSize: "medium",    // "small" | "medium" | "large"
  naturalRatio: false,    // true = natural aspect ratio, false = fixed 4:3
  showTexts: false,       // show text file contents in photo mode
  viewMode: "grid",
  page: "browse",
  favLevel: 0,
  favMediaFilter: "all",  // "all" | "videos" | "photos"
  wpMediaFilter: "all",   // "all" | "videos" | "photos" — wallpapers tab
  galleryItems: [],
  galleryIdx: 0,
};

/* ── API helpers ───────────────────────────────────────────────────────────── */
async function api(url) {
  const r = await fetch(url);
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try { msg = (await r.json()).detail || msg; } catch (_) {}
    throw new Error(msg);
  }
  return r.json();
}

// Each load bumps the counter; a response that arrives after a newer load
// started is stale (e.g. slow search for "ab" finishing after "abc") and is dropped.
let loadSeq = 0;
let searchSeq = 0;

function browseUrl() {
  const p = new URLSearchParams({
    root: state.root,
    path: state.path,
    flat: state.flat,
    search: state.search,
    search_deep: state.searchDeep,
    search_folder: state.searchFolder,
    categories: [...state.categories].join(","),
    min_folder_best: state.bestFolder,
    min_file_best: state.bestFile,
    media_filter: state.mediaFilter,
  });
  return "/api/browse?" + p;
}

function imageThumbUrl(path) {
  return `/api/thumb?src=${encodeURIComponent(path)}`;
}

// Generates (or finds) a cached video frame; the server derives its position from idx
function genThumbUrl(videoPath, idx) {
  return `/api/gen-thumb?src=${encodeURIComponent(videoPath)}&idx=${idx}&kind=video`;
}

function categoriesUrl() {
  return `/api/categories?root=${encodeURIComponent(state.root)}&path=${encodeURIComponent(state.path)}`;
}

/* ── Load dispatcher ───────────────────────────────────────────────────────── */
async function load() {
  if (!state.root) return;
  localStorage.setItem("cc_root", state.root);
  if (state.page === "favorites" || state.page === "wallpapers") {
    await loadTagView(state.page);
  } else {
    await loadBrowse();
  }
}

/* ── Paging ────────────────────────────────────────────────────────────────── */
// Listings come page by page (server: offset → next_offset). Each tab has a
// pager: start(url) begins a new listing (an older one's in-flight page is then
// dropped), accept(data) renders a page, next() runs when the tab's sentinel
// scrolls into view or its "Загрузить ещё" button is clicked.
class Pager {
  constructor({ page, sentinel, scrollRoot, onPage }) {
    this.page = page;
    this.sentinel = document.getElementById(sentinel);
    this.button = this.sentinel.querySelector("button");
    this.onPage = onPage;
    this.gen = 0;
    this.start(null);
    this.button.addEventListener("click", () => this.next());
    // The tab's scrolling element must be the root: with the viewport as root
    // the margin would not extend into it. Loads a bit before the end.
    this.observer = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) this.next();
    }, { root: document.getElementById(scrollRoot), rootMargin: "0px 0px 1200px 0px" });
  }

  get more() { return this.nextOffset != null; }

  start(url) {
    this.gen++;
    Object.assign(this, { url, nextOffset: null, loading: false, error: false });
    this.update();
  }

  accept(data) {
    this.nextOffset = data.next_offset;
    this.onPage(data);
    this.update();
  }

  async next() {
    if (this.loading || !this.more || state.page !== this.page) return;
    const gen = this.gen;
    this.loading = true;
    this.error = false;
    this.update();
    try {
      const data = await api(`${this.url}&offset=${this.nextOffset}`);
      if (gen !== this.gen) return;
      this.loading = false;
      this.accept(data);
    } catch (e) {
      if (gen !== this.gen) return;
      this.loading = false;
      this.error = true;  // no auto-retry loop: the button retries
      this.update();
      console.error(e);
    }
  }

  update() {
    this.sentinel.classList.toggle("hidden", !this.more);
    this.button.disabled = this.loading;
    this.button.textContent = this.loading ? "Загрузка…"
                            : this.error   ? "Ошибка загрузки — повторить"
                            : "Загрузить ещё";
    // Re-observing fires the callback again if the sentinel is still in view
    // (page shorter than the screen) — that's what loads the following page.
    if (this.observer && this.more && !this.loading && !this.error) {
      this.observer.unobserve(this.sentinel);
      this.observer.observe(this.sentinel);
    }
  }
}

const pagers = {};  // browse / favorites / wallpapers, created on DOMContentLoaded

function addEl(parent, tag, className) {
  const el = document.createElement(tag);
  el.className = className;
  parent.appendChild(el);
  return el;
}

/* ── Browse ────────────────────────────────────────────────────────────────── */
// Categories depend only on root+path, not on filters or search, and listing them
// walks the whole subtree — so they are refetched only when root/path changes
// (or the user presses "Открыть" again).
const catsCache = { key: null, list: [] };

async function fetchCategories() {
  const key = `${state.root}\n${state.path}`;
  if (catsCache.key !== key) {
    const res = await api(categoriesUrl());
    catsCache.key = key;
    catsCache.list = res.categories;
  }
  return catsCache.list;
}

// The folder listing is paged: the first page comes with the sidebar data, the
// next ones through pagers.browse. All pages of one listing use the same URL
// (filters frozen at the first page) + offset.
const browseView = { folders: 0, files: 0, candidates: 0 };

async function loadBrowse() {
  const seq = ++loadSeq;
  const url = browseUrl();
  pagers.browse.start(url);
  Object.assign(browseView, { folders: 0, files: 0, candidates: 0 });
  showContent("loading");
  try {
    const [data, categories] = await Promise.all([api(url), fetchCategories()]);
    if (seq !== loadSeq) return;
    state.rootResolved = data.root;  // absolute paths in responses start with it
    state.lastBrowse = { root: data.root, breadcrumbs: data.breadcrumbs, subfolders: data.subfolders };
    renderSidebar(data, categories);
    document.getElementById("folders-container").innerHTML = "";
    state.galleryItems = [];
    setupLazyLoad(true);
    showContent("folders-container");
    pagers.browse.accept(data);
  } catch (e) {
    if (seq !== loadSeq) return;
    showEmpty(`Ошибка: ${e.message}`);
    console.error(e);
  }
}

// One page of folders, appended below the cards already shown. A first page
// may be empty but still have more (the server hit its time budget while
// searching) — then the sentinel keeps loading until results show up.
function appendBrowsePage(data) {
  const container = document.getElementById("folders-container");
  // "+N ещё" in these cards must apply the same file filters as the listing
  const filesQuery = `&min_file_best=${state.bestFile}&search=${encodeURIComponent(state.search)}`;
  data.folders.forEach(f => { f.filesQuery = filesQuery; });

  if (state.mediaFilter === "videos") {
    renderVideosMode(data.folders, container);
  } else if (state.mediaFilter === "photos") {
    renderPhotosMode(data.folders, container);
  } else {
    renderAllMode(data.folders, container);
  }

  browseView.candidates = data.candidates;
  browseView.folders += data.folders.length;
  browseView.files += data.folders.reduce((s, f) => s + f.total_videos + f.total_images, 0);

  if (!pagers.browse.more && browseView.folders === 0) { showEmpty(); return; }
  updateResultCount();
  setupLazyLoad();
}

function updateResultCount() {
  // candidates = folders left after name-only filters; content filters can drop more
  const of = pagers.browse.more ? ` из ~${browseView.candidates}` : "";
  document.getElementById("result-count").textContent =
    `${browseView.folders}${of} папок · ${browseView.files} файлов`;
}

function showEmpty(message = "Ничего не найдено") {
  document.querySelector("#empty-state p").textContent = message;
  showContent("empty-state");
}

function showContent(id) {
  ["welcome", "loading", "folders-container", "empty-state"].forEach(s =>
    document.getElementById(s).classList.toggle("hidden", s !== id)
  );
  document.getElementById("load-more").classList.toggle(
    "hidden", id !== "folders-container" || !pagers.browse?.more);
  // toolbar скрываем только на приветственном экране и во время загрузки
  document.getElementById("toolbar").classList.toggle("hidden", id === "welcome" || id === "loading");
}

/* ── Sidebar ───────────────────────────────────────────────────────────────── */
function renderSidebar(data, categories) {
  document.getElementById("sidebar-empty").classList.add("hidden");
  document.getElementById("sidebar-content").classList.remove("hidden");

  // Breadcrumbs
  const bc = document.getElementById("breadcrumbs");
  bc.innerHTML = "";
  data.breadcrumbs.forEach((crumb, i) => {
    const el = document.createElement("span");
    el.className = "crumb" + (i === data.breadcrumbs.length - 1 ? " active" : "");
    el.textContent = crumb.name;
    if (i < data.breadcrumbs.length - 1) el.addEventListener("click", () => navigate(crumb.path));
    bc.appendChild(el);
    if (i < data.breadcrumbs.length - 1) {
      const sep = document.createElement("span");
      sep.className = "crumb-sep";
      sep.textContent = " / ";
      bc.appendChild(sep);
    }
  });

  // Subfolders tree
  const sfl   = document.getElementById("subfolders-list");
  const sfSec = document.getElementById("subfolders-section");
  sfl.innerHTML = "";

  if (!data.subfolders.length && !state.searchFolder.trim()) {
    sfSec.classList.add("hidden");
  } else {
    sfSec.classList.remove("hidden");
    if (state.searchFolder.trim()) {
      renderSearchTree(sfl);            // search mode: async, shows full paths
    } else {
      data.subfolders.forEach(sf => sfl.appendChild(buildTreeNode(sf, 0)));
    }
  }

  // Best section & star buttons
  document.getElementById("best-section").classList.remove("hidden");
  syncStarFilterButtons();

  // Categories
  const catList  = document.getElementById("categories-list");
  const catSec   = document.getElementById("categories-section");
  const catSearch = document.getElementById("cat-search");
  catList.innerHTML = "";
  // Store full list on the element for client-side filtering
  catList.dataset.allCats = JSON.stringify(categories);

  if (!categories.length) {
    catSec.classList.add("hidden");
  } else {
    catSec.classList.remove("hidden");
    // Keep the chips filtered by what's typed in the category search field —
    // clicking a chip reloads the sidebar and used to show the full list again
    const q = fold(catSearch.value.trim());
    renderCategoryChips(q ? categories.filter(c => fold(c).includes(q)) : categories, catList);
  }

  // Show/hide grid-list buttons (only in "all" mode)
  document.getElementById("view-mode-btns").classList.toggle("hidden", state.mediaFilter !== "all");
  // Show/hide photo controls (only in "photos" mode)
  document.getElementById("photo-controls").classList.toggle("hidden", state.mediaFilter !== "photos");
}

function buildTreeNode(sf, depth) {
  const wrap = document.createElement("div");
  wrap.className = "tree-node";

  const stars       = starsHtml(sf.best_level || 0);
  const isActive    = state.path === sf.path;
  const hasChildren = !!sf.has_children;

  // Highlight if matches folder search
  const searchQ = fold(state.searchFolder.trim());
  const isMatch = searchQ && fold(sf.name).includes(searchQ);

  const rowClass = [
    "tree-row",
    isActive ? "tree-row-active" : "",
    isMatch  ? "tree-row-match"  : "",
  ].filter(Boolean).join(" ");

  wrap.innerHTML = `
    <div class="${rowClass}" style="padding-left:${depth * 14 + 2}px">
      <button class="tree-expand" title="Раскрыть подпапки" style="visibility:${hasChildren ? "visible" : "hidden"}">
        <svg class="tree-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2.5">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </button>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0">
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
      </svg>
      <span class="tree-name" title="${escapeHtml(sf.path)}">${escapeHtml(sf.name)}</span>
      ${stars ? `<span class="stars tree-stars">${stars}</span>` : ""}
    </div>
    <div class="tree-children hidden"></div>`;

  const row       = wrap.querySelector(".tree-row");
  const expandBtn = wrap.querySelector(".tree-expand");
  const arrow     = wrap.querySelector(".tree-arrow");
  const children  = wrap.querySelector(".tree-children");

  // Navigate on row click
  row.addEventListener("click", e => {
    if (e.target.closest(".tree-expand")) return;
    navigate(sf.path);
  });

  // Expand/collapse
  if (hasChildren) {
    let loaded = false;
    let open   = false;

    expandBtn.addEventListener("click", async e => {
      e.stopPropagation();
      open = !open;
      arrow.style.transform = open ? "rotate(90deg)" : "";
      children.classList.toggle("hidden", !open);

      if (open && !loaded) {
        loaded = true;
        children.innerHTML = `<div class="tree-loading">···</div>`;
        try {
          const res = await api(
            `/api/children?root=${encodeURIComponent(state.root)}&path=${encodeURIComponent(sf.path)}`
          );
          children.innerHTML = "";
          if (res.children.length) {
            res.children.forEach(child => children.appendChild(buildTreeNode(child, depth + 1)));
          } else {
            children.innerHTML = `<div class="tree-empty">Нет подпапок</div>`;
          }
        } catch {
          children.innerHTML = "";
          loaded = false;
        }
      }
    });
  }

  return wrap;
}

// ── Search tree (full recursive folder search) ─────────────────────────────

async function renderSearchTree(container) {
  const seq = ++searchSeq;
  container.innerHTML = `<div class="tree-loading">Поиск...</div>`;
  let res;
  try {
    res = await api(
      `/api/search-folders?root=${encodeURIComponent(state.root)}&q=${encodeURIComponent(state.searchFolder)}`
    );
  } catch {
    if (seq === searchSeq) container.innerHTML = `<div class="tree-empty">Ошибка поиска</div>`;
    return;
  }
  if (seq !== searchSeq) return;

  container.innerHTML = "";
  if (!res.results.length) {
    container.innerHTML = `<div class="tree-empty">Папки не найдены</div>`;
    return;
  }

  // Build virtual tree from flat list of results with their path parts.
  // Intermediate folders (path context) are also added as non-match nodes.
  const nodeMap = new Map(); // pathKey → {name, path, isMatch, best_level, children:[]}

  res.results.forEach(r => {
    for (let i = 0; i < r.parts.length; i++) {
      const key = r.parts.slice(0, i + 1).join("/");
      if (!nodeMap.has(key)) {
        nodeMap.set(key, { name: r.parts[i], path: key, isMatch: false, best_level: 0, children: [] });
      }
      if (i === r.parts.length - 1) {
        nodeMap.get(key).isMatch = true;
        nodeMap.get(key).best_level = r.best_level;
      }
    }
    for (let i = 1; i < r.parts.length; i++) {
      const parentKey = r.parts.slice(0, i).join("/");
      const childKey  = r.parts.slice(0, i + 1).join("/");
      const parent = nodeMap.get(parentKey);
      const child  = nodeMap.get(childKey);
      if (parent && child && !parent.children.find(c => c.path === childKey)) {
        parent.children.push(child);
      }
    }
  });

  // Roots = nodes that are nobody's child
  const childKeys = new Set();
  nodeMap.forEach(n => n.children.forEach(c => childKeys.add(c.path)));
  const roots = [...nodeMap.values()].filter(n => !childKeys.has(n.path));

  function buildSearchNode(node, depth) {
    const el = document.createElement("div");
    el.className = "tree-node";
    el.innerHTML = `
      <div class="${node.isMatch ? "tree-row tree-row-match" : "tree-row tree-row-path"}"
           style="padding-left:${depth * 14 + 2}px">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
        </svg>
        <span class="tree-name">${escapeHtml(node.name)}</span>
        ${node.isMatch && node.best_level ? `<span class="stars tree-stars">${starsHtml(node.best_level)}</span>` : ""}
      </div>`;
    el.querySelector(".tree-row").addEventListener("click", () => navigate(node.path));
    if (node.children.length) {
      const cc = document.createElement("div");
      cc.className = "tree-children";
      node.children.forEach(child => cc.appendChild(buildSearchNode(child, depth + 1)));
      el.appendChild(cc);
    }
    return el;
  }

  roots.forEach(r => container.appendChild(buildSearchNode(r, 0)));

  const cnt = document.createElement("div");
  cnt.className = "tree-empty";
  cnt.textContent = `Найдено: ${res.results.length}`;
  container.appendChild(cnt);
}

function renderCategoryChips(categories, container) {
  container.innerHTML = "";
  categories.forEach(cat => {
    const chip = document.createElement("span");
    chip.className = "category-chip" + (state.categories.has(cat) ? " active" : "");
    chip.textContent = cat;
    chip.addEventListener("click", () => {
      state.categories.has(cat) ? state.categories.delete(cat) : state.categories.add(cat);
      load();
    });
    container.appendChild(chip);
  });
  if (!categories.length) {
    container.innerHTML = `<span style="font-size:12px;color:var(--text-mute)">Нет совпадений</span>`;
  }
}

function syncStarFilterButtons() {
  document.querySelectorAll(".star-filter-btn").forEach(btn => {
    const target = btn.dataset.target;
    const level  = parseInt(btn.dataset.level);
    const active = target === "folder" ? state.bestFolder === level : state.bestFile === level;
    btn.classList.toggle("active", active);
  });
}

/* ── All mode ──────────────────────────────────────────────────────────────── */
function renderAllMode(folders, container) {
  container.className = "folders-grid" + (state.viewMode === "list" ? " list-mode" : "");
  folders.forEach(folder => container.appendChild(buildCard(folder)));
}

/* ── Videos mode ───────────────────────────────────────────────────────────── */
function renderVideosMode(folders, container) {
  container.className = "videos-grid";
  folders.forEach(folder => {
    folder.videos.forEach(video => {
      container.appendChild(buildVideoCard(video, folder));
    });
  });
}

function buildVideoCard(video, folder) {
  const card = document.createElement("div");
  card.className = "video-card";

  const frames    = video.frames;            // [{url, idx, pos}, ...]
  const frameCount = frames.length;

  // Build dots HTML
  const dotsHtml = frames.map((_, i) =>
    `<div class="video-card-dot${i === 0 ? " active" : ""}"></div>`
  ).join("");

  card.innerHTML = `
    <div class="video-card-thumb">
      <img data-src="${escapeHtml(frames[0].url)}"
           data-src-file="${escapeHtml(video.path)}"
           data-idx="${frames[0].idx}"
           data-kind="video" alt="${escapeHtml(video.name)}">
      <div class="video-card-play">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="rgba(255,255,255,.9)" stroke="none">
          <polygon points="5 3 19 12 5 21"/>
        </svg>
      </div>
      <div class="video-card-progress"><div class="video-card-progress-fill"></div></div>
      <div class="video-card-dots">${dotsHtml}</div>
    </div>
    <div class="video-card-info">
      <div class="video-card-name" data-name-of="${escapeHtml(video.path)}" title="${escapeHtml(video.name)}">${escapeHtml(video.name)}</div>
      <div class="video-card-meta">
        <div class="video-card-folder" title="${escapeHtml(folder.path)}">📁 ${escapeHtml(folder.name)}</div>
        <div class="video-card-actions">
          <span class="js-stars"></span>
          <button class="card-open-btn" style="padding:3px 8px;font-size:11px" title="Открыть расположение">↗</button>
        </div>
      </div>
    </div>`;

  card.querySelector(".js-stars").replaceWith(starControl(video));

  const img          = card.querySelector("img");
  const progressFill = card.querySelector(".video-card-progress-fill");
  const dots         = card.querySelectorAll(".video-card-dot");
  const openBtn      = card.querySelector(".card-open-btn");

  // Cached urls per frame index
  const cachedUrls = new Array(frameCount).fill(null);
  cachedUrls[0] = frames[0].url; // will be set after lazy load

  // Store resolved url after thumb loads
  img.addEventListener("load", () => { cachedUrls[0] = img.src; });

  // Open location
  openBtn.addEventListener("click", e => { e.stopPropagation(); openLocation(video.path); });

  // Open modal
  const galleryIdx = state.galleryItems.length;
  state.galleryItems.push({ src: video.path, name: video.name, type: "video", item: video });
  card.querySelector(".video-card-thumb").addEventListener("click", () =>
    openModal("video", video.path, video.name, galleryIdx)
  );

  // Hover cycling
  let hoverInterval = null;
  let currentFrame  = 0;

  function setFrame(idx) {
    currentFrame = idx;
    const pct = frameCount > 1 ? (idx / (frameCount - 1)) * 100 : 0;
    progressFill.style.width = pct + "%";
    dots.forEach((d, i) => d.classList.toggle("active", i === idx));

    if (cachedUrls[idx]) {
      img.src = cachedUrls[idx];
    } else {
      // Generate on demand
      fetch(genThumbUrl(video.path, frames[idx].idx))
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (data?.url) {
            cachedUrls[idx] = data.url;
            if (currentFrame === idx) img.src = data.url;
          }
        }).catch(() => {});
    }
  }

  // Pre-generate all frames on first hover
  let preloaded = false;

  card.addEventListener("mouseenter", () => {
    if (frameCount <= 1) return;

    if (!preloaded) {
      preloaded = true;
      // Kick off generation for remaining frames in background
      frames.slice(1).forEach((frame, i) => {
        const idx = i + 1;
        fetch(genThumbUrl(video.path, frame.idx))
          .then(r => r.ok ? r.json() : null)
          .then(data => { if (data?.url) cachedUrls[idx] = data.url; })
          .catch(() => {});
      });
    }

    let frameIdx = 1;
    hoverInterval = setInterval(() => {
      setFrame(frameIdx % frameCount);
      frameIdx++;
    }, 700);
  });

  card.addEventListener("mouseleave", () => {
    clearInterval(hoverInterval);
    hoverInterval = null;
    setFrame(0);
  });

  return card;
}

/* ── Photos mode ───────────────────────────────────────────────────────────── */
function makeLargePhotoCell(imgData) {
  const natClass = state.naturalRatio ? " natural-ratio" : "";
  const cell = document.createElement("div");
  cell.className = `photo-large-cell${natClass}`;
  cell.innerHTML = `
    <img data-src="${escapeHtml(imageThumbUrl(imgData.path))}" data-kind="image" alt="${escapeHtml(imgData.name)}">
    <div class="photo-name-overlay" data-name-of="${escapeHtml(imgData.path)}">${escapeHtml(imgData.name)}</div>`;
  cell.prepend(starControl(imgData, { cls: "cell-stars" }));
  const galleryIdx = state.galleryItems.length;
  state.galleryItems.push({ src: imgData.path, name: imgData.name, type: "image", item: imgData });
  cell.addEventListener("click", () => openModal("image", imgData.path, imgData.name, galleryIdx));
  return cell;
}

// "+N ещё": a card comes with its first photos only; the rest are fetched from
// the server in batches, with the file filters of the listing the card came
// from (folder.filesQuery). A huge folder no longer arrives in one piece.
const SHOW_MORE_BATCH = 240;

function addShowMore(folder, grid, makeCell, cellClass, style = "") {
  let shown = folder.images.length;
  if (folder.synthetic || folder.total_images <= shown) return;
  const more = document.createElement("div");
  more.className = `show-more-btn ${cellClass}`;
  more.style.cssText = style;
  const label = () => { more.textContent = `+${folder.total_images - shown} ещё`; };
  label();
  let busy = false;
  more.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    more.textContent = "Загрузка…";
    try {
      const res = await api(`/api/folder-images?path=${encodeURIComponent(folder.path)}` +
                            `&offset=${shown}&limit=${SHOW_MORE_BATCH}${folder.filesQuery || ""}`);
      res.images.forEach(img => {
        folder.images.push(img);  // reachable from the folder (paths updated if it's renamed)
        grid.insertBefore(makeCell(img), more);
      });
      shown += res.images.length;
      folder.total_images = res.total;  // the folder may have changed since the listing
      if (!res.images.length || shown >= res.total) more.remove(); else label();
      setupLazyLoad();
    } catch (e) {
      more.textContent = "Ошибка — повторить";
      console.error(e);
    } finally {
      busy = false;
    }
  });
  grid.appendChild(more);
}

function renderPhotosMode(folders, container) {
  container.className = "photos-only-container";

  folders.forEach(folder => {
    if (!folder.images || !folder.images.length) return;

    const block = document.createElement("div");
    block.className = "photo-folder-block";

    // Synthetic blocks (single tagged photos from many folders) aren't a folder:
    // no stars, no path to retarget
    const real = !folder.synthetic;
    block.innerHTML = `
      <div class="photo-folder-block-header">
        <div>
          <div class="photo-folder-block-name">
            📁 <span${real ? ` data-name-of="${escapeHtml(folder.path)}"` : ""}>${escapeHtml(folder.name)}</span>
            <span class="js-stars"></span>
          </div>
          <div class="photo-folder-block-path"${real ? ` data-path-of="${escapeHtml(folder.path)}"` : ""}>${escapeHtml(folder.path)}</div>
        </div>
        <div class="photo-folder-block-meta">
          <span class="card-badge badge-photo">◼ ${folder.total_images} фото</span>
          <button class="card-open-btn" style="padding:4px 10px;font-size:12px" title="Открыть в Finder">↗</button>
        </div>
      </div>
      <div class="photos-large-grid"></div>`;

    const starsSlot = block.querySelector(".js-stars");
    if (real) starsSlot.replaceWith(starControl(folder, { isDir: true })); else starsSlot.remove();

    block.querySelector(".card-open-btn").addEventListener("click", e => {
      e.stopPropagation();
      openLocation(folder.path);
    });

    const grid = block.querySelector(".photos-large-grid");
    grid.className = `photos-large-grid size-${state.photoSize}${state.naturalRatio ? " natural-ratio-grid" : ""}`;

    folder.images.forEach(img => grid.appendChild(makeLargePhotoCell(img)));
    addShowMore(folder, grid, makeLargePhotoCell, "photo-large-cell",
                "font-size:14px;aspect-ratio:unset;height:60px");

    // Text files below the photo grid
    if (folder.texts && folder.texts.length) {
      const textsWrap = document.createElement("div");
      textsWrap.className = "photo-texts-wrap" + (state.showTexts ? "" : " hidden");
      folder.texts.forEach(txt => {
        const tb = document.createElement("div");
        tb.className = "text-block";
        tb.innerHTML = `
          <div class="text-block-header">
            <span class="text-block-name">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
              </svg>
              ${escapeHtml(txt.name)}
            </span>
            <span class="text-block-toggle">▾</span>
          </div>
          <div class="text-block-content">${escapeHtml(txt.content)}</div>`;
        tb.querySelector(".text-block-header").addEventListener("click", () =>
          tb.classList.toggle("collapsed")
        );
        textsWrap.appendChild(tb);
      });
      block.appendChild(textsWrap);
    }

    container.appendChild(block);
  });
}

/* ── Stars (rating) ────────────────────────────────────────────────────────── */
// Stars are part of the name: 0–3 trailing "_best". Clicking star N sets N
// stars (clicking the current level clears them); the server renames the file
// or folder and every place that shows it is updated in place — names, paths,
// thumbnails, gallery, other star controls of the same item.
function starControl(item, { isDir = false, cls = "" } = {}) {
  const el = document.createElement("span");
  el.className = `star-ctl ${cls}`;
  el.dataset.path = item.path;
  el.dataset.level = item.best_level || 0;
  if (isDir) el.dataset.dir = "1";
  el._item = item;  // the data object behind it (paths/levels kept in sync)
  renderStarCtl(el);
  el.addEventListener("click", e => {
    const btn = e.target.closest("button[data-n]");
    if (!btn) return;
    e.stopPropagation();  // a star click on a photo must not open it
    const n = +btn.dataset.n;
    setStars(el.dataset.path, +el.dataset.level === n ? 0 : n, isDir);
  });
  return el;
}

function renderStarCtl(el) {
  const lvl = +el.dataset.level;
  el.classList.toggle("has-stars", lvl > 0);
  el.innerHTML = [1, 2, 3].map(n =>
    `<button type="button" data-n="${n}" class="${n <= lvl ? "on" : ""}"
             title="${n === lvl ? "Убрать звёзды" : "★".repeat(n)}">${n <= lvl ? "★" : "☆"}</button>`
  ).join("");
}

let starsBusy = false;

async function setStars(path, level, isDir = false) {
  if (starsBusy) return null;  // one rename at a time: paths change under our feet
  starsBusy = true;
  // A playing video keeps its file open on the server (some disks then refuse
  // to rename it), and after the rename it would keep asking for the old name —
  // seeking broke. Let go of it now and resume it under the new name below.
  const held = releaseModalVideo(path);
  let newPath = path;
  try {
    const r = await fetch("/api/stars", {
      method: "POST",
      // The custom header is how the server tells this page from other sites
      headers: { "Content-Type": "application/json", "X-ContentChecker": "1" },
      body: JSON.stringify({ path, level }),
    });
    if (!r.ok) {
      let msg = `${r.status} ${r.statusText}`;
      try { msg = (await r.json()).detail || msg; } catch (_) {}
      toast(`Не удалось изменить звёзды: ${msg}`);
      return null;
    }
    const res = await r.json();  // {path, name, best_level}
    newPath = res.path;
    retarget(path, res.path);
    document.querySelectorAll(".star-ctl").forEach(c => {
      if (c.dataset.path !== res.path) return;
      c.dataset.level = res.best_level;
      if (c._item) Object.assign(c._item, { name: res.name, best_level: res.best_level });
      renderStarCtl(c);
    });
    state.galleryItems.forEach(g => { if (g.src === res.path) g.name = res.name; });
    if (isDir && res.path !== path) await afterFolderRename(path, res.path);
    return res;
  } catch (e) {
    toast(`Не удалось изменить звёзды: ${e.message}`);
    return null;
  } finally {
    if (held) resumeModalVideo(held, path, newPath);
    starsBusy = false;
  }
}

// Stops the modal's video if it is `path` or inside the folder `path`;
// returns what is needed to resume it, or null.
function releaseModalVideo(path) {
  const v = document.querySelector("#modal-body video");
  if (!v?.getAttribute("src")) return null;
  const src = new URL(v.src).searchParams.get("path");
  if (src !== path && !src.startsWith(path + "/")) return null;
  const held = { v, src, time: v.currentTime, paused: v.paused };
  stopModalVideo();
  return held;
}

function resumeModalVideo({ v, src, time, paused }, oldPath, newPath) {
  if (!v.isConnected) return;  // the modal moved on meanwhile
  const moved = src === oldPath ? newPath : newPath + src.slice(oldPath.length);
  v.autoplay = !paused;
  v.src = `/file?path=${encodeURIComponent(moved)}`;
  v.currentTime = time;  // before metadata arrives = start position
}

// After a rename, point everything that referenced the old path — or, for a
// folder, anything inside it — at the new one.
function retarget(oldPath, newPath) {
  if (oldPath === newPath) return;
  const re = p => typeof p !== "string" ? p
    : p === oldPath ? newPath
    : p.startsWith(oldPath + "/") ? newPath + p.slice(oldPath.length) : p;

  // Data objects behind the cards (click handlers read paths from them)
  const seen = new Set();
  const fix = obj => {
    if (!obj || typeof obj !== "object" || seen.has(obj)) return;
    seen.add(obj);
    obj.path = re(obj.path);
    if (obj.folder_path) obj.folder_path = re(obj.folder_path);
    if ("rel" in obj && state.rootResolved && obj.path.startsWith(state.rootResolved + "/")) {
      obj.rel = obj.path.slice(state.rootResolved.length + 1);
    }
    ["images", "videos", "texts"].forEach(k => obj[k]?.forEach(fix));
  };
  document.querySelectorAll(".star-ctl").forEach(c => {
    c.dataset.path = re(c.dataset.path);
    fix(c._item);
  });
  state.galleryItems.forEach(g => { g.src = re(g.src); fix(g.item); });

  // Attributes baked into the HTML
  document.querySelectorAll("[data-src-file]").forEach(el => { el.dataset.srcFile = re(el.dataset.srcFile); });
  document.querySelectorAll('img[data-kind="image"][data-src]').forEach(img => {
    const src = new URL(img.dataset.src, location.href).searchParams.get("src");
    const moved = re(src);
    if (moved !== src) img.dataset.src = imageThumbUrl(moved);
  });
  document.querySelectorAll("[data-name-of]").forEach(el => {
    const moved = re(el.dataset.nameOf);
    if (moved === el.dataset.nameOf) return;
    el.dataset.nameOf = moved;
    el.textContent = moved.split("/").pop();
    if (el.title) el.title = el.textContent;
  });
  document.querySelectorAll("[data-path-of]").forEach(el => {
    const moved = re(el.dataset.pathOf);
    if (moved !== el.dataset.pathOf) { el.dataset.pathOf = moved; el.textContent = moved; }
  });
  const title = document.getElementById("modal-title");
  if (title.dataset.path) {
    const moved = re(title.dataset.path);
    if (moved !== title.dataset.path) { title.dataset.path = moved; title.textContent = moved.split("/").pop(); }
  }
}

// A renamed folder also changes the sidebar (tree, categories) and, if it is
// the current folder or one of its parents, the current location itself.
async function afterFolderRename(oldPath, newPath) {
  catsCache.key = null;
  const root = state.rootResolved;
  const cur = state.path ? `${root}/${state.path}` : root;
  if (root && (cur === oldPath || cur.startsWith(oldPath + "/"))) {
    if (root === oldPath || root.startsWith(oldPath + "/")) {
      state.root = newPath + root.slice(oldPath.length);
      document.getElementById("root-input").value = state.root;
    } else {
      state.path = (newPath + cur.slice(oldPath.length)).slice(root.length + 1);
    }
    await load();
    return;
  }
  if (state.page !== "browse" || !state.lastBrowse) return;
  try {
    const [kids, cats] = await Promise.all([
      api(`/api/children?root=${encodeURIComponent(state.root)}&path=${encodeURIComponent(state.path)}`),
      fetchCategories(),
    ]);
    renderSidebar({ ...state.lastBrowse, subfolders: kids.children }, cats);
  } catch (e) {
    console.error(e);
  }
}

function toast(message) {
  let t = document.getElementById("toast");
  if (!t) {
    t = addEl(document.body, "div", "toast");
    t.id = "toast";
  }
  t.textContent = message;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 4000);
}

/* ── Standard card (All mode) ──────────────────────────────────────────────── */
function starsHtml(level) {
  return "★".repeat(Math.max(0, Math.min(3, level)));
}

function buildCard(folder) {
  const card = document.createElement("div");
  card.className = "folder-card";

  const hasVideos = folder.videos.length > 0;
  const hasPhotos = folder.images.length > 0;
  const hasTexts  = folder.texts.length > 0;

  const badges = [
    `<span class="js-stars"></span>`,
    hasVideos ? `<span class="card-badge badge-video">▶ ${folder.total_videos} видео</span>` : "",
    hasPhotos ? `<span class="card-badge badge-photo">◼ ${folder.total_images} фото</span>` : "",
    hasTexts  ? `<span class="card-badge badge-text">✎ ${folder.texts.length} текст</span>` : "",
  ].join("");

  card.innerHTML = `
    <div class="card-header">
      <div class="card-header-info">
        <div class="card-folder-name">📁 <span data-name-of="${escapeHtml(folder.path)}">${escapeHtml(folder.name)}</span></div>
        <div class="card-folder-path" data-path-of="${escapeHtml(folder.path)}">${escapeHtml(folder.path)}</div>
        <div class="card-meta">${badges}</div>
      </div>
      <div class="card-header-actions">
        <button class="card-nav-btn" title="Перейти в эту папку">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
          В папку
        </button>
        <button class="card-open-btn" title="Открыть в Finder/Explorer">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
            <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
          </svg>
          Открыть
        </button>
      </div>
    </div>`;

  card.querySelector(".js-stars").replaceWith(starControl(folder, { isDir: true, cls: "badge-stars" }));

  card.querySelector(".card-nav-btn").addEventListener("click", e => {
    e.stopPropagation();
    navigate(folder.rel);
  });
  card.querySelector(".card-open-btn").addEventListener("click", e => {
    e.stopPropagation();
    openLocation(folder.path);
  });

  // Videos
  folder.videos.forEach(video => {
    const sec = document.createElement("div");
    sec.className = "card-section";
    sec.innerHTML = `
      <div class="card-section-label">
        🎬 <span class="filename" data-name-of="${escapeHtml(video.path)}">${escapeHtml(video.name)}</span>
        <span class="js-stars"></span>
        <button class="card-open-btn" style="margin-left:auto;padding:3px 8px;font-size:10.5px"
                title="Открыть файл">↗</button>
      </div>
      <div class="frames-strip"></div>`;

    sec.querySelector(".js-stars").replaceWith(starControl(video));
    sec.querySelector(".card-open-btn").addEventListener("click", e => {
      e.stopPropagation(); openLocation(video.path);
    });

    // One gallery entry per video: every frame opens the same item
    const galleryIdx = state.galleryItems.length;
    state.galleryItems.push({ src: video.path, name: video.name, type: "video", item: video });

    const strip = sec.querySelector(".frames-strip");
    video.frames.forEach(frame => {
      const cell = document.createElement("div");
      cell.className = "thumb-cell";
      cell.innerHTML = `
        <div class="thumb-placeholder">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="2" y="4" width="20" height="16" rx="2"/><polygon points="10 8 16 12 10 16"/>
          </svg>
        </div>
        <div class="thumb-play">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="white" stroke="none"><polygon points="5 3 19 12 5 21"/></svg>
        </div>
        <img data-src="${escapeHtml(frame.url)}" data-src-file="${escapeHtml(video.path)}"
             data-idx="${frame.idx}" data-kind="video" alt="">`;

      cell.addEventListener("click", () => openModal("video", video.path, video.name, galleryIdx));
      strip.appendChild(cell);
    });

    card.appendChild(sec);
  });

  // Photos (the first ones; "+N ещё" fetches the rest)
  if (folder.images.length) {
    const sec = document.createElement("div");
    sec.className = "card-section";
    sec.innerHTML = `<div class="card-section-label">🖼 Фотографии</div><div class="photos-grid"></div>`;
    const grid = sec.querySelector(".photos-grid");

    const makePhotoCell = img => {
      const cell = document.createElement("div");
      cell.className = "photo-cell";
      cell.style.position = "relative";
      cell.innerHTML = `
        <img data-src="${escapeHtml(imageThumbUrl(img.path))}" data-kind="image" alt="${escapeHtml(img.name)}">`;
      cell.prepend(starControl(img, { cls: "cell-stars" }));
      const idx = state.galleryItems.length;
      state.galleryItems.push({ src: img.path, name: img.name, type: "image", item: img });
      cell.addEventListener("click", () => openModal("image", img.path, img.name, idx));
      return cell;
    };

    folder.images.forEach(img => grid.appendChild(makePhotoCell(img)));
    addShowMore(folder, grid, makePhotoCell, "photo-cell");

    card.appendChild(sec);
  }

  // Texts
  if (folder.texts.length) {
    const sec = document.createElement("div");
    sec.className = "card-section";
    sec.innerHTML = `<div class="card-section-label">📄 Текстовые файлы</div>`;
    folder.texts.forEach(txt => {
      const block = document.createElement("div");
      block.className = "text-block";
      block.innerHTML = `
        <div class="text-block-header">
          <span class="text-block-name">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
            </svg>
            ${escapeHtml(txt.name)}
          </span>
          <span class="text-block-toggle">▾</span>
        </div>
        <div class="text-block-content">${escapeHtml(txt.content)}</div>`;
      block.querySelector(".text-block-header").addEventListener("click", () =>
        block.classList.toggle("collapsed")
      );
      sec.appendChild(block);
    });
    card.appendChild(sec);
  }

  return card;
}

/* ── Lazy thumbnail loading ────────────────────────────────────────────────── */
let observer = null;

// Starts watching images added since the last call. reset=true after the content
// was replaced wholesale (drops the old, now detached, images). Appending a page
// or "+N ещё" must not reset: re-observing every image on each page made paging
// quadratic, and re-loading visible ones re-requested frames.
// A thumbnail loads only after staying near the screen for LAZY_DWELL_MS:
// flicking through a long list used to start a frame extraction for every
// video it passed (180 frames for 15 left on screen), which kept the CPU busy
// for minutes and queued the player's own requests behind them.
const LAZY_DWELL_MS = 150;

function setupLazyLoad(reset = false) {
  if (reset || !observer) {
    observer?.disconnect();
    const obs = observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        const img = entry.target;
        if (!entry.isIntersecting) {
          clearTimeout(img._lazyTimer);
          img._lazyTimer = null;
          return;
        }
        img._lazyTimer ??= setTimeout(() => {
          img._lazyTimer = null;
          if (observer !== obs || !img.isConnected) return;  // content was replaced
          obs.unobserve(img);
          img.dataset.lazy = "started";
          loadThumb(img);
        }, LAZY_DWELL_MS);
      });
    }, { rootMargin: "150px" });
  }
  document.querySelectorAll("img[data-src]:not([data-lazy])").forEach(img => {
    img.dataset.lazy = "observed";
    observer.observe(img);
  });
}

function loadThumb(img) {
  const kind = img.dataset.kind;

  if (kind !== "video") {
    // Images: URL is /api/thumb?src=... — server resizes on-the-fly, browser caches.
    img.src = img.dataset.src;
    img.onload = () => {
      img.classList.add("loaded");
      img.parentElement?.querySelector(".thumb-placeholder")?.style.setProperty("display", "none");
    };
    return;
  }

  // Videos: try disk-cached /thumb/xxx.jpg, generate frame if missing.
  const url = img.dataset.src;
  const test = new Image();
  test.onload = () => {
    img.src = url;
    img.classList.add("loaded");
    img.parentElement?.querySelector(".thumb-placeholder")?.style.setProperty("display", "none");
  };
  test.onerror = async () => {
    try {
      const res = await fetch(genThumbUrl(img.dataset.srcFile, img.dataset.idx));
      if (res.ok) {
        const data = await res.json();
        img.src = data.url;
        img.classList.add("loaded");
        img.parentElement?.querySelector(".thumb-placeholder")?.style.setProperty("display", "none");
      }
    } catch (_) {}
  };
  test.src = url;
}

/* ── Favorites & Wallpapers ────────────────────────────────────────────────── */
// Tagged folders and files, page by page. The server sends all folders first,
// then videos, then photos, so every page is appended to the section in
// progress. Star level / media filters are applied by the server; changing them
// reuses the last tree walk (fresh=0), opening the tab re-walks (fresh=1).
const TAG_VIEWS = {
  favorites: {
    area: "fav-area", list: "fav-list", count: "fav-count", badge: "fav-badge",
    photoControls: "fav-photo-controls",
    labels: { icon: "★", folders: "Избранные папки", videos: "Избранные видео", photos: "Избранные фото" },
    media: () => state.favMediaFilter,
    url: () => `/api/favorites?root=${encodeURIComponent(state.root)}` +
               `&level=${state.favLevel}&media=${state.favMediaFilter}`,
    loadingText: "Загрузка избранного...",
    emptyHtml: `
      <div class="empty-state" style="height:300px">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
        </svg>
        <p>Нет файлов/папок с пометкой _best</p>
        <p style="font-size:12px;color:var(--text-mute)">Добавьте суффикс _best к именам файлов или папок</p>
      </div>`,
  },
  wallpapers: {
    area: "wallpaper-area", list: "wp-list", count: "wp-count", badge: "wp-badge",
    photoControls: "wp-photo-controls",
    labels: { icon: "🖼", folders: "Папки с обоями", videos: "Видео-обои", photos: "Обои" },
    media: () => state.wpMediaFilter,
    url: () => `/api/wallpapers?root=${encodeURIComponent(state.root)}&media=${state.wpMediaFilter}`,
    loadingText: "Загрузка обоев...",
    emptyHtml: `
      <div class="empty-state" style="height:300px">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <path d="M21 15l-5-5L5 21"/>
        </svg>
        <p>Нет файлов/папок с пометкой _wallpaper</p>
        <p style="font-size:12px;color:var(--text-mute)">Добавьте _wallpaper к имени файла или папки</p>
      </div>`,
  },
};

async function loadTagView(name, fresh = true) {
  const v = TAG_VIEWS[name];
  document.getElementById(v.area).classList.remove("hidden");
  document.getElementById("content-area").classList.add("hidden");
  document.getElementById(v.photoControls).classList.toggle("hidden", v.media() !== "photos");

  const list = document.getElementById(v.list);
  list.innerHTML = `<div class="loading"><div class="spinner"></div><p>${v.loadingText}</p></div>`;
  const url = v.url();
  pagers[name].start(url);
  const seq = ++loadSeq;
  try {
    const data = await api(url + (fresh ? "&fresh=1" : ""));
    if (seq !== loadSeq) return;
    state.rootResolved = data.root;

    const badge = document.getElementById(v.badge);
    badge.textContent = data.total;
    badge.classList.toggle("hidden", !data.total);
    const c = data.counts;
    document.getElementById(v.count).textContent = `${c.folders} папок · ${c.videos + c.photos} файлов`;

    if (!data.total) { list.innerHTML = v.emptyHtml; return; }
    list.innerHTML = "";
    state.galleryItems = [];
    v.ctx = { counts: c, shown: 0 };  // sections are created when their first item arrives
    setupLazyLoad(true);
    pagers[name].accept(data);
  } catch (e) {
    if (seq === loadSeq) list.innerHTML = `<div class="empty-state"><p>Ошибка: ${escapeHtml(e.message)}</p></div>`;
  }
}

function appendTagPage(name, data) {
  const v = TAG_VIEWS[name];
  const ctx = v.ctx;
  const l = v.labels;
  const list = document.getElementById(v.list);
  const mf = v.media();

  for (const item of data.items) {
    ctx.shown++;
    const isFolder = item.kind === "folder";
    if (mf === "videos") {
      const grid = ctx.videoGrid ??= addEl(list, "div", "videos-grid");
      if (isFolder) item.videos.forEach(video => grid.appendChild(buildVideoCard(video, item)));
      else grid.appendChild(buildVideoCard(fileToVideo(item), fileToFolder(item)));
    } else if (mf === "photos") {
      const wrap = ctx.photoWrap ??= addEl(list, "div", "photos-only-container");
      if (isFolder) renderPhotosMode([item], wrap);
      else appendLoosePhoto(ctx, wrap, item, l.photos);
    } else if (isFolder) {
      (ctx.folderGrid ??= addSection(list, `${l.icon} ${l.folders}`, ctx.counts.folders, "folders-grid"))
        .appendChild(buildCard(item));
    } else if (item.type === "video") {
      (ctx.videoGrid ??= addSection(list, `${l.icon} ${l.videos}`, ctx.counts.videos, "videos-grid"))
        .appendChild(buildVideoCard(fileToVideo(item), fileToFolder(item)));
    } else {
      const wrap = ctx.photoWrap ??= addSection(list, `${l.icon} ${l.photos}`, ctx.counts.photos, "photos-only-container");
      appendLoosePhoto(ctx, wrap, item, l.photos);
    }
  }

  if (!pagers[name].more && ctx.shown === 0) {
    list.innerHTML = `<div class="empty-state" style="height:200px"><p>Нет результатов для выбранного фильтра</p></div>`;
  }
  setupLazyLoad();
}

// Section with a title and a grid; returns the grid
function addSection(list, title, count, gridClass) {
  const sec = addEl(list, "div", "");
  sec.innerHTML = `<div class="fav-section-title">${title} <span class="count">(${count})</span></div>`;
  return addEl(sec, "div", gridClass);
}

// Single tagged photos share one block; it's created with the first of them
function appendLoosePhoto(ctx, wrap, file, label) {
  if (ctx.looseGrid) {
    ctx.looseGrid.appendChild(makeLargePhotoCell(file));
    return;
  }
  renderPhotosMode([makeSynthFolder(label, [file], ctx.counts.photos)], wrap);
  ctx.looseGrid = wrap.lastElementChild.querySelector(".photos-large-grid");
}

// ── Helpers: convert individual tagged file to video/folder objects ─────────
function fileToVideo(file) {
  return {
    name: file.name,
    path: file.path,
    best_level: file.best_level,
    frames: file.frames,  // one frame, from the server
  };
}

function fileToFolder(file) {
  return { name: file.folder_name, path: file.folder_path };
}

function makeSynthFolder(name, imageFiles, total = imageFiles.length) {
  const images = imageFiles.map(f => ({
    name: f.name,
    path: f.path,
    best_level: f.best_level,
  }));
  return {
    name,
    path: imageFiles[0]?.folder_path || "",
    best_level: 0,
    images,
    total_images: total,
    synthetic: true,  // photos from different folders: no "+N ещё"
    texts: [],
  };
}

/* ── Modal ─────────────────────────────────────────────────────────────────── */
const BROWSER_UNSUPPORTED_IMG = /\.(heic|heif|tiff?)$/i;

function openModal(type, src, name, galleryIdx) {
  state.galleryIdx = galleryIdx;
  renderModal(type, src, name);
  document.getElementById("modal").classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function renderModal(type, src, name) {
  const title = document.getElementById("modal-title");
  title.textContent = name;
  title.dataset.path = src;  // kept in sync if the item gets renamed (stars)
  // The current path, not `src`: the item may get renamed while shown (stars)
  document.getElementById("modal-open").onclick = () => openLocation(title.dataset.path);

  // Stars of the shown item; the control shares the data object with the card
  const g = state.galleryItems[state.galleryIdx];
  const item = g?.src === src && g.item ? g.item : { path: src, name, best_level: 0 };
  const slot = document.getElementById("modal-stars");
  slot.innerHTML = "";
  slot.appendChild(starControl(item, { cls: "modal-stars" }));

  const body = document.getElementById("modal-body");
  stopModalVideo();
  body.innerHTML = "";

  if (type === "video") {
    const v = document.createElement("video");
    v.src = `/file?path=${encodeURIComponent(src)}`;
    v.controls = true;
    v.autoplay = true;
    // AVI, WMV, FLV and some MKV can't be played by browsers: say so instead
    // of leaving an empty player
    v.addEventListener("error", () => {
      if (!v.isConnected || !v.getAttribute("src")) return;  // already replaced/stopped
      const ext = (src.split(".").pop() || "").toUpperCase();
      // Only format/decoding errors mean "unsupported"; a failed download
      // (file moved, disk unplugged, server stopped) is something else
      const unsupported = v.error?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
                       || v.error?.code === MediaError.MEDIA_ERR_DECODE;
      body.innerHTML = `
        <div class="modal-unsupported">
          ${unsupported
            ? `<p>Браузер не умеет воспроизводить этот файл (${escapeHtml(ext)}).</p>
               <p>Откройте его в видеоплеере, например IINA или VLC.</p>`
            : `<p>Не удалось загрузить видео.</p>
               <p>Возможно, файл переместили или диск отключён.</p>`}
          <button class="btn-primary">Показать в Finder</button>
        </div>`;
      body.querySelector("button").addEventListener("click", () => openLocation(title.dataset.path));
    });
    body.appendChild(v);
  } else {
    const img = document.createElement("img");
    // Browsers (except Safari) can't render HEIC/TIFF — ask the server for a JPEG
    img.src = BROWSER_UNSUPPORTED_IMG.test(src)
      ? `/api/thumb?src=${encodeURIComponent(src)}&max=2560`
      : `/file?path=${encodeURIComponent(src)}`;
    body.appendChild(img);
  }

  const nav = document.getElementById("modal-nav");
  if (state.galleryItems.length > 1) {
    nav.classList.remove("hidden");
    updateModalNav();
  } else {
    nav.classList.add("hidden");
  }
}

function updateModalNav() {
  const { galleryIdx, galleryItems } = state;
  document.getElementById("modal-counter").textContent = `${galleryIdx + 1} / ${galleryItems.length}`;
  document.getElementById("modal-prev").disabled = galleryIdx === 0;
  document.getElementById("modal-next").disabled = galleryIdx === galleryItems.length - 1;
}

function closeModal() {
  document.getElementById("modal").classList.add("hidden");
  document.body.style.overflow = "";
  stopModalVideo();
}

// Pausing alone left the browser downloading the file after the modal was
// closed or switched to the next item; dropping src stops the transfer.
function stopModalVideo() {
  document.querySelectorAll("#modal-body video").forEach(v => {
    v.pause();
    v.removeAttribute("src");
    v.load();
  });
}

/* ── Navigation ────────────────────────────────────────────────────────────── */
function navigate(path) {
  state.path = path;
  state.categories.clear();
  load();
}

async function openLocation(path) {
  try { await fetch(`/api/open?path=${encodeURIComponent(path)}`); } catch (_) {}
}

function switchPage(page) {
  state.page = page;
  document.querySelectorAll(".tab-btn").forEach(btn =>
    btn.classList.toggle("active", btn.dataset.tab === page)
  );
  const isBrowse = page === "browse";
  const isFav    = page === "favorites";
  const isWp     = page === "wallpapers";
  document.getElementById("content-area").classList.toggle("hidden", !isBrowse);
  document.getElementById("toolbar").classList.toggle("hidden", !isBrowse);
  document.getElementById("fav-area").classList.toggle("hidden", !isFav);
  document.getElementById("wallpaper-area").classList.toggle("hidden", !isWp);
  document.getElementById("best-section")?.classList.toggle("hidden", !isBrowse);
  load();
}

/* ── Utils ─────────────────────────────────────────────────────────────────── */
// Every file/folder name or path inserted via innerHTML must go through this:
// names come from disk and may contain <, ", & (or a malicious payload).
function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Same as fold() on the server: one Unicode form ("й" typed vs "и"+breve in
// names from macOS disks) and lower case, so name matching works for both
function fold(s) {
  return s.normalize("NFC").toLowerCase();
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* ── Event wiring ──────────────────────────────────────────────────────────── */
document.addEventListener("DOMContentLoaded", () => {
  const rootInput   = document.getElementById("root-input");
  const loadBtn     = document.getElementById("load-btn");
  const searchInput = document.getElementById("search-input");
  const flatToggle  = document.getElementById("flat-toggle");
  const btnGrid     = document.getElementById("btn-grid");
  const btnList     = document.getElementById("btn-list");
  const modalClose  = document.getElementById("modal-close");
  const modalPrev   = document.getElementById("modal-prev");
  const modalNext   = document.getElementById("modal-next");
  const clearCats   = document.getElementById("clear-cats");

  if (state.root) rootInput.value = state.root;

  loadBtn.addEventListener("click", () => {
    state.root = rootInput.value.trim();
    state.path = "";
    state.categories.clear();
    catsCache.key = null;  // "Открыть" also works as "refresh from disk"
    load();
  });
  rootInput.addEventListener("keydown", e => { if (e.key === "Enter") loadBtn.click(); });

  searchInput.addEventListener("input", debounce(e => {
    state.search = e.target.value;
    load();
  }, 300));

  // "Во всех подпапках": file search through the whole subtree of the current
  // folder (otherwise only the folder itself and its direct subfolders)
  const searchDeep = document.getElementById("search-deep");
  searchDeep.checked = state.searchDeep;
  searchDeep.addEventListener("change", () => {
    state.searchDeep = searchDeep.checked;
    localStorage.setItem("cc_search_deep", state.searchDeep ? "1" : "0");
    if (state.search.trim()) load();  // without a query the listing doesn't change
  });

  flatToggle.addEventListener("change", e => { state.flat = e.target.checked; load(); });

  btnGrid.addEventListener("click", () => {
    state.viewMode = "grid";
    btnGrid.classList.add("active");
    btnList.classList.remove("active");
    document.getElementById("folders-container").classList.remove("list-mode");
  });
  btnList.addEventListener("click", () => {
    state.viewMode = "list";
    btnList.classList.add("active");
    btnGrid.classList.remove("active");
    document.getElementById("folders-container").classList.add("list-mode");
  });

  // Media filter
  document.querySelectorAll(".media-filter-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".media-filter-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      state.mediaFilter = btn.dataset.filter;
      document.getElementById("view-mode-btns").classList.toggle("hidden", state.mediaFilter !== "all");
      document.getElementById("photo-controls").classList.toggle("hidden", state.mediaFilter !== "photos");
      load();
    });
  });

  // Photo size buttons
  document.querySelectorAll(".size-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".size-btn, .fav-size-btn, .wp-size-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(`.size-btn[data-size="${btn.dataset.size}"], .fav-size-btn[data-size="${btn.dataset.size}"], .wp-size-btn[data-size="${btn.dataset.size}"]`)
        .forEach(b => b.classList.add("active"));
      state.photoSize = btn.dataset.size;
      // Re-apply size class to all grids without full reload
      document.querySelectorAll(".photos-large-grid").forEach(grid => {
        grid.classList.remove("size-small", "size-medium", "size-large");
        grid.classList.add("size-" + state.photoSize);
      });
    });
  });

  // Natural ratio toggle
  const ratioBtn   = document.getElementById("ratio-btn");
  const ratioLabel = document.getElementById("ratio-label");
  ratioBtn.addEventListener("click", () => {
    state.naturalRatio = !state.naturalRatio;
    const label = state.naturalRatio ? "Авто" : "1:1";
    ["ratio-btn", "fav-ratio-btn", "wp-ratio-btn"].forEach(id =>
      document.getElementById(id)?.classList.toggle("active", state.naturalRatio)
    );
    ["ratio-label", "fav-ratio-label", "wp-ratio-label"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = label;
    });
    document.querySelectorAll(".photos-large-grid").forEach(grid => {
      grid.classList.toggle("natural-ratio-grid", state.naturalRatio);
    });
    document.querySelectorAll(".photo-large-cell").forEach(cell => {
      cell.classList.toggle("natural-ratio", state.naturalRatio);
    });
  });

  const showTextsBtn   = document.getElementById("show-texts-btn");
  showTextsBtn.addEventListener("click", () => {
    state.showTexts = !state.showTexts;
    ["show-texts-btn", "fav-show-texts-btn", "wp-show-texts-btn"].forEach(id =>
      document.getElementById(id)?.classList.toggle("active", state.showTexts)
    );
    document.querySelectorAll(".photo-texts-wrap").forEach(w => {
      w.classList.toggle("hidden", !state.showTexts);
    });
  });

  clearCats.addEventListener("click", () => {
    state.categories.clear();
    document.getElementById("cat-search").value = "";
    load();
  });

  // Folder name search (sidebar)
  const folderSearchInput = document.getElementById("folder-search");
  const folderSearchClear = document.getElementById("folder-search-clear");

  folderSearchInput.addEventListener("input", debounce(e => {
    state.searchFolder = e.target.value;
    folderSearchClear.classList.toggle("hidden", !e.target.value);
    load();
  }, 280));

  folderSearchClear.addEventListener("click", () => {
    folderSearchInput.value = "";
    state.searchFolder = "";
    folderSearchClear.classList.add("hidden");
    folderSearchInput.focus();
    load();
  });

  // Category search (client-side filter of chips)
  const catSearchInput = document.getElementById("cat-search");
  const catSearchClear = document.getElementById("cat-search-clear");

  catSearchInput.addEventListener("input", e => {
    const q = fold(e.target.value.trim());
    catSearchClear.classList.toggle("hidden", !e.target.value);
    const catList = document.getElementById("categories-list");
    const all = JSON.parse(catList.dataset.allCats || "[]");
    const filtered = q ? all.filter(c => fold(c).includes(q)) : all;
    renderCategoryChips(filtered, catList);
  });

  catSearchClear.addEventListener("click", () => {
    catSearchInput.value = "";
    catSearchClear.classList.add("hidden");
    catSearchInput.focus();
    const catList = document.getElementById("categories-list");
    const all = JSON.parse(catList.dataset.allCats || "[]");
    renderCategoryChips(all, catList);
  });

  // Star filter buttons
  document.addEventListener("click", e => {
    const btn = e.target.closest(".star-filter-btn");
    if (!btn) return;
    const target = btn.dataset.target;
    const level  = parseInt(btn.dataset.level);
    if (target === "folder") state.bestFolder = level;
    else state.bestFile = level;
    syncStarFilterButtons();
    load();
  });

  // Tabs
  document.querySelectorAll(".tab-btn").forEach(btn =>
    btn.addEventListener("click", () => switchPage(btn.dataset.tab))
  );

  // Favorites level filter
  document.querySelectorAll(".fav-level-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".fav-level-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      state.favLevel = parseInt(btn.dataset.exact || "0");
      loadTagView("favorites", false);  // filters reuse the last tree walk
    });
  });

  // Favorites media filter (all / videos / photos)
  document.querySelectorAll("[data-fav-filter]").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-fav-filter]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      state.favMediaFilter = btn.dataset.favFilter;
      loadTagView("favorites", false);
    });
  });

  // Wallpapers media filter (all / videos / photos)
  document.querySelectorAll("[data-wp-filter]").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-wp-filter]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      state.wpMediaFilter = btn.dataset.wpFilter;
      loadTagView("wallpapers", false);
    });
  });

  // Photo size buttons across all pages (share state.photoSize)
  document.querySelectorAll(".fav-size-btn, .wp-size-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".fav-size-btn, .wp-size-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".size-btn").forEach(b =>
        b.classList.toggle("active", b.dataset.size === btn.dataset.size)
      );
      btn.classList.add("active");
      state.photoSize = btn.dataset.size;
      document.querySelectorAll(".photos-large-grid").forEach(g => {
        g.className = `photos-large-grid size-${state.photoSize}${state.naturalRatio ? " natural-ratio-grid" : ""}`;
      });
    });
  });

  // Ratio toggle across all pages (shares state.naturalRatio)
  function toggleRatio() {
    state.naturalRatio = !state.naturalRatio;
    const label = state.naturalRatio ? "Авто" : "1:1";
    ["ratio-btn", "fav-ratio-btn", "wp-ratio-btn"].forEach(id =>
      document.getElementById(id)?.classList.toggle("active", state.naturalRatio)
    );
    ["ratio-label", "fav-ratio-label", "wp-ratio-label"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = label;
    });
    document.querySelectorAll(".photos-large-grid").forEach(g =>
      g.classList.toggle("natural-ratio-grid", state.naturalRatio)
    );
    document.querySelectorAll(".photo-large-cell").forEach(c =>
      c.classList.toggle("natural-ratio", state.naturalRatio)
    );
  }
  document.getElementById("fav-ratio-btn").addEventListener("click", toggleRatio);
  document.getElementById("wp-ratio-btn").addEventListener("click", toggleRatio);

  // Texts toggle across all pages (shares state.showTexts)
  function toggleTexts() {
    state.showTexts = !state.showTexts;
    ["show-texts-btn", "fav-show-texts-btn", "wp-show-texts-btn"].forEach(id =>
      document.getElementById(id)?.classList.toggle("active", state.showTexts)
    );
    document.querySelectorAll(".photo-texts-wrap").forEach(w =>
      w.classList.toggle("hidden", !state.showTexts)
    );
  }
  document.getElementById("fav-show-texts-btn").addEventListener("click", toggleTexts);
  document.getElementById("wp-show-texts-btn").addEventListener("click", toggleTexts);

  // Modal
  modalClose.addEventListener("click", closeModal);
  document.getElementById("modal-backdrop").addEventListener("click", closeModal);

  modalPrev.addEventListener("click", () => {
    if (state.galleryIdx > 0) {
      state.galleryIdx--;
      const item = state.galleryItems[state.galleryIdx];
      renderModal(item.type, item.src, item.name);
    }
  });
  modalNext.addEventListener("click", () => {
    if (state.galleryIdx < state.galleryItems.length - 1) {
      state.galleryIdx++;
      const item = state.galleryItems[state.galleryIdx];
      renderModal(item.type, item.src, item.name);
    }
  });

  document.addEventListener("keydown", e => {
    if (document.getElementById("modal").classList.contains("hidden")) return;
    if (e.key === "Escape") closeModal();
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      // Arrows switch items. Without preventDefault a focused video also
      // seeked on the same key press (seek with the progress bar instead).
      e.preventDefault();
      (e.key === "ArrowLeft" ? modalPrev : modalNext).click();
    }
    // Fast rating while browsing: 1–3 set that many stars, 0 clears
    if (/^[0-3]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const ctl = document.querySelector("#modal-stars .star-ctl");
      if (ctl && +ctl.dataset.level !== +e.key) {
        e.preventDefault();
        setStars(ctl.dataset.path, +e.key);
      }
    }
  });

  // Clear thumbnail cache
  const clearCacheBtn = document.getElementById("clear-cache-btn");
  const clearCacheHtml = clearCacheBtn.innerHTML;
  clearCacheBtn.style.display = "";
  clearCacheBtn.addEventListener("click", async () => {
    if (!confirm("Удалить все кешированные превью? Они пересоздадутся в высоком качестве при следующем просмотре.")) return;
    clearCacheBtn.disabled = true;
    clearCacheBtn.textContent = "⏳ Удаляю...";
    try {
      const res = await api("/api/clear-cache");
      clearCacheBtn.textContent = `✓ Удалено ${res.deleted} файлов`;
      // Reload so images regenerate lazily
      load();
    } catch (e) {
      clearCacheBtn.textContent = "Ошибка";
    }
    setTimeout(() => {
      clearCacheBtn.innerHTML = clearCacheHtml;
      clearCacheBtn.disabled = false;
    }, 2000);
  });

  // Paging, one pager per tab; each observes its tab's scrolling element
  pagers.browse = new Pager({ page: "browse", sentinel: "load-more", scrollRoot: "content-area",
                              onPage: appendBrowsePage });
  pagers.favorites = new Pager({ page: "favorites", sentinel: "fav-load-more", scrollRoot: "fav-content",
                                 onPage: data => appendTagPage("favorites", data) });
  pagers.wallpapers = new Pager({ page: "wallpapers", sentinel: "wp-load-more", scrollRoot: "wp-content",
                                  onPage: data => appendTagPage("wallpapers", data) });

  if (state.root) load();
});
