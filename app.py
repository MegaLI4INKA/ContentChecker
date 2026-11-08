import asyncio
import codecs
import io
import json
import os
import platform
import subprocess
import hashlib
import ipaddress
import logging
import threading
import time
import unicodedata
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from contextvars import ContextVar
from pathlib import Path
from typing import Callable, Iterator, Optional

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, PlainTextResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

try:  # HEIC/HEIF support for Pillow (optional dependency)
    from pillow_heif import register_heif_opener
    register_heif_opener()
except ImportError:
    pass

app = FastAPI(title="ContentChecker")

# ── Access control ─────────────────────────────────────────────────────────────
# run.py sets these (LOCAL_ONLY / LAN_ROOTS). By default: localhost only.
#   CC_LAN=1          — server is reachable from other devices in the network
#   CC_ALLOWED_ROOTS  — os.pathsep-separated folders; if set, the API refuses
#                       any path outside them, for everyone
# In LAN mode without CC_ALLOWED_ROOTS, other devices may open only the folders
# that were opened on this computer since the server started.
LAN_MODE = os.environ.get("CC_LAN") == "1"


def norm(p: str | Path) -> Path:
    """Absolute normalized path: '..' and '~' are resolved, symlinks are kept."""
    return Path(os.path.normpath(os.path.abspath(os.path.expanduser(p))))


ALLOWED_ROOTS: list[Path] = []
for _r in os.environ.get("CC_ALLOWED_ROOTS", "").split(os.pathsep):
    if _r.strip():
        ALLOWED_ROOTS += [norm(_r.strip()), norm(_r.strip()).resolve()]

# Roots opened from this computer (LAN mode): what other devices may browse
_opened_roots: set[Path] = set()

# Whether the current request comes from this computer. Set per request by the
# middleware below; the default is "not local" in LAN mode, so if it's ever
# missing, the stricter rule applies.
_client_is_local: ContextVar[bool] = ContextVar("client_is_local", default=not LAN_MODE)


def _lan_host_ok(host_header: str) -> bool:
    """LAN mode: the server is addressed by an IP, "localhost" or a Bonjour
    name (*.local). Any other name means DNS rebinding: a web page made its own
    domain point at this server to talk to it as if from the same site."""
    if host_header.startswith("["):  # [IPv6]:port
        host = host_header[1:host_header.find("]")]
    else:
        host = host_header.split(":")[0]
    host = host.lower()
    if host == "localhost" or host.endswith(".local"):
        return True
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return False


class LanGuardMiddleware:
    """LAN mode: checks the Host header and marks whether the request comes
    from this computer (see ensure_allowed)."""
    def __init__(self, asgi_app):
        self.app = asgi_app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        host = dict(scope.get("headers") or []).get(b"host", b"").decode("latin-1")
        if not _lan_host_ok(host):
            return await PlainTextResponse("Invalid host header", 400)(scope, receive, send)
        client = scope.get("client")
        token = _client_is_local.set(bool(client) and client[0] in ("127.0.0.1", "::1"))
        try:
            await self.app(scope, receive, send)
        finally:
            _client_is_local.reset(token)


if LAN_MODE:
    app.add_middleware(LanGuardMiddleware)
else:
    # Only accept requests addressed to localhost — blocks DNS-rebinding attacks
    # where a web page in your browser talks to this server under a foreign name.
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1"])


def ensure_allowed(p: Path) -> Path:
    roots = ALLOWED_ROOTS
    if not roots and LAN_MODE and not _client_is_local.get():
        roots = list(_opened_roots)
        if not roots:
            raise HTTPException(403, "Сначала откройте папку на компьютере, где запущен ContentChecker")
    if roots and not any(p.is_relative_to(r) for r in roots):
        raise HTTPException(403, f"Путь вне разрешённых папок: {p}")
    return p


def open_root(root: str) -> Path:
    root_path = ensure_allowed(norm(root).resolve())
    if not root_path.is_dir():
        raise HTTPException(400, f"Not a directory: {root}")
    if LAN_MODE and _client_is_local.get():
        _opened_roots.add(root_path)  # from now on other devices may open it too
    return root_path


def open_subdir(root_path: Path, path: str) -> Path:
    """root/path, refusing to climb above root via '..'. Symlinked subfolders are
    kept as-is (not resolved), so their paths stay relative to root."""
    cur = norm(root_path / path) if path else root_path
    if not cur.is_relative_to(root_path):
        raise HTTPException(400, "Path is outside of root")
    if not cur.is_dir():
        raise HTTPException(400, f"Not a directory: {cur}")
    return cur


def open_file(path: str) -> Path:
    p = ensure_allowed(norm(path))
    if not p.is_file():
        raise HTTPException(404)
    return p


BASE_DIR = Path(__file__).parent
THUMB_DIR = BASE_DIR / ".thumbnails"
THUMB_DIR.mkdir(exist_ok=True)

VIDEO_EXTS = {".mp4", ".avi", ".mov", ".mkv", ".wmv", ".flv", ".webm", ".m4v", ".ts", ".3gp", ".mts", ".m2ts"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tiff", ".tif", ".heic", ".heif"}
TEXT_EXTS  = {".txt", ".md", ".srt", ".vtt", ".csv", ".log", ".nfo", ".description"}

MAX_TEXT_SIZE = 15_000  # chars per text file
MAX_PHOTOS_IN_CARD = 24


def fold(s: str) -> str:
    """Form of a name for matching and sorting. The same visible name may come in
    two Unicode forms: "й"/"ё" as one character (NFC — what a keyboard types) or
    as "и"/"е" + a combining mark (NFD — common on macOS disks). Compared raw,
    a typed query never matches an NFD name. casefold() is lower() that also
    handles letters like ß."""
    return unicodedata.normalize("NFC", s).casefold()


def _tag_base(name: str, is_dir: bool) -> str:
    """Part of the name that carries tags, lowercased. Folders have no extension,
    so 'Paris.2023_best' must not be cut down to 'Paris'."""
    return (name if is_dir else Path(name).stem).lower()


def parse_best_level(name: str, is_dir: bool = False) -> int:
    """Count trailing _best tokens in the name (max 3)."""
    base = _tag_base(name, is_dir)
    count = 0
    while base.endswith("_best"):
        count += 1
        base = base[:-5]
    return min(count, 3)


def has_wallpaper_tag(name: str, is_dir: bool = False) -> bool:
    """True if the name has a standalone _wallpaper token."""
    return "wallpaper" in _tag_base(name, is_dir).split("_")


# ── Filesystem helpers ─────────────────────────────────────────────────────────
# Hidden entries are skipped everywhere: .Trashes/.Spotlight-V100 on external
# drives, and AppleDouble '._IMG_0001.jpg' files that are not real images.

log = logging.getLogger("uvicorn.error")


def _valid_name(name: str) -> bool:
    """False for names with bytes that aren't valid UTF-8. macOS disks never
    have them, but e.g. a Linux (ext4) drive via macFUSE or an NFS share can.
    Python keeps such bytes as lone surrogates, which can't go into JSON (the
    whole folder's response failed) nor into a browser URL."""
    try:
        name.encode("utf-8")
        return True
    except UnicodeEncodeError:
        return False


def list_dir(p: Path | str) -> Optional[list[os.DirEntry]]:
    """Visible entries sorted by name, or None if the directory can't be read.
    os.scandir takes entry types from the listing itself, so is_dir()/is_file()
    cost no extra syscall per file — ~8x faster than Path.iterdir on big trees.
    Entries with undecodable names are skipped (and logged), so the rest of
    the folder still shows up."""
    try:
        with os.scandir(p) as it:
            entries = [e for e in it if not e.name.startswith(".")]
    except OSError:
        return None
    bad = [e for e in entries if not _valid_name(e.name)]
    if bad:
        log.warning("Skipped %d entr%s with undecodable names in %r: %s", len(bad),
                    "y" if len(bad) == 1 else "ies", str(p), [os.fsencode(e.name) for e in bad[:3]])
        entries = [e for e in entries if _valid_name(e.name)]
    return sorted(entries, key=lambda e: fold(e.name))


def is_dir(e: os.DirEntry) -> bool:
    try:
        return e.is_dir()
    except OSError:
        return False


def is_file(e: os.DirEntry) -> bool:
    try:
        return e.is_file()
    except OSError:
        return False


def subdirs(p: Path) -> list[Path]:
    return [Path(e.path) for e in list_dir(p) or [] if is_dir(e)]


def walk_dirs(top: Path, max_depth: Optional[int] = None) -> Iterator[tuple[Path, list[os.DirEntry]]]:
    """Depth-first (pre-order) walk yielding (dir, visible entries). Unreadable dirs
    are skipped and every real directory is visited once, so symlink loops can't
    multiply results or recurse forever."""
    seen: set[tuple[int, int]] = set()

    def _walk(p: Path, depth: int):
        try:
            st = p.stat()
        except OSError:
            return
        if (st.st_dev, st.st_ino) in seen:
            return
        seen.add((st.st_dev, st.st_ino))
        entries = list_dir(p)
        if entries is None:
            return
        yield p, entries
        if max_depth is None or depth < max_depth:
            for e in entries:
                if is_dir(e):
                    yield from _walk(Path(e.path), depth + 1)

    yield from _walk(top, 0)


def subfolder_info(e: Path, root_path: Path) -> dict:
    return {
        "name": e.name,
        "path": str(e.relative_to(root_path)),
        "full": str(e),
        "best_level": parse_best_level(e.name, is_dir=True),
        "has_children": any(is_dir(c) for c in list_dir(e) or []),
    }


def file_type(name: str) -> str:
    ext = os.path.splitext(name)[1].lower()
    if ext in VIDEO_EXTS: return "video"
    if ext in IMAGE_EXTS: return "image"
    if ext in TEXT_EXTS:  return "text"
    return "other"


TS_MIN_VIDEO_SIZE = 256 * 1024


def media_type(e: os.DirEntry) -> str:
    """file_type() plus a content check for '.ts': MPEG transport streams share
    the extension with TypeScript sources (node_modules is full of them). A
    stream is big and starts with the 0x47 sync byte, repeated every 188 bytes.
    Only .ts files cost extra I/O."""
    ft = file_type(e.name)
    if ft == "video" and e.name.lower().endswith(".ts"):
        try:
            if e.stat().st_size < TS_MIN_VIDEO_SIZE:
                return "other"
            with open(e.path, "rb") as f:
                head = f.read(189)
        except OSError:
            return "other"
        if head[:1] != b"\x47" or (len(head) == 189 and head[188:189] != b"\x47"):
            return "other"
    return ft


def thumb_key(st: os.stat_result, idx: int) -> str:
    """Cache key from the file's identity, not its path: renaming clip.mp4 →
    clip_best.mp4 keeps the inode, so frames are reused instead of regenerated
    and orphaned; replacing the file changes size/mtime and invalidates them.
    st_dev is left out on purpose — it changes every time a drive is remounted."""
    return hashlib.md5(f"{st.st_ino}:{st.st_size}:{st.st_mtime_ns}:{idx}".encode()).hexdigest()


def thumb_path(st: os.stat_result, idx: int) -> Path:
    return THUMB_DIR / f"{thumb_key(st, idx)}.jpg"


THUMB_MAX = 700   # px — video frame thumbnail max dimension

# Where video frames are taken from; the index is part of the thumbnail cache key.
FRAME_POSITIONS = [0.08, 0.25, 0.50, 0.72, 0.90]
SINGLE_FRAME_IDX = 2  # one-frame previews (favorites/wallpapers) use the middle frame


def resize_image_to_bytes(src: Path, max_dim: int = THUMB_MAX) -> bytes | None:
    """Resize image in memory, return JPEG bytes. No disk write."""
    try:
        from PIL import Image, ImageOps
        with Image.open(src) as img:
            # Let JPEGs decode at 1/2–1/8 scale right away. Must come before
            # exif_transpose, which otherwise loads the full-size image.
            img.draft(None, (max_dim, max_dim))
            try:
                # Phone photos store rotation in EXIF; browsers apply it to the
                # original, so the thumbnail must match.
                im = ImageOps.exif_transpose(img)
            except Exception:
                im = img
            im.thumbnail((max_dim, max_dim), Image.LANCZOS)
            buf = io.BytesIO()
            im.convert("RGB").save(buf, "JPEG", quality=82, optimize=True)
            return buf.getvalue()
    except Exception:
        return None


def make_video_thumb(src: Path, dst: Path, position: float) -> bool:
    """Extract video frame → save to disk (expensive, worth caching)."""
    try:
        import cv2
        cap = cv2.VideoCapture(str(src))
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        if total > 0:
            cap.set(cv2.CAP_PROP_POS_FRAMES, max(0, int(total * position) - 1))
        ret, frame = cap.read()
        cap.release()
        if ret:
            h, w = frame.shape[:2]
            scale = min(THUMB_MAX / w, THUMB_MAX / h)
            if scale < 1.0:
                frame = cv2.resize(frame, (int(w * scale), int(h * scale)),
                                   interpolation=cv2.INTER_LANCZOS4)
            if cv2.imwrite(str(dst), frame, [cv2.IMWRITE_JPEG_QUALITY, 82]):
                return True
    except ImportError:
        pass
    except Exception:
        pass

    # Fallback: ffmpeg
    try:
        probe = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", str(src)],
            capture_output=True, text=True, timeout=10
        )
        duration = 60.0
        if probe.returncode == 0:
            info = json.loads(probe.stdout)
            duration = float(info.get("format", {}).get("duration", 60))
        seek = duration * position
        r = subprocess.run(
            ["ffmpeg", "-ss", str(seek), "-i", str(src),
             "-vframes", "1",
             "-vf", f"scale={THUMB_MAX}:{THUMB_MAX}:force_original_aspect_ratio=decrease",
             "-y", str(dst)],
            capture_output=True, timeout=30
        )
        return r.returncode == 0 and dst.exists() and dst.stat().st_size > 0
    except Exception:
        return False


def read_text(path: Path) -> str:
    """First MAX_TEXT_SIZE chars of a text file. Reads only the head of the file;
    falls back to cp1251 (Russian .txt/.srt) instead of latin-1."""
    try:
        with open(path, "rb") as f:
            raw = f.read(MAX_TEXT_SIZE * 4)  # utf-8 is at most 4 bytes per char
    except OSError:
        return ""
    if raw.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        encodings = ("utf-16",)
    else:
        encodings = ("utf-8-sig", "cp1251")
    for enc in encodings:
        try:
            # Incremental decoder tolerates a multibyte char cut off at the end.
            return codecs.getincrementaldecoder(enc)().decode(raw)[:MAX_TEXT_SIZE]
        except UnicodeDecodeError:
            continue
    return raw.decode("cp1251", errors="replace")[:MAX_TEXT_SIZE]


def with_counts(data: dict) -> dict:
    """Final step for a folder card (after any file filters): counters, and the
    photo list cut down to the card preview. The rest is fetched by "+N ещё"
    through /api/folder-images, so a folder with 20k photos doesn't send them all."""
    data["total_images"] = len(data["images"])
    data["total_videos"] = len(data["videos"])
    data["images"] = data["images"][:MAX_PHOTOS_IN_CARD]
    data["images_hidden"] = data["total_images"] - len(data["images"])
    return data


def image_entry(e: os.DirEntry) -> dict:
    return {"name": e.name, "path": e.path, "best_level": parse_best_level(e.name)}


def file_filter(min_file_best: int, search_file_lower: str) -> Callable[[dict], bool]:
    """File-level filters of the browse view, shared with /api/folder-images."""
    def ok(f: dict) -> bool:
        return (f.get("best_level", 0) >= min_file_best
                and (not search_file_lower or search_file_lower in fold(f["name"])))
    return ok


def video_frames(st: os.stat_result, indices=range(len(FRAME_POSITIONS))) -> list[dict]:
    return [{"url": f"/thumb/{thumb_path(st, i).name}", "idx": i, "pos": FRAME_POSITIONS[i]}
            for i in indices]


def scan_folder(folder: Path, root: Path) -> Optional[dict]:
    """Full folder contents (all files); callers filter, then call with_counts."""
    entries = list_dir(folder)
    if entries is None:
        return None

    videos, images, texts = [], [], []
    for f in entries:
        ft = media_type(f)
        if ft == "other" or not is_file(f):
            continue
        if ft == "video": videos.append(f)
        elif ft == "image": images.append(f)
        elif ft == "text":  texts.append(f)

    if not videos and not images:
        return None

    # Per-file entries are kept minimal (flat mode can send tens of thousands):
    # thumbnail URLs for images are built by the client from the path.
    video_data = []
    for v in videos:
        try:
            st = v.stat()
        except OSError:
            continue
        video_data.append({
            "name": v.name, "path": v.path, "frames": video_frames(st),
            "best_level": parse_best_level(v.name),
        })

    image_data = [image_entry(img) for img in images]

    text_data = []
    for t in texts:
        content = read_text(t.path)
        if content:
            text_data.append({"name": t.name, "path": t.path, "content": content})

    try:
        rel = str(folder.relative_to(root))
    except ValueError:
        rel = folder.name

    return {
        "name": folder.name,
        "path": str(folder),
        "rel": rel,
        "parent": folder.parent.name,
        "best_level": parse_best_level(folder.name, is_dir=True),
        "is_wallpaper": has_wallpaper_tag(folder.name, is_dir=True),
        "videos": video_data,
        "images": image_data,
        "texts": text_data,
    }


# ── Browse paging ──────────────────────────────────────────────────────────────
# /api/browse returns folders page by page; the client asks for the next page
# as the user scrolls. A page ends at whichever limit comes first. The time
# budget makes rare matches (a file search over a whole drive) stream in
# instead of the first page waiting for the full scan.
PAGE_FOLDERS = 30
PAGE_FILES = 3000
PAGE_SECONDS = 1.0

# What a listing is built from (browse: candidate folders; favorites/wallpapers:
# tagged items) is computed on its first page and reused by the next ones: no
# re-walk per page, and offsets stay valid even if the tree changes while the
# user scrolls. A new listing (browse page 0, a tab opened) recomputes it.
_listing_cache: "OrderedDict[tuple, object]" = OrderedDict()
_listing_lock = threading.Lock()
LISTING_CACHE_SIZE = 8


def _listing_get(key: tuple):
    with _listing_lock:
        found = _listing_cache.get(key)
        if found is not None:
            _listing_cache.move_to_end(key)
        return found


def _listing_put(key: tuple, value) -> None:
    with _listing_lock:
        _listing_cache[key] = value
        _listing_cache.move_to_end(key)
        while len(_listing_cache) > LISTING_CACHE_SIZE:
            _listing_cache.popitem(last=False)


def browse_candidates(cur: Path, dirs: list[Path], recursive: bool, cat_filter: set[str],
                      search_folder_lower: str, min_folder_best: int,
                      with_subfolders: bool) -> list[Path]:
    """Folders that may appear in the listing: everything decidable from folder
    names alone. Filters on folder contents are applied page by page."""
    # Recursive in flat mode / any deep search, OR when category filter is active
    # (categories may be deep in the tree, non-recursive scan misses them)
    if recursive or cat_filter:
        to_scan = [
            p for p, entries in walk_dirs(cur)
            if any(media_type(f) in ("video", "image") and is_file(f) for f in entries)
        ]
    elif with_subfolders:
        # Current dir + immediate subfolders
        to_scan = [cur] + dirs
    else:
        # Without "Всё в одном списке": just the current folder — its subfolders
        # are opened from the tree (their videos used to fill the page, e.g. a
        # disk root showed the whole first level of the disk)
        to_scan = [cur]

    candidates = []
    for folder in to_scan:
        name_lower = fold(folder.name)
        if cat_filter and name_lower not in cat_filter and fold(folder.parent.name) not in cat_filter:
            continue
        if min_folder_best > 0 and parse_best_level(folder.name, is_dir=True) < min_folder_best:
            continue
        # Folder name search (independent of file search)
        if search_folder_lower and search_folder_lower not in name_lower:
            continue
        candidates.append(folder)
    return candidates


def scan_filtered(folder: Path, root_path: Path, min_file_best: int,
                  search_file_lower: str, media_filter: str) -> Optional[dict]:
    """Folder card with file-level filters applied, or None if nothing is left."""
    data = scan_folder(folder, root_path)
    if not data:
        return None

    # Star level and file name search (they filter files, not the folder itself)
    if min_file_best > 0 or search_file_lower:
        ok = file_filter(min_file_best, search_file_lower)
        data["videos"] = [v for v in data["videos"] if ok(v)]
        data["images"] = [i for i in data["images"] if ok(i)]
        if not data["videos"] and not data["images"]:
            return None

    data = apply_media_filter(data, media_filter)
    # Counters and card preview must reflect the filtered lists
    return with_counts(data) if data else None


def apply_media_filter(data: dict, media: str) -> Optional[dict]:
    """"videos" / "photos" view: keep only that kind; None if the folder has none."""
    if media == "videos":
        if not data["videos"]:
            return None
        data["images"] = []
    elif media == "photos":
        if not data["images"]:
            return None
        data["videos"] = []
    return data


# ── API ────────────────────────────────────────────────────────────────────────

@app.get("/api/browse")
def browse(
    root: str = Query(...),
    path: str = Query(""),
    flat: bool = Query(False),
    search: str = Query(""),         # search by filenames
    search_deep: bool = Query(False),  # file search goes through all nested folders
    search_folder: str = Query(""),  # search by folder name
    categories: str = Query(""),
    min_folder_best: int = Query(0),
    min_file_best: int = Query(0),
    media_filter: str = Query("all"),  # "all" | "videos" | "photos"
    offset: int = Query(0, ge=0),      # paging: next_offset from the previous page
):
    root_path = open_root(root)
    cur = open_subdir(root_path, path)

    cat_filter          = {fold(c.strip()) for c in categories.split(",") if c.strip()}
    search_file_lower   = fold(search.strip())
    search_folder_lower = fold(search_folder.strip())

    # "Во всех подпапках" checkbox: a file name search goes through the whole
    # subtree of the current folder, not just it and its direct subfolders.
    # A folder name search always does — like the sidebar tree, which shows
    # matches at any depth.
    recursive = flat or (search_deep and bool(search_file_lower)) or bool(search_folder_lower)
    # Otherwise the listing is the current folder only. A file name search
    # without that checkbox still covers the direct subfolders (as its tooltip
    # says), and so does the folder star filter — it is about subfolders.
    with_subfolders = bool(search_file_lower) or min_folder_best > 0

    key = ("browse", str(cur), recursive, frozenset(cat_filter), search_folder_lower,
           min_folder_best, with_subfolders)
    candidates = _listing_get(key) if offset else None
    dirs: list[Path] = []
    if candidates is None:
        dirs = subdirs(cur)
        candidates = browse_candidates(cur, dirs, recursive, cat_filter,
                                       search_folder_lower, min_folder_best, with_subfolders)
        _listing_put(key, candidates)

    result: list[dict] = []
    n_files = 0
    i = offset
    deadline = time.monotonic() + PAGE_SECONDS
    while i < len(candidates):
        data = scan_filtered(candidates[i], root_path, min_file_best,
                             search_file_lower, media_filter)
        i += 1
        if data:
            result.append(data)
            n_files += data["total_images"] + data["total_videos"]
        if len(result) >= PAGE_FOLDERS or n_files >= PAGE_FILES or time.monotonic() > deadline:
            break

    response = {
        "root": str(root_path),
        "folders": result,
        "next_offset": i if i < len(candidates) else None,
        "candidates": len(candidates),  # upper bound of folders in the whole listing
    }
    if offset == 0:  # sidebar data is needed once per listing
        response["subfolders"] = [subfolder_info(e, root_path) for e in dirs]
        response["breadcrumbs"] = breadcrumbs(root_path, cur)
    return response


def breadcrumbs(root_path: Path, cur: Path) -> list[dict]:
    crumbs = [{"name": root_path.name, "path": ""}]
    parts = cur.relative_to(root_path).parts
    for n, part in enumerate(parts):
        crumbs.append({"name": part, "path": "/".join(parts[: n + 1])})
    return crumbs


@app.get("/api/search-folders")
def search_folders(root: str = Query(...), q: str = Query(...)):
    root_path = open_root(root)

    q_lower = fold(q.strip())
    if not q_lower:
        return {"results": []}

    results: list[dict] = []
    for p, _ in walk_dirs(root_path):
        if p == root_path or q_lower not in fold(p.name):
            continue
        rel = p.relative_to(root_path)
        results.append({
            "name": p.name,
            "path": "/".join(rel.parts),
            "parts": list(rel.parts),
            "best_level": parse_best_level(p.name, is_dir=True),
        })
        if len(results) >= 300:
            break
    return {"results": results}


@app.get("/api/children")
def get_children(root: str = Query(...), path: str = Query("")):
    """Return immediate subdirectories of a given path (for sidebar tree expansion,
    and the sidebar of tabs other than Просмотр — hence the breadcrumbs)."""
    root_path = open_root(root)
    cur = open_subdir(root_path, path)
    return {"children": [subfolder_info(e, root_path) for e in subdirs(cur)],
            "breadcrumbs": breadcrumbs(root_path, cur)}


@app.get("/api/categories")
def get_categories(root: str = Query(...), path: str = Query("")):
    root_path = open_root(root)
    cur = open_subdir(root_path, path)

    cats: set[str] = set()
    for _, entries in walk_dirs(cur, max_depth=8):
        cats.update(e.name for e in entries if is_dir(e))
    return {"categories": sorted(cats, key=fold)}


@app.get("/thumb/{filename}")
def get_thumb(filename: str):
    p = THUMB_DIR / filename
    try:
        st = p.stat()
    except OSError:
        raise HTTPException(404, "Not cached yet")
    if time.time() - st.st_mtime > 86400:
        # mtime = "last used" for LRU pruning; bumped at most once a day per file
        try:
            os.utime(p)
        except OSError:
            pass
    return FileResponse(p, media_type="image/jpeg",
                        headers={"Cache-Control": "public, max-age=86400"})


# Photo previews are decoded in a pool of their own, bounded like video frames.
# A JPEG takes ~0.1 s of CPU, but a HEIC (iPhone) photo ~1 s and libheif uses
# several threads per photo; one browser asks for 6 at once, phones in LAN
# mode for more — the default executor ran them all and loaded every core.
_image_pool = ThreadPoolExecutor(max_workers=min(3, os.cpu_count() or 2),
                                 thread_name_prefix="images")


@app.get("/api/thumb")
async def api_thumb(src: str = Query(...),
                    max_dim: int = Query(THUMB_MAX, alias="max", ge=16, le=8192)):
    """Resize image on-the-fly and stream back. No disk write — browser handles caching.
    Runs PIL in a thread pool so concurrent requests don't block each other.
    Also used by the modal for formats browsers can't show (HEIC, TIFF)."""
    p = open_file(src)
    loop = asyncio.get_running_loop()
    data = await loop.run_in_executor(_image_pool, resize_image_to_bytes, p, max_dim)
    if data is None:
        raise HTTPException(500, "Could not process image")
    return Response(
        content=data,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=86400"},
    )


# ── Video frame cache ─────────────────────────────────────────────────────────

# Frames are decoded in a small dedicated pool. Decoding is CPU-heavy (and cv2
# is multithreaded itself); in FastAPI's shared threadpool a screenful of
# frames used to occupy every thread and stall browse/search for seconds.
_frame_pool = ThreadPoolExecutor(max_workers=min(4, os.cpu_count() or 2),
                                 thread_name_prefix="frames")

# One lock per thumbnail: hover-preload and lazy-load often request the same
# frame at once; without it two threads write the same file concurrently.
_thumb_locks: dict[str, threading.Lock] = {}
_thumb_locks_guard = threading.Lock()


def _thumb_lock(key: str) -> threading.Lock:
    with _thumb_locks_guard:
        return _thumb_locks.setdefault(key, threading.Lock())


# The cache is bounded: least recently used frames (deleted or replaced videos
# leave such orphans) are evicted once it grows past CC_THUMB_CACHE_MB.
THUMB_CACHE_MAX_BYTES = int(os.environ.get("CC_THUMB_CACHE_MB", "1024")) * 1024 * 1024
PRUNE_EVERY = 200  # new frames between pruning passes
_prune_lock = threading.Lock()
_written_since_prune = 0


def prune_thumb_cache() -> None:
    if not _prune_lock.acquire(blocking=False):
        return  # a pass is already running
    try:
        files = []
        with os.scandir(THUMB_DIR) as it:
            for e in it:
                if e.name.endswith(".jpg"):
                    try:
                        st = e.stat()
                    except OSError:
                        continue
                    files.append((st.st_mtime, st.st_size, e.path))
        total = sum(size for _, size, _ in files)
        for _, size, path in sorted(files):  # oldest "last used" first
            if total <= THUMB_CACHE_MAX_BYTES:
                break
            try:
                os.remove(path)
                total -= size
            except OSError:
                pass
    finally:
        _prune_lock.release()


def _generate_frame(src_path: Path, tp: Path, idx: int) -> None:
    global _written_since_prune
    with _thumb_lock(tp.name):
        if tp.exists():
            return
        # Write to a temp file and rename: /thumb/ never sees a half-written jpg
        tmp = tp.with_name(tp.stem + ".tmp.jpg")
        if not make_video_thumb(src_path, tmp, FRAME_POSITIONS[idx]):
            tmp.unlink(missing_ok=True)
            raise HTTPException(500, "Video frame extraction failed")
        os.replace(tmp, tp)
    _written_since_prune += 1
    if _written_since_prune >= PRUNE_EVERY:
        _written_since_prune = 0
        threading.Thread(target=prune_thumb_cache, daemon=True).start()


threading.Thread(target=prune_thumb_cache, daemon=True).start()  # once at startup


@app.get("/api/gen-thumb")
async def gen_thumb(
    src: str = Query(...),
    idx: int = Query(0),
    kind: str = Query("video"),
):
    """Generate and cache a video frame on disk (extraction is expensive).
    The position comes from idx, so a cached frame always matches its slot."""
    if kind != "video":
        raise HTTPException(400, "Use /api/thumb for images")
    if not 0 <= idx < len(FRAME_POSITIONS):
        raise HTTPException(400, "Bad frame index")
    src_path = open_file(src)
    tp = thumb_path(src_path.stat(), idx)
    if not tp.exists():
        await asyncio.get_running_loop().run_in_executor(
            _frame_pool, _generate_frame, src_path, tp, idx)
    return {"url": f"/thumb/{tp.name}"}


@app.get("/api/open")
def open_location(path: str = Query(...)):
    p = ensure_allowed(norm(path))
    if not p.exists():
        raise HTTPException(404, "Path not found")
    system = platform.system()
    try:
        if system == "Darwin":
            subprocess.Popen(["open", "-R", str(p)])
        elif system == "Windows":
            subprocess.Popen(["explorer", "/select,", str(p)])
        else:
            subprocess.Popen(["xdg-open", str(p.parent if p.is_file() else p)])
        return {"ok": True}
    except Exception as e:
        raise HTTPException(500, str(e))


_MIME = {
    ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
    ".avi": "video/x-msvideo", ".mkv": "video/x-matroska",
    ".webm": "video/webm", ".wmv": "video/x-ms-wmv",
    ".flv": "video/x-flv", ".ts": "video/mp2t",
    ".3gp": "video/3gpp", ".mts": "video/mp2t", ".m2ts": "video/mp2t",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".png": "image/png", ".gif": "image/gif",
    ".webp": "image/webp", ".heic": "image/heic", ".heif": "image/heif",
    ".txt": "text/plain", ".md": "text/markdown",
    ".pdf": "application/pdf",
}


@app.get("/file")
def serve_file(request: Request, path: str = Query(...)):
    p = open_file(path)

    file_size = p.stat().st_size
    media_type = _MIME.get(p.suffix.lower(), "application/octet-stream")
    range_header = request.headers.get("Range")

    CHUNK = 1 << 16  # 64 KB

    def stream_range(start: int, end: int):
        with open(p, "rb") as f:
            f.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                data = f.read(min(CHUNK, remaining))
                if not data:
                    break
                yield data
                remaining -= len(data)

    if not range_header:
        # Full file with Accept-Ranges so browser knows seeking is supported
        return StreamingResponse(
            stream_range(0, file_size - 1),
            media_type=media_type,
            headers={
                "Accept-Ranges": "bytes",
                "Content-Length": str(file_size),
            },
        )

    # Parse "bytes=start-end" (end may be omitted)
    try:
        raw = range_header.strip().removeprefix("bytes=")
        s, e = raw.split("-")
        start = int(s)
        end = int(e) if e else file_size - 1
        end = min(end, file_size - 1)
    except Exception:
        raise HTTPException(416, "Invalid Range header")

    if start > end or start >= file_size:
        raise HTTPException(416, "Range Not Satisfiable")

    chunk_len = end - start + 1
    return StreamingResponse(
        stream_range(start, end),
        status_code=206,
        media_type=media_type,
        headers={
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Accept-Ranges": "bytes",
            "Content-Length": str(chunk_len),
        },
    )


@app.get("/api/clear-cache")
def clear_cache():
    count = 0
    for f in THUMB_DIR.glob("*.jpg"):
        f.unlink(missing_ok=True)
        count += 1
    return {"deleted": count}


@app.get("/api/folder-images")
def folder_images(
    path: str = Query(...),
    offset: int = Query(0, ge=0),
    limit: int = Query(240, ge=1, le=1000),
    min_file_best: int = Query(0),
    search: str = Query(""),
):
    """Photos of one folder beyond its card preview ("+N ещё"), in batches,
    with the same file filters as the listing the card came from."""
    folder = ensure_allowed(norm(path))
    entries = list_dir(folder)
    if entries is None:
        raise HTTPException(404)
    ok = file_filter(min_file_best, fold(search.strip()))
    images = [d for d in (image_entry(e) for e in entries
                          if media_type(e) == "image" and is_file(e)) if ok(d)]
    return {"images": images[offset:offset + limit], "total": len(images)}


# ── Favorites / Wallpapers (paged) ────────────────────────────────────────────
# The tree walk finds tagged folders and files by name only (cheap). It runs
# when the tab is opened (fresh=1); filter changes and the following pages
# reuse its result. Folder cards are scanned page by page, like in browse.
# Order of a listing: folders, then videos, then photos, so the client can keep
# appending to the current section as pages arrive.
TAG_PAGE_LOOSE_FILES = 300  # single tagged files per page


def media_file_entry(path: str, name: str, folder: Path, ft: str) -> Optional[dict]:
    """A single tagged file. Videos get one preview frame (the middle one),
    shared with the browse view's cache."""
    entry = {
        "name": name,
        "path": path,
        "best_level": parse_best_level(name),
        "type": ft,
        "folder_name": folder.name,
        "folder_path": str(folder),
    }
    if ft == "video":
        try:
            entry["frames"] = video_frames(os.stat(path), [SINGLE_FRAME_IDX])
        except OSError:
            return None
    return entry


def collect_tagged(root_path: Path, folder_matches: Callable[[str], bool],
                   file_matches: Callable[[str], bool]) -> dict:
    """Walk the tree: tagged folders and tagged media files, by name only."""
    folders: list[Path] = []
    videos: list[tuple] = []
    images: list[tuple] = []
    for p, entries in walk_dirs(root_path, max_depth=10):
        tagged_folder = p != root_path and folder_matches(p.name)
        has_media = False
        for f in entries:
            if not (tagged_folder and not has_media) and not file_matches(f.name):
                continue
            ft = media_type(f)
            if ft not in ("video", "image") or not is_file(f):
                continue
            has_media = True
            if file_matches(f.name):
                (videos if ft == "video" else images).append((f.path, f.name, p))
        # Like before: a tagged folder is listed if media lies directly in it
        if tagged_folder and has_media:
            folders.append(p)
    return {"folders": folders, "videos": videos, "images": images}


def tagged_page(root_path: Path, tags: dict, level: int, media: str, offset: int) -> dict:
    """One page of a tagged listing. level: 0 = any, N = exactly N stars."""
    def lvl_ok(name: str, folder: bool = False) -> bool:
        return level == 0 or parse_best_level(name, is_dir=folder) == level

    folders = [p for p in tags["folders"] if lvl_ok(p.name, True)]
    videos = [v for v in tags["videos"] if lvl_ok(v[1])] if media != "photos" else []
    images = [i for i in tags["images"] if lvl_ok(i[1])] if media != "videos" else []
    listing = ([("folder", p) for p in folders]
               + [("video", *v) for v in videos] + [("image", *i) for i in images])

    items: list[dict] = []
    n_folders = n_loose = n_files = 0
    i = offset
    deadline = time.monotonic() + PAGE_SECONDS
    while i < len(listing):
        kind, *rest = listing[i]
        i += 1
        if kind == "folder":
            data = scan_folder(rest[0], root_path)
            data = apply_media_filter(data, media) if data else None
            if data:
                items.append({"kind": "folder", **with_counts(data)})
                n_folders += 1
                n_files += data["total_images"] + data["total_videos"]
        else:
            entry = media_file_entry(*rest, kind)
            if entry:
                items.append({"kind": "file", **entry})
                n_loose += 1
        if (n_folders >= PAGE_FOLDERS or n_loose >= TAG_PAGE_LOOSE_FILES
                or n_files >= PAGE_FILES or time.monotonic() > deadline):
            break

    return {
        "items": items,
        "next_offset": i if i < len(listing) else None,
        # sizes of this filtered listing (folders: upper bound under a media filter)
        "counts": {"folders": len(folders), "videos": len(videos), "photos": len(images)},
        # everything tagged, regardless of filters (tab badge)
        "total": len(tags["folders"]) + len(tags["videos"]) + len(tags["images"]),
    }


def _tags_for(kind: str, root: str, fresh: bool, folder_matches, file_matches) -> tuple[Path, dict]:
    root_path = open_root(root)
    key = ("tags", kind, str(root_path))
    tags = None if fresh else _listing_get(key)
    if tags is None:
        tags = collect_tagged(root_path, folder_matches, file_matches)
        _listing_put(key, tags)
    return root_path, tags


@app.get("/api/favorites")
def get_favorites(
    root: str = Query(...),
    level: int = Query(0, ge=0, le=3),  # 0 = all favorites, N = exactly N stars
    media: str = Query("all"),          # "all" | "videos" | "photos"
    offset: int = Query(0, ge=0),
    fresh: bool = Query(False),         # re-walk the tree (tab opened) instead of reusing it
):
    root_path, tags = _tags_for(
        "favorites", root, fresh,
        lambda name: parse_best_level(name, is_dir=True) >= 1,
        lambda name: parse_best_level(name) >= 1,
    )
    return tagged_page(root_path, tags, level, media, offset)


@app.get("/api/wallpapers")
def get_wallpapers(
    root: str = Query(...),
    media: str = Query("all"),
    offset: int = Query(0, ge=0),
    fresh: bool = Query(False),
):
    root_path, tags = _tags_for(
        "wallpapers", root, fresh,
        lambda name: has_wallpaper_tag(name, is_dir=True),
        has_wallpaper_tag,
    )
    return tagged_page(root_path, tags, 0, media, offset)


class RevalidatedStaticFiles(StaticFiles):
    """Without Cache-Control browsers may reuse an old app.js for days after an
    update (heuristic caching). 'no-cache' makes them revalidate via ETag (304)."""
    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers.setdefault("Cache-Control", "no-cache")
        return response


# Static files must be mounted last
app.mount("/", RevalidatedStaticFiles(directory=str(BASE_DIR / "static"), html=True), name="static")
