/* ── State ─────────────────────────────────────────────────────────────────── */
const state = {
  root: localStorage.getItem("cc_root") || "",
  path: "",
  flat: false,
  search: "",
  categories: new Set(),
  bestFolder: 0,
  bestFile: 0,
  mediaFilter: "all",   // "all" | "videos" | "photos"
  viewMode: "grid",
  page: "browse",
  favLevel: 0,
  galleryItems: [],
  galleryIdx: 0,
};

/* ── API helpers ───────────────────────────────────────────────────────────── */
async function api(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

function browseUrl() {
  const p = new URLSearchParams({
    root: state.root,
    path: state.path,
    flat: state.flat,
    search: state.search,
    categories: [...state.categories].join(","),
    min_folder_best: state.bestFolder,
    min_file_best: state.bestFile,
    media_filter: state.mediaFilter,
  });
  return "/api/browse?" + p;
}

function favUrl(minLevel = 1) {
  return `/api/favorites?root=${encodeURIComponent(state.root)}&min_level=${minLevel}`;
}

function categoriesUrl() {
  return `/api/categories?root=${encodeURIComponent(state.root)}&path=${encodeURIComponent(state.path)}`;
}

/* ── Load dispatcher ───────────────────────────────────────────────────────── */
async function load() {
  if (!state.root) return;
  localStorage.setItem("cc_root", state.root);
  if (state.page === "favorites") {
    await loadFavorites();
  } else {
    await loadBrowse();
  }
}

/* ── Browse ────────────────────────────────────────────────────────────────── */
async function loadBrowse() {
  showContent("loading");
  try {
    const [data, cats] = await Promise.all([api(browseUrl()), api(categoriesUrl())]);
    renderSidebar(data, cats.categories);
    renderContent(data);
  } catch (e) {
    showContent("empty-state");
    console.error(e);
  }
}

function showContent(id) {
  ["welcome", "loading", "folders-container", "empty-state"].forEach(s =>
    document.getElementById(s).classList.toggle("hidden", s !== id)
  );
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

  // Subfolders
  const sfl = document.getElementById("subfolders-list");
  const sfSec = document.getElementById("subfolders-section");
  sfl.innerHTML = "";
  if (!data.subfolders.length) {
    sfSec.classList.add("hidden");
  } else {
    sfSec.classList.remove("hidden");
    data.subfolders.forEach(sf => {
      const el = document.createElement("div");
      el.className = "subfolder-item";
      const stars = starsHtml(sf.best_level || 0);
      el.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
        </svg>
        <span title="${sf.full}" style="flex:1;overflow:hidden;text-overflow:ellipsis">${sf.name}</span>
        ${stars ? `<span class="stars">${stars}</span>` : ""}`;
      el.addEventListener("click", () => navigate(sf.path));
      sfl.appendChild(el);
    });
  }

  // Best section & star buttons
  document.getElementById("best-section").classList.remove("hidden");
  syncStarFilterButtons();

  // Categories
  const catList = document.getElementById("categories-list");
  const catSec  = document.getElementById("categories-section");
  catList.innerHTML = "";
  if (!categories.length) {
    catSec.classList.add("hidden");
  } else {
    catSec.classList.remove("hidden");
    categories.forEach(cat => {
      const chip = document.createElement("span");
      chip.className = "category-chip" + (state.categories.has(cat) ? " active" : "");
      chip.textContent = cat;
      chip.addEventListener("click", () => {
        state.categories.has(cat) ? state.categories.delete(cat) : state.categories.add(cat);
        load();
      });
      catList.appendChild(chip);
    });
  }

  // Show/hide grid-list buttons (only relevant in "all" mode)
  document.getElementById("view-mode-btns").classList.toggle("hidden", state.mediaFilter !== "all");
}

function syncStarFilterButtons() {
  document.querySelectorAll(".star-filter-btn").forEach(btn => {
    const target = btn.dataset.target;
    const level  = parseInt(btn.dataset.level);
    const active = target === "folder" ? state.bestFolder === level : state.bestFile === level;
    btn.classList.toggle("active", active);
  });
}

/* ── Content router ────────────────────────────────────────────────────────── */
function renderContent(data) {
  const container = document.getElementById("folders-container");
  container.innerHTML = "";

  if (!data.folders.length) { showContent("empty-state"); return; }

  state.galleryItems = [];

  if (state.mediaFilter === "videos") {
    renderVideosMode(data.folders, container);
  } else if (state.mediaFilter === "photos") {
    renderPhotosMode(data.folders, container);
  } else {
    renderAllMode(data.folders, container);
  }

  const totalMedia = data.folders.reduce(
    (s, f) => s + f.total_videos + f.total_images, 0
  );
  document.getElementById("result-count").textContent =
    `${data.total} папок · ${totalMedia} файлов`;

  showContent("folders-container");
  setupLazyLoad();
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

  const bestLevel = video.best_level || 0;
  const frames    = video.frames;            // [{url, src, idx, pos}, ...]
  const frameCount = frames.length;

  // Build dots HTML
  const dotsHtml = frames.map((_, i) =>
    `<div class="video-card-dot${i === 0 ? " active" : ""}"></div>`
  ).join("");

  card.innerHTML = `
    <div class="video-card-thumb">
      <img data-src="${frames[0].url}"
           data-src-file="${frames[0].src}"
           data-idx="${frames[0].idx}"
           data-pos="${frames[0].pos}"
           data-kind="video" alt="${video.name}">
      <div class="video-card-play">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="rgba(255,255,255,.9)" stroke="none">
          <polygon points="5 3 19 12 5 21"/>
        </svg>
      </div>
      <div class="video-card-progress"><div class="video-card-progress-fill"></div></div>
      <div class="video-card-dots">${dotsHtml}</div>
    </div>
    <div class="video-card-info">
      <div class="video-card-name" title="${video.name}">${video.name}</div>
      <div class="video-card-meta">
        <div class="video-card-folder" title="${folder.path}">📁 ${folder.name}</div>
        <div class="video-card-actions">
          ${bestLevel > 0 ? `<span class="stars">${starsHtml(bestLevel)}</span>` : ""}
          <button class="card-open-btn" style="padding:3px 8px;font-size:11px" title="Открыть расположение">↗</button>
        </div>
      </div>
    </div>`;

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
  state.galleryItems.push({ src: video.path, name: video.name, type: "video" });
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
      const frame = frames[idx];
      fetch(`/api/gen-thumb?src=${encodeURIComponent(frame.src)}&idx=${frame.idx}&pos=${frame.pos}&kind=video`)
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
        fetch(`/api/gen-thumb?src=${encodeURIComponent(frame.src)}&idx=${frame.idx}&pos=${frame.pos}&kind=video`)
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
function renderPhotosMode(folders, container) {
  container.className = "photos-only-container";

  folders.forEach(folder => {
    if (!folder.images || !folder.images.length) return;

    const block = document.createElement("div");
    block.className = "photo-folder-block";

    const bestLevel = folder.best_level || 0;
    block.innerHTML = `
      <div class="photo-folder-block-header">
        <div>
          <div class="photo-folder-block-name">
            📁 ${folder.name}
            ${bestLevel > 0 ? `<span class="stars" style="margin-left:6px">${starsHtml(bestLevel)}</span>` : ""}
          </div>
          <div class="photo-folder-block-path">${folder.path}</div>
        </div>
        <div class="photo-folder-block-meta">
          <span class="card-badge badge-photo">◼ ${folder.total_images} фото</span>
          <button class="card-open-btn" style="padding:4px 10px;font-size:12px" title="Открыть в Finder">↗</button>
        </div>
      </div>
      <div class="photos-large-grid"></div>`;

    block.querySelector(".card-open-btn").addEventListener("click", e => {
      e.stopPropagation();
      openLocation(folder.path);
    });

    const grid = block.querySelector(".photos-large-grid");
    const images = folder.images || [];

    images.forEach(img => {
      const iBest = img.best_level || 0;
      const cell = document.createElement("div");
      cell.className = "photo-large-cell";
      cell.innerHTML = `
        <img data-src="${img.url}" data-src-file="${img.src}" data-kind="image" alt="${img.name}">
        ${iBest > 0 ? `<span class="file-star">${starsHtml(iBest)}</span>` : ""}
        <div class="photo-name-overlay">${img.name}</div>`;

      const galleryIdx = state.galleryItems.length;
      state.galleryItems.push({ src: img.path, name: img.name, type: "image" });
      cell.addEventListener("click", () => openModal("image", img.path, img.name, galleryIdx));
      grid.appendChild(cell);
    });

    // Show more
    if (folder.images_hidden > 0) {
      const more = document.createElement("div");
      more.className = "show-more-btn photo-large-cell";
      more.style.fontSize = "14px";
      more.textContent = `+${folder.images_hidden} ещё`;
      more.addEventListener("click", () => {
        more.remove();
        folder.images.slice(24).forEach(imgData => {
          const iBest = imgData.best_level || 0;
          const cell = document.createElement("div");
          cell.className = "photo-large-cell";
          cell.innerHTML = `
            <img data-src="${imgData.url}" data-src-file="${imgData.src}" data-kind="image" alt="${imgData.name}">
            ${iBest > 0 ? `<span class="file-star">${starsHtml(iBest)}</span>` : ""}
            <div class="photo-name-overlay">${imgData.name}</div>`;
          const galleryIdx = state.galleryItems.length;
          state.galleryItems.push({ src: imgData.path, name: imgData.name, type: "image" });
          cell.addEventListener("click", () => openModal("image", imgData.path, imgData.name, galleryIdx));
          grid.appendChild(cell);
        });
        setupLazyLoad();
      });
      grid.appendChild(more);
    }

    container.appendChild(block);
  });
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
  const bestLevel = folder.best_level || 0;

  const badges = [
    bestLevel > 0 ? `<span class="card-badge badge-best">${starsHtml(bestLevel)}</span>` : "",
    hasVideos ? `<span class="card-badge badge-video">▶ ${folder.total_videos} видео</span>` : "",
    hasPhotos ? `<span class="card-badge badge-photo">◼ ${folder.total_images} фото</span>` : "",
    hasTexts  ? `<span class="card-badge badge-text">✎ ${folder.texts.length} текст</span>` : "",
  ].join("");

  card.innerHTML = `
    <div class="card-header">
      <div class="card-header-info">
        <div class="card-folder-name" title="${folder.path}">📁 ${folder.name}</div>
        <div class="card-folder-path">${folder.path}</div>
        <div class="card-meta">${badges}</div>
      </div>
      <button class="card-open-btn" data-path="${folder.path}" title="Открыть в Finder/Explorer">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
          <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
        </svg>
        Открыть
      </button>
    </div>`;

  card.querySelector(".card-open-btn").addEventListener("click", e => {
    e.stopPropagation();
    openLocation(folder.path);
  });

  // Videos
  folder.videos.forEach(video => {
    const vBest = video.best_level || 0;
    const sec = document.createElement("div");
    sec.className = "card-section";
    sec.innerHTML = `
      <div class="card-section-label">
        🎬 <span class="filename">${video.name}</span>
        ${vBest > 0 ? `<span class="stars" style="margin-left:4px">${starsHtml(vBest)}</span>` : ""}
        <button class="card-open-btn" style="margin-left:auto;padding:3px 8px;font-size:10.5px"
                data-path="${video.path}" title="Открыть файл">↗</button>
      </div>
      <div class="frames-strip"></div>`;

    sec.querySelector("[data-path]").addEventListener("click", e => {
      e.stopPropagation(); openLocation(video.path);
    });

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
        <img data-src="${frame.url}" data-src-file="${frame.src}"
             data-idx="${frame.idx}" data-pos="${frame.pos}" data-kind="video" alt="">`;

      const idx = state.galleryItems.length;
      state.galleryItems.push({ src: video.path, name: video.name, type: "video" });
      cell.addEventListener("click", () => openModal("video", video.path, video.name, idx));
      strip.appendChild(cell);
    });

    card.appendChild(sec);
  });

  // Photos
  if (folder.images_preview?.length) {
    const sec = document.createElement("div");
    sec.className = "card-section";
    sec.innerHTML = `<div class="card-section-label">🖼 Фотографии</div><div class="photos-grid"></div>`;
    const grid = sec.querySelector(".photos-grid");

    folder.images_preview.forEach(img => {
      const iBest = img.best_level || 0;
      const cell = document.createElement("div");
      cell.className = "photo-cell";
      cell.style.position = "relative";
      cell.innerHTML = `
        <img data-src="${img.url}" data-src-file="${img.src}" data-kind="image" alt="${img.name}">
        ${iBest > 0 ? `<span class="file-star">${starsHtml(iBest)}</span>` : ""}`;
      const idx = state.galleryItems.length;
      state.galleryItems.push({ src: img.path, name: img.name, type: "image" });
      cell.addEventListener("click", () => openModal("image", img.path, img.name, idx));
      grid.appendChild(cell);
    });

    if (folder.images_hidden > 0) {
      const more = document.createElement("div");
      more.className = "show-more-btn photo-cell";
      more.textContent = `+${folder.images_hidden} ещё`;
      more.addEventListener("click", () => {
        more.remove();
        folder.images.slice(24).forEach(imgData => {
          const iBest = imgData.best_level || 0;
          const cell = document.createElement("div");
          cell.className = "photo-cell";
          cell.style.position = "relative";
          cell.innerHTML = `
            <img data-src="${imgData.url}" data-src-file="${imgData.src}" data-kind="image" alt="${imgData.name}">
            ${iBest > 0 ? `<span class="file-star">${starsHtml(iBest)}</span>` : ""}`;
          const idx = state.galleryItems.length;
          state.galleryItems.push({ src: imgData.path, name: imgData.name, type: "image" });
          cell.addEventListener("click", () => openModal("image", imgData.path, imgData.name, idx));
          grid.appendChild(cell);
        });
        setupLazyLoad();
      });
      grid.appendChild(more);
    }

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
            ${txt.name}
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

function setupLazyLoad() {
  if (observer) observer.disconnect();
  observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const img = entry.target;
      observer.unobserve(img);
      loadThumb(img);
    });
  }, { rootMargin: "150px" });

  document.querySelectorAll("img[data-src]").forEach(img => observer.observe(img));
}

async function loadThumb(img) {
  const url  = img.dataset.src;
  const kind = img.dataset.kind;

  const test = new Image();
  test.onload = () => {
    img.src = url;
    img.classList.add("loaded");
    img.parentElement?.querySelector(".thumb-placeholder")?.style.setProperty("display", "none");
  };
  test.onerror = async () => {
    try {
      const genUrl = kind === "video"
        ? `/api/gen-thumb?src=${encodeURIComponent(img.dataset.srcFile)}&idx=${img.dataset.idx}&pos=${img.dataset.pos}&kind=video`
        : `/api/gen-thumb?src=${encodeURIComponent(img.dataset.srcFile)}&kind=image`;
      const res = await fetch(genUrl);
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

/* ── Favorites page ────────────────────────────────────────────────────────── */
async function loadFavorites() {
  document.getElementById("fav-area").classList.remove("hidden");
  document.getElementById("content-area").classList.add("hidden");

  const minLevel = state.favLevel > 0 ? state.favLevel : 1;
  const content = document.getElementById("fav-content");
  content.innerHTML = `<div class="loading"><div class="spinner"></div><p>Загрузка избранного...</p></div>`;

  try {
    renderFavorites(await api(favUrl(minLevel)));
  } catch (e) {
    content.innerHTML = `<div class="empty-state"><p>Ошибка: ${e.message}</p></div>`;
  }
}

function renderFavorites(data) {
  const content = document.getElementById("fav-content");
  content.innerHTML = "";

  const total = data.total_folders + data.total_files;
  document.getElementById("fav-count").textContent =
    `${data.total_folders} папок · ${data.total_files} файлов`;

  const badge = document.getElementById("fav-badge");
  badge.textContent = total;
  badge.classList.toggle("hidden", total === 0);

  if (!total) {
    content.innerHTML = `
      <div class="empty-state" style="height:300px">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
        </svg>
        <p>Нет файлов/папок с пометкой _best</p>
        <p style="font-size:12px;color:var(--text-mute)">Добавьте суффикс _best к именам файлов или папок</p>
      </div>`;
    return;
  }

  state.galleryItems = [];

  // Folders section
  const folders = state.favLevel > 0
    ? data.favorite_folders.filter(f => f.best_level === state.favLevel)
    : data.favorite_folders;

  if (folders.length) {
    const sec = document.createElement("div");
    const title = document.createElement("div");
    title.className = "fav-section-title";
    title.innerHTML = `★ Избранные папки <span class="count">(${folders.length})</span>`;
    sec.appendChild(title);
    const grid = document.createElement("div");
    grid.className = "folders-grid";
    folders.forEach(f => grid.appendChild(buildCard(f)));
    sec.appendChild(grid);
    content.appendChild(sec);
  }

  // Files section
  const files = state.favLevel > 0
    ? data.favorite_files.filter(f => f.best_level === state.favLevel)
    : data.favorite_files;

  if (files.length) {
    const sec = document.createElement("div");
    const title = document.createElement("div");
    title.className = "fav-section-title";
    title.innerHTML = `★ Избранные файлы <span class="count">(${files.length})</span>`;
    sec.appendChild(title);
    const grid = document.createElement("div");
    grid.className = "fav-files-grid";

    files.forEach(file => {
      const cell = document.createElement("div");
      cell.className = "fav-file-cell";
      const isVideo = file.type === "video";
      cell.innerHTML = `
        <div class="thumb-wrap">
          <img data-src="${file.url}" data-src-file="${file.src}"
               data-idx="${file.idx}" data-pos="${file.pos}"
               data-kind="${file.type}" alt="${file.name}">
          <span class="file-star">${starsHtml(file.best_level)}</span>
          ${isVideo ? `<div class="thumb-play-overlay">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="white" stroke="none"><polygon points="5 3 19 12 5 21"/></svg>
          </div>` : ""}
        </div>
        <div class="fav-file-info">
          <div class="fav-file-name" title="${file.name}">${file.name}</div>
          <div class="fav-file-folder" title="${file.folder_path}">📁 ${file.folder_name}</div>
        </div>
        <button class="fav-open-btn" title="Открыть расположение">↗</button>`;

      cell.querySelector(".fav-open-btn").addEventListener("click", e => {
        e.stopPropagation(); openLocation(file.path);
      });
      const idx = state.galleryItems.length;
      state.galleryItems.push({ src: file.path, name: file.name, type: file.type });
      cell.addEventListener("click", () => openModal(file.type, file.path, file.name, idx));
      grid.appendChild(cell);
    });

    sec.appendChild(grid);
    content.appendChild(sec);
  }

  setupLazyLoad();
}

/* ── Modal ─────────────────────────────────────────────────────────────────── */
function openModal(type, src, name, galleryIdx) {
  state.galleryIdx = galleryIdx;
  renderModal(type, src, name);
  document.getElementById("modal").classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function renderModal(type, src, name) {
  document.getElementById("modal-title").textContent = name;
  document.getElementById("modal-open").onclick = () => openLocation(src);

  const body = document.getElementById("modal-body");
  body.innerHTML = "";

  if (type === "video") {
    const v = document.createElement("video");
    v.src = `/file?path=${encodeURIComponent(src)}`;
    v.controls = true;
    v.autoplay = true;
    body.appendChild(v);
  } else {
    const img = document.createElement("img");
    img.src = `/file?path=${encodeURIComponent(src)}`;
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
  document.querySelectorAll("#modal-body video").forEach(v => v.pause());
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
  document.getElementById("content-area").classList.toggle("hidden", !isBrowse);
  document.getElementById("fav-area").classList.toggle("hidden", isBrowse);
  document.getElementById("best-section")?.classList.toggle("hidden", !isBrowse);
  load();
}

/* ── Utils ─────────────────────────────────────────────────────────────────── */
function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
    load();
  });
  rootInput.addEventListener("keydown", e => { if (e.key === "Enter") loadBtn.click(); });

  searchInput.addEventListener("input", debounce(e => {
    state.search = e.target.value;
    load();
  }, 300));

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
      // Show/hide grid-list toggle
      document.getElementById("view-mode-btns").classList.toggle("hidden", state.mediaFilter !== "all");
      load();
    });
  });

  clearCats.addEventListener("click", () => { state.categories.clear(); load(); });

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
      loadFavorites();
    });
  });

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
    if (e.key === "ArrowLeft") modalPrev.click();
    if (e.key === "ArrowRight") modalNext.click();
  });

  if (state.root) load();
});
