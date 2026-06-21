/* ── State ─────────────────────────────────────────────────────────────────── */
const state = {
  root: localStorage.getItem("cc_root") || "",
  path: "",
  flat: false,
  search: "",
  categories: new Set(),
  viewMode: "grid",
  galleryItems: [],   // [{src, name, type}]  for modal navigation
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
  });
  return "/api/browse?" + p;
}

function categoriesUrl() {
  return `/api/categories?root=${encodeURIComponent(state.root)}&path=${encodeURIComponent(state.path)}`;
}

/* ── Load & render ─────────────────────────────────────────────────────────── */
async function load() {
  if (!state.root) return;
  localStorage.setItem("cc_root", state.root);
  show("loading");
  try {
    const [data, cats] = await Promise.all([api(browseUrl()), api(categoriesUrl())]);
    renderSidebar(data, cats.categories);
    renderContent(data);
  } catch (e) {
    show("empty-state");
    console.error(e);
  }
}

function show(id) {
  ["welcome", "loading", "folders-container", "empty-state"].forEach(s =>
    document.getElementById(s).classList.toggle("hidden", s !== id)
  );
  document.getElementById("toolbar").classList.toggle("hidden", id !== "folders-container");
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
    if (i < data.breadcrumbs.length - 1) {
      el.addEventListener("click", () => navigate(crumb.path));
    }
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
  if (data.subfolders.length === 0) {
    sfSec.classList.add("hidden");
  } else {
    sfSec.classList.remove("hidden");
    data.subfolders.forEach(sf => {
      const el = document.createElement("div");
      el.className = "subfolder-item";
      el.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
        </svg>
        <span title="${sf.full}">${sf.name}</span>`;
      el.addEventListener("click", () => navigate(sf.path));
      sfl.appendChild(el);
    });
  }

  // Categories
  const catList = document.getElementById("categories-list");
  const catSec = document.getElementById("categories-section");
  catList.innerHTML = "";
  if (categories.length === 0) {
    catSec.classList.add("hidden");
  } else {
    catSec.classList.remove("hidden");
    categories.forEach(cat => {
      const chip = document.createElement("span");
      chip.className = "category-chip" + (state.categories.has(cat) ? " active" : "");
      chip.textContent = cat;
      chip.addEventListener("click", () => {
        if (state.categories.has(cat)) state.categories.delete(cat);
        else state.categories.add(cat);
        load();
      });
      catList.appendChild(chip);
    });
  }
}

/* ── Content ───────────────────────────────────────────────────────────────── */
function renderContent(data) {
  const container = document.getElementById("folders-container");
  container.innerHTML = "";
  document.getElementById("result-count").textContent =
    `${data.total} папок · ${data.root}`;

  if (data.folders.length === 0) {
    show("empty-state");
    return;
  }

  // Build gallery index for modal navigation
  state.galleryItems = [];

  data.folders.forEach(folder => {
    const card = buildCard(folder);
    container.appendChild(card);
  });

  show("folders-container");
  setupLazyLoad();
}

/* ── Card builder ──────────────────────────────────────────────────────────── */
function buildCard(folder) {
  const card = document.createElement("div");
  card.className = "folder-card";

  // Header
  const hasVideos = folder.videos.length > 0;
  const hasPhotos = folder.images.length > 0;
  const hasTexts  = folder.texts.length > 0;

  const badges = [
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
    const sec = document.createElement("div");
    sec.className = "card-section";
    sec.innerHTML = `
      <div class="card-section-label">
        🎬 <span class="filename">${video.name}</span>
        <button class="card-open-btn" style="margin-left:auto;padding:3px 8px;font-size:10.5px" data-path="${video.path}" title="Открыть файл">↗</button>
      </div>
      <div class="frames-strip"></div>`;

    sec.querySelector("[data-path]").addEventListener("click", e => {
      e.stopPropagation();
      openLocation(video.path);
    });

    const strip = sec.querySelector(".frames-strip");
    const galleryStart = state.galleryItems.length;

    video.frames.forEach((frame, fi) => {
      const cell = document.createElement("div");
      cell.className = "thumb-cell";
      cell.innerHTML = `
        <div class="thumb-placeholder">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="2" y="4" width="20" height="16" rx="2"/>
            <polygon points="10 8 16 12 10 16"/>
          </svg>
        </div>
        <div class="thumb-play">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="white" stroke="none"><polygon points="5 3 19 12 5 21"/></svg>
        </div>
        <img data-src="${frame.url}" data-src-file="${frame.src}" data-idx="${frame.idx}" data-pos="${frame.pos}" data-kind="video" alt="">`;

      const idx = state.galleryItems.length;
      state.galleryItems.push({ src: video.path, name: video.name, type: "video" });

      cell.addEventListener("click", () => openModal("video", video.path, video.name, idx));
      strip.appendChild(cell);
    });

    card.appendChild(sec);
  });

  // Photos
  if (folder.images_preview && folder.images_preview.length > 0) {
    const sec = document.createElement("div");
    sec.className = "card-section";
    sec.innerHTML = `
      <div class="card-section-label">🖼 Фотографии</div>
      <div class="photos-grid"></div>`;

    const grid = sec.querySelector(".photos-grid");
    const galleryStart = state.galleryItems.length;

    folder.images_preview.forEach((img, i) => {
      const cell = document.createElement("div");
      cell.className = "photo-cell";
      cell.innerHTML = `<img data-src="${img.url}" data-src-file="${img.src}" data-kind="image" alt="${img.name}">`;

      const idx = state.galleryItems.length;
      state.galleryItems.push({ src: img.path, name: img.name, type: "image" });

      cell.addEventListener("click", () => openModal("image", img.path, img.name, idx));
      grid.appendChild(cell);
    });

    if (folder.images_hidden > 0) {
      const more = document.createElement("div");
      more.className = "show-more-btn photo-cell";
      more.textContent = `+${folder.images_hidden} ещё`;
      more.addEventListener("click", async () => {
        more.remove();
        // Load remaining images
        const remaining = folder.images.slice(24);
        remaining.forEach(img => {
          const cell = document.createElement("div");
          cell.className = "photo-cell";
          cell.innerHTML = `<img data-src="${img.url}" data-src-file="${img.src}" data-kind="image" alt="${img.name}">`;
          const idx2 = state.galleryItems.length;
          state.galleryItems.push({ src: img.path, name: img.name, type: "image" });
          cell.addEventListener("click", () => openModal("image", img.path, img.name, idx2));
          grid.appendChild(cell);
        });
        setupLazyLoad();
      });
      grid.appendChild(more);
    }

    card.appendChild(sec);
  }

  // Texts
  if (folder.texts.length > 0) {
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

      block.querySelector(".text-block-header").addEventListener("click", () => {
        block.classList.toggle("collapsed");
      });
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
  }, { rootMargin: "100px" });

  document.querySelectorAll("img[data-src]").forEach(img => observer.observe(img));
}

async function loadThumb(img) {
  const url = img.dataset.src;
  const kind = img.dataset.kind;

  // Try cached thumbnail
  const testImg = new Image();
  testImg.onload = () => {
    img.src = url;
    img.classList.add("loaded");
    img.closest(".thumb-placeholder") && img.closest(".thumb-placeholder").style.setProperty("display", "none");
    const placeholder = img.parentElement?.querySelector(".thumb-placeholder");
    if (placeholder) placeholder.style.display = "none";
  };
  testImg.onerror = async () => {
    // Generate thumbnail on demand
    try {
      const genUrl = kind === "video"
        ? `/api/gen-thumb?src=${encodeURIComponent(img.dataset.srcFile)}&idx=${img.dataset.idx}&pos=${img.dataset.pos}&kind=video`
        : `/api/gen-thumb?src=${encodeURIComponent(img.dataset.srcFile)}&kind=image`;

      const res = await fetch(genUrl);
      if (res.ok) {
        const data = await res.json();
        img.src = data.url;
        img.classList.add("loaded");
        const placeholder = img.parentElement?.querySelector(".thumb-placeholder");
        if (placeholder) placeholder.style.display = "none";
      }
    } catch (e) {}
  };
  testImg.src = url;
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
    const video = document.createElement("video");
    video.src = `/file?path=${encodeURIComponent(src)}`;
    video.controls = true;
    video.autoplay = true;
    body.appendChild(video);
  } else if (type === "image") {
    const img = document.createElement("img");
    img.src = `/file?path=${encodeURIComponent(src)}`;
    body.appendChild(img);
  }

  // Nav arrows (only for gallery items of same folder — simplified: use all)
  const nav = document.getElementById("modal-nav");
  const total = state.galleryItems.length;
  if (total > 1) {
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
  // Stop any playing video
  document.querySelectorAll("#modal-body video").forEach(v => v.pause());
}

/* ── Navigation ────────────────────────────────────────────────────────────── */
function navigate(path) {
  state.path = path;
  state.categories.clear();
  load();
}

async function openLocation(path) {
  try {
    await fetch(`/api/open?path=${encodeURIComponent(path)}`);
  } catch (e) {
    console.error("openLocation failed", e);
  }
}

/* ── Utils ─────────────────────────────────────────────────────────────────── */
function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* ── Event wiring ──────────────────────────────────────────────────────────── */
document.addEventListener("DOMContentLoaded", () => {
  const rootInput  = document.getElementById("root-input");
  const loadBtn    = document.getElementById("load-btn");
  const searchInput = document.getElementById("search-input");
  const flatToggle = document.getElementById("flat-toggle");
  const btnGrid    = document.getElementById("btn-grid");
  const btnList    = document.getElementById("btn-list");
  const modal      = document.getElementById("modal");
  const modalClose = document.getElementById("modal-close");
  const modalPrev  = document.getElementById("modal-prev");
  const modalNext  = document.getElementById("modal-next");
  const clearCats  = document.getElementById("clear-cats");

  if (state.root) rootInput.value = state.root;

  loadBtn.addEventListener("click", () => {
    state.root = rootInput.value.trim();
    state.path = "";
    state.categories.clear();
    load();
  });

  rootInput.addEventListener("keydown", e => {
    if (e.key === "Enter") loadBtn.click();
  });

  searchInput.addEventListener("input", debounce(e => {
    state.search = e.target.value;
    load();
  }, 300));

  flatToggle.addEventListener("change", e => {
    state.flat = e.target.checked;
    load();
  });

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

  clearCats.addEventListener("click", () => {
    state.categories.clear();
    load();
  });

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
    if (modal.classList.contains("hidden")) return;
    if (e.key === "Escape") closeModal();
    if (e.key === "ArrowLeft") modalPrev.click();
    if (e.key === "ArrowRight") modalNext.click();
  });

  // Auto-load if we have a saved root
  if (state.root) load();
});
