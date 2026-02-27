#!/usr/bin/env python3
"""
Project Directory Tree Explorer
- Otomatis export struktur folder ke Tree_Project.txt
- Folder yang di-exclude (misal: node_modules) tetap tampil di tree, tapi isi dalamnya tidak di-index
"""

import os
from datetime import datetime

# ── Konfigurasi ────────────────────────────────────────────────────────────────

# Root project yang ingin di-scan (default: folder tempat script ini berada)
ROOT_DIR = os.path.dirname(os.path.abspath(__file__))

# Nama file output
OUTPUT_FILE = "Tree_Project.txt"

# Folder yang tampil di tree tapi isinya TIDAK di-expand
SHALLOW_FOLDERS = {
    "node_modules",
    ".git",
    "__pycache__",
    ".venv",
    "venv",
    "dist",
    "build",
    ".next",
    ".nuxt",
    "vendor",
    "database",
    "session",
    "media",
}

# ── Logic ──────────────────────────────────────────────────────────────────────

def build_tree(
    path: str,
    prefix: str = "",
    shallow_folders: set = None,
    lines: list = None,
) -> list:
    if shallow_folders is None:
        shallow_folders = SHALLOW_FOLDERS
    if lines is None:
        lines = []

    try:
        entries = sorted(os.listdir(path))
    except PermissionError:
        lines.append(f"{prefix}[Permission Denied]")
        return lines

    dirs  = [e for e in entries if os.path.isdir(os.path.join(path, e))]
    files = [e for e in entries if os.path.isfile(os.path.join(path, e))]
    all_entries = dirs + files

    for i, entry in enumerate(all_entries):
        is_last    = i == len(all_entries) - 1
        connector  = "└── " if is_last else "├── "
        entry_path = os.path.join(path, entry)
        is_dir     = os.path.isdir(entry_path)

        label = f"{entry}/" if is_dir else entry
        lines.append(f"{prefix}{connector}{label}")

        if is_dir:
            extension = "    " if is_last else "│   "
            if entry in shallow_folders:
                lines.append(f"{prefix}{extension}└── ...")
            else:
                build_tree(entry_path, prefix + extension, shallow_folders, lines)

    return lines


def export_tree():
    root     = os.path.abspath(ROOT_DIR)
    out_path = os.path.join(root, OUTPUT_FILE)

    lines = [
        f"Project : {os.path.basename(root)}",
        f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        "=" * 50,
        f"{os.path.basename(root)}/",
    ]
    lines += build_tree(root)

    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    print(f"✅ Tree exported → {out_path}")


if __name__ == "__main__":
    export_tree()
