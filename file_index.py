"""Persistent index of folder trees (SQLite, next to app.py: .index.db).

Favorites, Wallpapers, Теги, the folder search, categories and "Всё в одном
списке" used to walk the whole tree on disk on every request. They now read
this index, which keeps:
  - every folder: its path, parent, whether photos/videos lie directly in it,
    and what its name says (stars, _wallpaper, tags);
  - media files whose names carry anything of that.

A refresh brings a tree up to date cheaply. A folder's mtime changes whenever
an entry is added, removed or renamed in it, so only such folders are listed
again; an unchanged folder costs one stat(). The index survives restarts, so
only the very first visit of a tree pays for a full walk.

Deleting .index.db is always safe, even while the app runs: it is rebuilt on
the next visit. And the app never depends on it: walk_tree() gives the same
tree straight from the disk (as before the index), used whenever the index
can't be opened or fails.
"""
from __future__ import annotations  # annotations below may name sqlite3 types

import logging
import os
import stat as statmod
import threading
import time
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

try:  # some self-built Pythons (pyenv on Linux without libsqlite3-dev) lack it
    import sqlite3
except ImportError:
    sqlite3 = None

log = logging.getLogger("uvicorn.error")

# A folder listed less than this after its last change may have changed again
# within the same mtime tick (FAT32 keeps 2 s, exFAT 10 ms): trust its mtime
# only once the listing is clearly newer.
RACY_NS = 2_000_000_000
# Folders listed longer ago than this are listed again anyway — a safety net
# for disks that don't update folder mtimes reliably.
MAX_AGE_NS = 24 * 3600 * 1_000_000_000
COMMIT_EVERY = 0.25  # s — a long refresh shows its progress to readers

SCHEMA = """
CREATE TABLE dirs (
    id        INTEGER PRIMARY KEY,
    path      TEXT NOT NULL UNIQUE,
    parent    INTEGER REFERENCES dirs(id) ON DELETE CASCADE,
    name      TEXT NOT NULL,
    mtime_ns  INTEGER NOT NULL,
    listed_ns INTEGER NOT NULL,
    has_media INTEGER NOT NULL,
    best      INTEGER NOT NULL,
    wallpaper INTEGER NOT NULL,
    tags      TEXT NOT NULL
);
CREATE INDEX dirs_parent ON dirs(parent);
CREATE TABLE files (
    dir       INTEGER NOT NULL REFERENCES dirs(id) ON DELETE CASCADE,
    name      TEXT NOT NULL,
    kind      TEXT NOT NULL,
    best      INTEGER NOT NULL,
    wallpaper INTEGER NOT NULL,
    tags      TEXT NOT NULL,
    PRIMARY KEY (dir, name)
) WITHOUT ROWID;
CREATE TABLE roots (
    path         TEXT PRIMARY KEY,
    refreshed_ns INTEGER NOT NULL
);
"""

# root's folder and all folders below it, with their depth
SUBTREE = """
WITH RECURSIVE sub(id, depth) AS (
    SELECT id, 0 FROM dirs WHERE path = ?
    UNION ALL
    SELECT d.id, sub.depth + 1 FROM dirs d JOIN sub ON d.parent = sub.id
)"""

# Plain SQL only (no UPSERT / RETURNING): works with whatever SQLite the
# computer's Python comes with, old Linux distributions included.
UPDATE_DIR = """
UPDATE dirs SET parent = ?, name = ?, mtime_ns = ?, listed_ns = ?, has_media = ?,
                best = ?, wallpaper = ?, tags = ?
WHERE path = ?"""
INSERT_DIR = """
INSERT INTO dirs (parent, name, mtime_ns, listed_ns, has_media, best, wallpaper, tags, path)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"""
# A deeper "tree" is a loop on a disk without inode numbers (see _refresh)
MAX_DEPTH = 64

# What app.py tells the index about a folder: names of its subfolders, its
# media files as (name, "video" | "image"), whether any media lies in it.
# None if the folder can't be read.
Lister = Callable[[str], Optional[tuple[list[str], list[tuple[str, str]], bool]]]
# What a name says: (stars, has _wallpaper, tags)
Meta = Callable[[str, bool], tuple[int, bool, list[str]]]


def tags_str(tags: list[str]) -> str:
    """Stored as ' best ah ': each tag can be found with LIKE '% best %'."""
    return f" {' '.join(tags)} " if tags else ""


def like_tag(tag: str) -> str:
    """LIKE pattern for one tag (ESCAPE '\\')."""
    t = tag.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"% {t} %"


@dataclass(slots=True)
class Dir:
    id: int
    path: str
    name: str
    depth: int  # below the tree's root (0 = the root itself)
    has_media: bool
    best: int
    wallpaper: bool
    tags: str


@dataclass(slots=True)
class File:
    dir: Dir
    name: str
    kind: str
    best: int
    wallpaper: bool
    tags: str

    @property
    def path(self) -> str:
        return os.path.join(self.dir.path, self.name)


FilePred = Callable[[File], bool]


class Tree:
    """A tree as the index knows it: folders depth-first, siblings sorted by
    name — the order of the disk walk this replaces."""

    def __init__(self, index: FileIndex, root: str, dirs: list[Dir]):
        self._index = index
        self.root = root
        self.dirs = dirs

    def files(self, pred: Optional[FilePred] = None, sql: Optional[str] = None,
              params: tuple = ()) -> list[File]:
        """Tagged media files of the tree for which pred() is true, in tree
        order. sql (+ params), a condition on `f`, lets the database narrow
        them down first; it must not reject anything pred() accepts."""
        if not self.dirs:
            return []
        order = {d.id: i for i, d in enumerate(self.dirs)}
        by_id = {d.id: d for d in self.dirs}
        rows = self._index._conn().execute(
            SUBTREE + f" SELECT f.dir, f.name, f.kind, f.best, f.wallpaper, f.tags"
                      f" FROM files f JOIN sub ON f.dir = sub.id WHERE {sql or '1'}",
            (self.root, *params)).fetchall()
        out = [File(by_id[r[0]], r[1], r[2], r[3], bool(r[4]), r[5]) for r in rows if r[0] in by_id]
        if pred is not None:
            out = [f for f in out if pred(f)]
        key = self._index.sort_key
        out.sort(key=lambda f: (order[f.dir.id], key(f.name)))
        return out


class WalkedTree:
    """The same tree walked on disk right now — what the app falls back to
    when the index can't be used. Same interface and order as Tree."""

    def __init__(self, root: str, dirs: list[Dir], files: dict[int, list[File]]):
        self.root = root
        self.dirs = dirs
        self._files = files

    def files(self, pred: Optional[FilePred] = None, sql: Optional[str] = None,
              params: tuple = ()) -> list[File]:
        return [f for d in self.dirs for f in self._files.get(d.id, ())
                if pred is None or pred(f)]


def walk_tree(root: str, lister: Lister, meta: Meta) -> WalkedTree:
    """Walk root's tree on disk (no database). Folders come depth-first in the
    order lister() gives them (sorted by name), every real folder once."""
    dirs: list[Dir] = []
    files: dict[int, list[File]] = {}
    seen: set = set()
    stack: list[tuple[str, int]] = [(root, 0)]
    while stack:
        path, depth = stack.pop()
        try:
            st = os.stat(path)
        except OSError:
            continue
        ident = _identity(path, st)
        if not statmod.S_ISDIR(st.st_mode) or ident in seen or depth > MAX_DEPTH:
            continue
        seen.add(ident)
        sub, media, has_media = lister(path) or ([], [], False)
        name = os.path.basename(path) or path
        best, wallpaper, tags = meta(name, True)
        d = Dir(len(dirs), path, name, depth, has_media, best, wallpaper, tags_str(tags))
        dirs.append(d)
        found = []
        for fname, kind in media:
            f_best, f_wallpaper, f_tags = meta(fname, False)
            if f_best or f_wallpaper or f_tags:  # what the index would keep
                found.append(File(d, fname, kind, f_best, f_wallpaper, tags_str(f_tags)))
        files[d.id] = found
        stack.extend((os.path.join(path, n), depth + 1) for n in reversed(sub))
    return WalkedTree(root, dirs, files)


def _identity(path: str, st: os.stat_result):
    """A folder's identity, to enter each real folder once: its inode — or, on
    disks that report inode 0 for everything (some network shares, FAT on
    Windows), its real path with symlinks resolved."""
    return (st.st_dev, st.st_ino) if st.st_ino else os.path.realpath(path)


class _Job:
    def __init__(self, root: str):
        self.root = root
        self.done = threading.Event()
        self.error: Optional[BaseException] = None


class FileIndex:
    """Raises (sqlite3 missing, folder not writable…) if it can't be set up —
    the app then walks the disk instead (walk_tree)."""

    def __init__(self, db_path: Path, version: int, lister: Lister, meta: Meta,
                 sort_key: Callable[[str], str]):
        if sqlite3 is None:
            raise RuntimeError("this Python has no sqlite3 module")
        self.db_path = str(db_path)
        self.version = version
        self.lister = lister
        self.meta = meta
        self.sort_key = sort_key
        self._local = threading.local()
        self._write_lock = threading.Lock()  # one refresh at a time
        self._guard = threading.Lock()       # jobs / last_done / reopening
        self._jobs: dict[str, _Job] = {}
        self._last_done: dict[str, float] = {}  # root → monotonic time
        self._generation = 0  # bumped when the file is started over: threads reconnect
        self._file_id = None
        self._open_db()

    # ── Database ─────────────────────────────────────────────────────────────

    def _open_db(self) -> None:
        try:
            self._setup()
        except sqlite3.DatabaseError as e:
            if isinstance(e, sqlite3.OperationalError):
                raise  # can't open or write (permissions, disk full): not damage
            log.warning("Index: %s is damaged (%s), starting a new one", self.db_path, e)
            self._remove_files()
            self._setup()

    def _remove_files(self) -> None:
        for suffix in ("", "-journal", "-wal", "-shm"):
            try:
                os.remove(self.db_path + suffix)
            except OSError:
                pass

    def recover(self, error: BaseException) -> None:
        """Called by the app when using the index failed. A damaged file is
        started over (the next visits rebuild it); other errors (locked,
        read-only) are left alone — the app walks the disk meanwhile."""
        if (sqlite3 and isinstance(error, sqlite3.DatabaseError)
                and not isinstance(error, sqlite3.OperationalError)):
            with self._guard:
                log.warning("Index: %s is damaged (%s), starting a new one", self.db_path, error)
                self._remove_files()
                self._reopen()

    def _reopen(self) -> None:
        """Start over with a fresh file (guard held)."""
        self._setup()
        self._last_done.clear()  # nothing is known any more: the next visit waits for a full walk

    def _setup(self) -> None:
        c = sqlite3.connect(self.db_path)
        try:
            # The classic journal: the index is one file (no -wal/-shm next to
            # it) and works on network and USB drives too. Readers wait at most
            # for one commit of a refresh (COMMIT_EVERY).
            c.execute("PRAGMA journal_mode = DELETE")
            if c.execute("PRAGMA user_version").fetchone()[0] != self.version:
                # New schema, or names are read differently (e.g. how stars
                # are counted): what's stored is outdated — start over.
                c.executescript("DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS dirs;"
                                "DROP TABLE IF EXISTS roots;" + SCHEMA)
                c.execute(f"PRAGMA user_version = {int(self.version)}")
            c.commit()
        finally:
            c.close()
        self._file_id = _file_id(self.db_path)
        self._generation += 1

    def _conn(self) -> sqlite3.Connection:
        """One connection per thread (sqlite3 connections can't be shared)."""
        if _file_id(self.db_path) != self._file_id:
            # .index.db was deleted (or replaced) while the app runs: open
            # connections would go on using the deleted file, new ones would
            # find an empty one — start over with a proper new file
            with self._guard:
                if _file_id(self.db_path) != self._file_id:
                    log.warning("Index: %s was deleted, starting a new one", self.db_path)
                    self._reopen()
        c = getattr(self._local, "conn", None)
        if c is not None and self._local.generation != self._generation:
            c.close()
            c = None
        if c is None:
            # A short busy timeout: if another program locks the file, the
            # request falls back to walking the disk instead of hanging
            c = sqlite3.connect(self.db_path, timeout=5)
            c.execute("PRAGMA foreign_keys = ON")  # deleting a folder deletes its subtree
            c.execute("PRAGMA synchronous = NORMAL")
            self._local.conn = c
            self._local.generation = self._generation
        return c

    def _close(self) -> None:
        c = getattr(self._local, "conn", None)
        if c is not None:
            c.close()
            self._local.conn = None

    # ── Reading ──────────────────────────────────────────────────────────────

    def tree(self, root: str) -> Tree:
        rows = self._conn().execute(
            SUBTREE + " SELECT d.id, d.parent, d.path, d.name, sub.depth, d.has_media,"
                      " d.best, d.wallpaper, d.tags FROM dirs d JOIN sub ON d.id = sub.id",
            (root,)).fetchall()
        top = None
        kids: dict[int, list[Dir]] = defaultdict(list)
        for r in rows:
            d = Dir(r[0], r[2], r[3], r[4], bool(r[5]), r[6], bool(r[7]), r[8])
            if d.depth == 0:
                top = d
            else:
                kids[r[1]].append(d)
        out: list[Dir] = []
        stack = [top] if top else []
        while stack:
            d = stack.pop()
            out.append(d)
            stack.extend(sorted(kids.get(d.id, ()), key=lambda x: self.sort_key(x.name), reverse=True))
        return Tree(self, root, out)

    def indexed(self, root: str) -> bool:
        """Was root, or a folder above it, ever indexed completely?"""
        paths = _self_and_ancestors(root)
        q = f"SELECT 1 FROM roots WHERE path IN ({','.join('?' * len(paths))}) LIMIT 1"
        return self._conn().execute(q, paths).fetchone() is not None

    # ── Refreshing ───────────────────────────────────────────────────────────

    def refresh(self, root: str, wait: Optional[float] = 1.0, min_interval: float = 0) -> bool:
        """Bring root's tree up to date. Waits up to `wait` seconds and lets the
        rest go on in the background — but a tree that was never indexed is
        waited for until done. Skipped if root or a folder above it was
        refreshed less than `min_interval` seconds ago. Returns True if the
        refresh has finished; raises its error if it failed (the index may
        then be out of date — the caller should walk the disk instead)."""
        if not self.indexed(root):
            wait = None
        with self._guard:
            if min_interval:
                now = time.monotonic()
                if any(now - self._last_done.get(p, -1e9) < min_interval
                       for p in _self_and_ancestors(root)):
                    return True
            # A refresh of this tree, or of a tree containing it, is running: wait for it
            job = next((j for p in _self_and_ancestors(root)
                        if (j := self._jobs.get(p)) and not j.done.is_set()), None)
            if job is None:
                job = self._jobs[root] = _Job(root)
                threading.Thread(target=self._run, args=(job,), daemon=True,
                                 name="index-refresh").start()
        finished = job.done.wait(wait)
        if finished and job.error is not None:
            raise job.error
        return finished

    def _run(self, job: _Job) -> None:
        try:
            with self._write_lock:
                t = time.monotonic()
                self._conn()  # (re)opens the file first if it was deleted
                generation = self._generation
                checked, listed = self._refresh(job.root)
                if self._generation != generation:
                    # the file was started over meanwhile: this refresh wrote
                    # into the old one — the next visit refreshes the new one
                    return
                took = time.monotonic() - t
                if listed or took > 1:  # quiet when nothing changed
                    log.info("Index: %s — %d folders checked, %d listed in %.2f s",
                             job.root, checked, listed, took)
            with self._guard:
                self._last_done[job.root] = time.monotonic()
        except Exception as e:
            job.error = e  # handed to whoever waits for this refresh
            log.warning("Index: refreshing %s failed: %s", job.root, e)
        finally:
            self._close()
            job.done.set()

    def _refresh(self, root: str) -> tuple[int, int]:
        c = self._conn()
        # What the index knows about this tree: path → (id, parent, mtime, listed)
        known: dict[str, tuple] = {}
        kids: dict[int, list[str]] = defaultdict(list)  # folder id → subfolder paths
        for id_, parent, path, mtime_ns, listed_ns in c.execute(
                SUBTREE + " SELECT d.id, d.parent, d.path, d.mtime_ns, d.listed_ns"
                          " FROM dirs d JOIN sub ON d.id = sub.id", (root,)):
            known[path] = (id_, parent, mtime_ns, listed_ns)
            if parent is not None:
                kids[parent].append(path)

        above = os.path.dirname(root)
        row = c.execute("SELECT id FROM dirs WHERE path = ?", (above,)).fetchone() if above != root else None
        stack: list[tuple[str, Optional[int], int]] = [(root, row[0] if row else None, 0)]
        seen: set[tuple[int, int]] = set()
        now_ns = time.time_ns()
        checked = listed = 0
        last_commit = time.monotonic()

        while stack:
            path, parent, depth = stack.pop()
            checked += 1
            try:
                st = os.stat(path)
            except OSError:
                st = None
            ident = _identity(path, st) if st is not None else None
            if (st is None or not statmod.S_ISDIR(st.st_mode) or ident in seen
                    or depth > MAX_DEPTH):
                # Gone — or a second way into a folder already indexed (a
                # symlink loop): drop it with everything below it
                c.execute("DELETE FROM dirs WHERE path = ?", (path,))
                continue
            seen.add(ident)

            k = known.get(path)
            if (k and k[2] == st.st_mtime_ns and k[3] - k[2] > RACY_NS
                    and now_ns - k[3] < MAX_AGE_NS):
                dir_id, children = k[0], kids.get(k[0], [])
                if k[1] != parent:
                    c.execute("UPDATE dirs SET parent = ? WHERE id = ?", (parent, dir_id))
            else:
                dir_id, children = self._list(c, path, parent, st.st_mtime_ns)
                listed += 1
            stack.extend((p, dir_id, depth + 1) for p in children)

            if time.monotonic() - last_commit > COMMIT_EVERY:
                c.commit()
                last_commit = time.monotonic()

        c.execute("INSERT OR REPLACE INTO roots (path, refreshed_ns) VALUES (?, ?)", (root, now_ns))
        c.commit()
        return checked, listed

    def _list(self, c: sqlite3.Connection, path: str, parent: Optional[int],
              mtime_ns: int) -> tuple[int, list[str]]:
        """List one folder into the index; returns its id and subfolder paths."""
        listed_ns = time.time_ns()
        listing = self.lister(path)
        sub, media, has_media = listing if listing is not None else ([], [], False)
        name = os.path.basename(path) or path
        best, wallpaper, tags = self.meta(name, True)
        values = (parent, name, mtime_ns, listed_ns, int(has_media), best, int(wallpaper),
                  tags_str(tags), path)
        # UPDATE keeps the folder's id (its subfolders and files point to it)
        if c.execute(UPDATE_DIR, values).rowcount:
            dir_id = c.execute("SELECT id FROM dirs WHERE path = ?", (path,)).fetchone()[0]
        else:
            dir_id = c.execute(INSERT_DIR, values).lastrowid

        c.execute("DELETE FROM files WHERE dir = ?", (dir_id,))
        rows = []
        for fname, kind in media:
            f_best, f_wallpaper, f_tags = self.meta(fname, False)
            if f_best or f_wallpaper or f_tags:  # untagged files aren't needed
                rows.append((dir_id, fname, kind, f_best, int(f_wallpaper), tags_str(f_tags)))
        c.executemany("INSERT INTO files (dir, name, kind, best, wallpaper, tags)"
                      " VALUES (?, ?, ?, ?, ?, ?)", rows)

        children = [os.path.join(path, n) for n in sub]
        keep = set(children)
        for (old,) in c.execute("SELECT path FROM dirs WHERE parent = ?", (dir_id,)).fetchall():
            if old not in keep:
                c.execute("DELETE FROM dirs WHERE path = ?", (old,))  # removed or renamed
        return dir_id, children


def _file_id(path: str):
    try:
        st = os.stat(path)
    except OSError:
        return None
    return st.st_dev, st.st_ino


def _self_and_ancestors(path: str) -> list[str]:
    out = [path]
    while True:
        up = os.path.dirname(out[-1])
        if up == out[-1] or not up:
            return out
        out.append(up)
