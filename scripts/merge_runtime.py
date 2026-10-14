#!/usr/bin/env python3
"""Three-way merge of webcompiled's runtime changes onto ResortCompiled's runtime.

    scripts/merge_runtime.py BASE WEB RESORT OUT [--address-map projects/wsr/address_map.csv]

BASE    WiiCompiled runtime/ at the commit ResortCompiled re-keyed from (a88b7b5)
WEB     webcompiled runtime/ (WiiCompiled bd219e3 + the web port)
RESORT  ResortCompiled runtime/wsr/ (BASE re-keyed to WSR addresses + Resort patches)
OUT     directory to write the merged runtime to (third_party/ and assets/ come from WEB)

Conflict hunks where WEB only renamed RT_LOG -> RT_LOG_INFO (or RT_LOGF -> RT_LOGF_INFO) are
resolved automatically by applying the same rename to RESORT's side, which keeps Resort's
re-keyed addresses. Everything else is left with diff3 markers and listed.

Lines that WEB added are scanned for Mario Kart Wii guest addresses (the mkw_addr column of the
address map). Those would point at unrelated WSR code, so each one is rewritten to its WSR
address when the map has it, and reported either way.
"""
from __future__ import annotations

import argparse
import csv
import difflib
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

VENDORED = {"third_party", "assets"}
LOG_RENAME = re.compile(r"\bRT_LOG(F?)\(")
ADDR = re.compile(r"(?<![0-9A-Fa-fxX])(0x|0X)?(8[01][0-9A-Fa-f]{6})(?![0-9A-Fa-f])")


def files(root: Path) -> set[Path]:
    return {p.relative_to(root) for p in root.rglob("*") if p.is_file() and p.relative_to(root).parts[0] not in VENDORED}


def read(p: Path) -> str | None:
    return p.read_text(encoding="utf-8", errors="surrogateescape") if p.exists() else None


def log_only_rename(base: str, theirs: str) -> bool:
    return base != theirs and LOG_RENAME.sub(r"RT_LOG\1_INFO(", base) == theirs


def resolve_hunks(text: str) -> tuple[str, int]:
    """Resolve diff3 hunks whose 'theirs' side is a pure log rename of 'base'."""
    out, unresolved, i = [], 0, 0
    lines = text.splitlines(keepends=True)
    while i < len(lines):
        if not lines[i].startswith("<<<<<<< "):
            out.append(lines[i]); i += 1; continue
        ours, base, theirs, part, j = [], [], [], "ours", i + 1
        while not lines[j].startswith(">>>>>>> "):
            l = lines[j]
            if l.startswith("||||||| "): part = "base"
            elif l.startswith("======="): part = "theirs"
            else: {"ours": ours, "base": base, "theirs": theirs}[part].append(l)
            j += 1
        b, t = "".join(base), "".join(theirs)
        if log_only_rename(b, t):
            out.append(LOG_RENAME.sub(r"RT_LOG\1_INFO(", "".join(ours)))
        else:
            out.extend(lines[i:j + 1]); unresolved += 1
        i = j + 1
    return "".join(out), unresolved


def merge3(ours: str, base: str, theirs: str) -> tuple[str, int]:
    with tempfile.TemporaryDirectory() as td:
        o, b, t = (Path(td) / n for n in ("ours", "base", "theirs"))
        o.write_text(ours, encoding="utf-8", errors="surrogateescape")
        b.write_text(base, encoding="utf-8", errors="surrogateescape")
        t.write_text(theirs, encoding="utf-8", errors="surrogateescape")
        subprocess.run(["git", "merge-file", "--diff3", "-L", "resort", "-L", "base", "-L", "web",
                        str(o), str(b), str(t)], check=False)
        text = o.read_text(encoding="utf-8", errors="surrogateescape")
    return resolve_hunks(text) if "<<<<<<< " in text else (text, 0)


def rekey_added_lines(merged: str, resort: str | None, base: str | None, mkw_to_wsr: dict[int, int],
                      rel: Path, report: list[str]) -> str:
    """Rewrite MKW addresses on lines that are new relative to both base and resort."""
    known = set((resort or "").splitlines()) | set((base or "").splitlines())
    out = []
    for n, line in enumerate(merged.splitlines(keepends=True), 1):
        if line.rstrip("\r\n") in known or line.startswith(("<<<<<<<", "|||||||", "=======", ">>>>>>>")):
            out.append(line); continue

        def sub(m: re.Match) -> str:
            addr = int(m.group(2), 16)
            if addr not in mkw_to_wsr:
                return m.group(0)
            new = mkw_to_wsr[addr]
            digits = f"{new:08X}" if m.group(2).isupper() or not any(c.isalpha() for c in m.group(2)) else f"{new:08x}"
            report.append(f"{rel}:{n}: rekeyed 0x{addr:08X} -> 0x{new:08X}")
            return (m.group(1) or "") + digits

        out.append(ADDR.sub(sub, line))
    return "".join(out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("base", type=Path)
    ap.add_argument("web", type=Path)
    ap.add_argument("resort", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--address-map", type=Path, default=Path("projects/wsr/address_map.csv"))
    a = ap.parse_args()

    mkw_to_wsr: dict[int, int] = {}
    with a.address_map.open(newline="") as fh:
        for row in csv.DictReader(fh):
            if row.get("wsr_addr"):
                mkw_to_wsr[int(row["mkw_addr"], 16)] = int(row["wsr_addr"], 16)

    if a.out.exists():
        sys.exit(f"{a.out} exists; pass a fresh directory")
    for v in VENDORED:
        if (a.web / v).exists():
            shutil.copytree(a.web / v, a.out / v)

    conflicts, notes, rekeys = [], [], []
    for rel in sorted(files(a.base) | files(a.web) | files(a.resort)):
        b, w, r = read(a.base / rel), read(a.web / rel), read(a.resort / rel)
        if w == b:
            merged = r                          # web did not touch it: Resort's version (or its deletion)
        elif r == b:
            merged = w                          # Resort did not touch it: web's version (or deletion)
            if w is not None:
                merged = rekey_added_lines(w, r, b, mkw_to_wsr, rel, rekeys)
        elif w is None:
            merged = r
            notes.append(f"{rel}: deleted on the web side but changed by Resort; kept Resort's")
        elif r is None:
            merged = None
            notes.append(f"{rel}: deleted by Resort but changed on the web side; left deleted")
        elif b is None:
            merged, n = merge3(r, "", w)
            if n: conflicts.append(f"{rel}: {n} hunk(s) (added on both sides)")
        else:
            merged, n = merge3(r, b, w)
            merged = rekey_added_lines(merged, r, b, mkw_to_wsr, rel, rekeys)
            if n: conflicts.append(f"{rel}: {n} hunk(s)")
        if merged is not None:
            dst = a.out / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_text(merged, encoding="utf-8", errors="surrogateescape")

    for title, items in (("Conflicts left for hand-merging", conflicts), ("Notes", notes),
                         ("MKW addresses rekeyed on web-added lines", rekeys)):
        print(f"## {title} ({len(items)})")
        for item in items:
            print(f"- {item}")
    return 1 if conflicts else 0


if __name__ == "__main__":
    sys.exit(main())
