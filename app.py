import json
import platform
import subprocess
import hashlib
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="ContentChecker")

BASE_DIR = Path(__file__).parent
THUMB_DIR = BASE_DIR / ".thumbnails"
THUMB_DIR.mkdir(exist_ok=True)

VIDEO_EXTS = {".mp4", ".avi", ".mov", ".mkv", ".wmv", ".flv", ".webm", ".m4v", ".ts", ".3gp", ".mts", ".m2ts"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tiff", ".tif", ".heic", ".heif"}
TEXT_EXTS  = {".txt", ".md", ".srt", ".vtt", ".csv", ".log", ".nfo", ".description"}

MAX_TEXT_SIZE = 15_000  # chars per text file
MAX_PHOTOS_IN_CARD = 24


def parse_best_level(name: str) -> int:
    """Count trailing _best tokens in filename stem (max 3)."""
    stem = Path(name).stem
    count = 0
    while stem.endswith("_best"):
        count += 1
        stem = stem[:-5]
    return min(count, 3)


def file_type(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in VIDEO_EXTS: return "video"
    if ext in IMAGE_EXTS: return "image"
    if ext in TEXT_EXTS:  return "text"
    return "other"


def thumb_key(src: str, idx: int = 0) -> str:
    return hashlib.md5(f"{src}_{idx}".encode()).hexdigest()


def thumb_path(src: str, idx: int = 0) -> Path:
    return THUMB_DIR / f"{thumb_key(src, idx)}.jpg"


def make_image_thumb(src: Path, dst: Path) -> bool:
    try:
        from PIL import Image
        with Image.open(src) as img:
            img.thumbnail((480, 360), Image.LANCZOS)
            img.convert("RGB").save(dst, "JPEG", quality=82)
        return True
    except Exception:
        return False


def make_video_thumb(src: Path, dst: Path, position: float) -> bool:
    # Try opencv first
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
            scale = min(480 / w, 360 / h)
            frame = cv2.resize(frame, (int(w * scale), int(h * scale)))
            cv2.imwrite(str(dst), frame, [cv2.IMWRITE_JPEG_QUALITY, 82])
            return True
    except ImportError:
        pass
    except Exception:
        pass

    # Fallback: ffmpeg
    try:
        # Get duration
        probe = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", str(src)],
            capture_output=True, text=True, timeout=10
        )
        duration = 60.0
        if probe.returncode == 0:
            info = json.loads(probe.stdout)
            duration = float(info.get("format", {}).get("duration", 60))

        seek = duration * position
        subprocess.run(
            ["ffmpeg", "-ss", str(seek), "-i", str(src),
             "-vframes", "1", "-vf", "scale=480:360:force_original_aspect_ratio=decrease",
             "-y", str(dst)],
            capture_output=True, timeout=30
        )
        return dst.exists()
    except Exception:
        return False


def read_text(path: Path) -> str:
    for enc in ("utf-8", "utf-8-sig", "latin-1"):
        try:
            return path.read_text(encoding=enc)[:MAX_TEXT_SIZE]
        except Exception:
            continue
    return ""


def scan_folder(folder: Path, root: Path) -> Optional[dict]:
    if not folder.is_dir():
        return None

    videos, images, texts = [], [], []
    try:
        for f in sorted(folder.iterdir()):
            if not f.is_file():
                continue
            ft = file_type(f)
            if ft == "video": videos.append(f)
            elif ft == "image": images.append(f)
            elif ft == "text":  texts.append(f)
    except PermissionError:
        return None

    if not videos and not images:
        return None

    FRAME_POSITIONS = [0.08, 0.25, 0.50, 0.72, 0.90]

    video_data = []
    for v in videos:
        frames = []
        for i, pos in enumerate(FRAME_POSITIONS):
            tp = thumb_path(str(v), i)
            frames.append({
                "url": f"/thumb/{tp.name}",
                "cached": tp.exists(),
                "src": str(v),
                "idx": i,
                "pos": pos,
            })
        video_data.append({"name": v.name, "path": str(v), "frames": frames, "best_level": parse_best_level(v.name)})

    image_data = []
    for img in images:
        tp = thumb_path(str(img))
        image_data.append({
            "name": img.name,
            "path": str(img),
            "url": f"/thumb/{tp.name}",
            "cached": tp.exists(),
            "src": str(img),
            "best_level": parse_best_level(img.name),
        })

    text_data = []
    for t in texts:
        content = read_text(t)
        if content:
            text_data.append({"name": t.name, "path": str(t), "content": content})

    try:
        rel = str(folder.relative_to(root))
    except ValueError:
        rel = folder.name

    return {
        "name": folder.name,
        "path": str(folder),
        "rel": rel,
        "parent": folder.parent.name,
        "best_level": parse_best_level(folder.name),
        "videos": video_data,
        "images": image_data,
        "texts": text_data,
        "total_images": len(images),
        "total_videos": len(videos),
    }


# ── API ────────────────────────────────────────────────────────────────────────

@app.get("/api/browse")
def browse(
    root: str = Query(...),
    path: str = Query(""),
    flat: bool = Query(False),
    search: str = Query(""),
    categories: str = Query(""),
    min_folder_best: int = Query(0),
    min_file_best: int = Query(0),
    media_filter: str = Query("all"),  # "all" | "videos" | "photos"
):
    root_path = Path(root).resolve()
    if not root_path.is_dir():
        raise HTTPException(400, f"Not a directory: {root}")

    cur = (root_path / path).resolve() if path else root_path
    if not cur.is_dir():
        raise HTTPException(400, f"Not a directory: {cur}")

    # Immediate subfolders (for sidebar)
    try:
        subfolders = sorted(
            [{"name": e.name, "path": str(e.relative_to(root_path)), "full": str(e)}
             for e in cur.iterdir() if e.is_dir()],
            key=lambda x: x["name"].lower(),
        )
    except PermissionError:
        subfolders = []

    # Collect folders to scan
    to_scan: list[Path] = []

    if flat:
        def collect_recursive(p: Path):
            try:
                entries = list(p.iterdir())
            except PermissionError:
                return
            has_media = any(
                file_type(f) in ("video", "image") for f in entries if f.is_file()
            )
            if has_media:
                to_scan.append(p)
            for d in sorted(entries):
                if d.is_dir():
                    collect_recursive(d)

        collect_recursive(cur)
    else:
        # Current dir + immediate subfolders
        to_scan = [cur] + [Path(sf["full"]) for sf in subfolders]

    # Filters
    cat_filter = {c.strip().lower() for c in categories.split(",") if c.strip()}
    search_lower = search.strip().lower()

    result = []
    for folder in to_scan:
        data = scan_folder(folder, root_path)
        if not data:
            continue

        if cat_filter:
            if data["name"].lower() not in cat_filter and data["parent"].lower() not in cat_filter:
                continue

        if min_folder_best > 0 and data.get("best_level", 0) < min_folder_best:
            continue

        if min_file_best > 0:
            data["videos"] = [v for v in data["videos"] if v.get("best_level", 0) >= min_file_best]
            data["images"] = [i for i in data["images"] if i.get("best_level", 0) >= min_file_best]
            if not data["videos"] and not data["images"]:
                continue

        if search_lower:
            folder_hit = search_lower in data["name"].lower()
            vids = [v for v in data["videos"] if search_lower in v["name"].lower()]
            imgs = [i for i in data["images"] if search_lower in i["name"].lower()]
            if not folder_hit and not vids and not imgs:
                continue
            if not folder_hit:
                data["videos"] = vids
                data["images"] = imgs

        # Media type filter
        if media_filter == "videos":
            if not data["videos"]:
                continue
            data["images"] = []
            data["images_preview"] = []
            data["images_hidden"] = 0
            data["total_images"] = 0
        elif media_filter == "photos":
            if not data["images"]:
                continue
            data["videos"] = []
            data["total_videos"] = 0

        # Limit images shown in card (keep all for count)
        if len(data["images"]) > MAX_PHOTOS_IN_CARD:
            data["images_preview"] = data["images"][:MAX_PHOTOS_IN_CARD]
            data["images_hidden"] = data["total_images"] - MAX_PHOTOS_IN_CARD
        else:
            data["images_preview"] = data["images"]
            data["images_hidden"] = 0

        result.append(data)

    # Breadcrumbs
    crumbs = [{"name": root_path.name, "path": ""}]
    if path:
        parts = Path(path).parts
        for i, part in enumerate(parts):
            crumbs.append({"name": part, "path": "/".join(parts[: i + 1])})

    return {
        "root": str(root_path),
        "subfolders": subfolders,
        "breadcrumbs": crumbs,
        "folders": result,
        "total": len(result),
    }


@app.get("/api/categories")
def get_categories(root: str = Query(...), path: str = Query("")):
    root_path = Path(root).resolve()
    cur = (root_path / path).resolve() if path else root_path

    cats: set[str] = set()

    def collect(p: Path, depth: int = 0):
        if depth > 8:
            return
        try:
            for e in p.iterdir():
                if e.is_dir():
                    cats.add(e.name)
                    collect(e, depth + 1)
        except PermissionError:
            pass

    collect(cur)
    return {"categories": sorted(cats, key=str.lower)}


@app.get("/thumb/{filename}")
def get_thumb(filename: str):
    p = THUMB_DIR / filename
    if not p.exists():
        raise HTTPException(404, "Not cached yet")
    return FileResponse(p, media_type="image/jpeg")


@app.get("/api/gen-thumb")
def gen_thumb(
    src: str = Query(...),
    idx: int = Query(0),
    pos: float = Query(0.1),
    kind: str = Query("image"),
):
    src_path = Path(src)
    if not src_path.exists():
        raise HTTPException(404, "Source not found")

    tp = thumb_path(src, idx)
    if tp.exists():
        return {"url": f"/thumb/{tp.name}"}

    ok = make_video_thumb(src_path, tp, pos) if kind == "video" else make_image_thumb(src_path, tp)
    if ok:
        return {"url": f"/thumb/{tp.name}"}
    raise HTTPException(500, "Thumbnail generation failed")


@app.get("/api/open")
def open_location(path: str = Query(...)):
    p = Path(path)
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


@app.get("/file")
def serve_file(path: str = Query(...)):
    p = Path(path)
    if not p.exists() or not p.is_file():
        raise HTTPException(404)
    return FileResponse(p)


@app.get("/api/favorites")
def get_favorites(root: str = Query(...), min_level: int = Query(1)):
    root_path = Path(root).resolve()
    if not root_path.is_dir():
        raise HTTPException(400, f"Not a directory: {root}")

    fav_folders: list[dict] = []
    fav_files: list[dict] = []

    def scan_recursive(p: Path, depth: int = 0):
        if depth > 10:
            return
        try:
            entries = list(p.iterdir())
        except PermissionError:
            return

        # Check folder itself (skip root)
        if p != root_path:
            folder_level = parse_best_level(p.name)
            if folder_level >= min_level:
                data = scan_folder(p, root_path)
                if data:
                    if len(data["images"]) > MAX_PHOTOS_IN_CARD:
                        data["images_preview"] = data["images"][:MAX_PHOTOS_IN_CARD]
                        data["images_hidden"] = data["total_images"] - MAX_PHOTOS_IN_CARD
                    else:
                        data["images_preview"] = data["images"]
                        data["images_hidden"] = 0
                    fav_folders.append(data)

        # Check individual files
        for f in sorted(entries):
            if not f.is_file():
                continue
            ft = file_type(f)
            if ft not in ("video", "image"):
                continue
            flevel = parse_best_level(f.name)
            if flevel >= min_level:
                tp = thumb_path(str(f))
                entry: dict = {
                    "name": f.name,
                    "path": str(f),
                    "best_level": flevel,
                    "type": ft,
                    "folder_name": p.name,
                    "folder_path": str(p),
                    "url": f"/thumb/{tp.name}",
                    "src": str(f),
                    "cached": tp.exists(),
                    "idx": 0,
                    "pos": 0.5,
                }
                fav_files.append(entry)

        for d in sorted(entries):
            if d.is_dir():
                scan_recursive(d, depth + 1)

    scan_recursive(root_path)

    return {
        "favorite_folders": fav_folders,
        "favorite_files": fav_files,
        "total_folders": len(fav_folders),
        "total_files": len(fav_files),
    }


# Static files must be mounted last
app.mount("/", StaticFiles(directory=str(BASE_DIR / "static"), html=True), name="static")
