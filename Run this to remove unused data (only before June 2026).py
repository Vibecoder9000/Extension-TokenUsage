#!/usr/bin/env python3
"""Interactively back up SillyTavern settings and remove legacy usage buckets."""

from __future__ import annotations

import json
import re
import shutil
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from tempfile import NamedTemporaryFile


LEGACY_USAGE_KEYS = ("byHour", "byWeek", "byMonth", "byChat")


@dataclass
class TargetInfo:
    path: Path
    user_name: str
    tracker_present: bool
    removable_keys: list[str]


def find_repo_root() -> Path:
    current = Path(__file__).resolve().parent
    for candidate in [current, *current.parents]:
        data_dir = candidate / "data"
        public_dir = candidate / "public"
        if data_dir.is_dir() and public_dir.is_dir():
            return candidate
    raise RuntimeError("Could not locate the SillyTavern repo root from this script location.")


def global_extension_path() -> Path:
    return Path(__file__).resolve().parent


def get_extension_name() -> str:
    index_path = global_extension_path() / "index.js"
    if index_path.is_file():
        contents = index_path.read_text(encoding="utf-8", errors="ignore")
        match = re.search(r"""const\s+extensionName\s*=\s*['"]([^'"]+)['"]""", contents)
        if match:
            return match.group(1)
    return global_extension_path().name


def default_settings_files(root: Path) -> list[Path]:
    return sorted((root / "data").glob("*/settings.json"))


def resolve_targets(root: Path) -> list[Path]:
    explicit_paths = [Path(arg).resolve() for arg in sys.argv[1:]]
    if explicit_paths:
        return explicit_paths
    return [path.resolve() for path in default_settings_files(root)]


def load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError("Top-level JSON value is not an object")
    return data


def inspect_target(path: Path, extension_name: str) -> TargetInfo:
    data = load_json(path)
    extension_settings = data.get("extension_settings")
    tracker_settings = extension_settings.get(extension_name) if isinstance(extension_settings, dict) else None
    usage = tracker_settings.get("usage") if isinstance(tracker_settings, dict) else None
    removable_keys = [key for key in LEGACY_USAGE_KEYS if isinstance(usage, dict) and key in usage]
    return TargetInfo(
        path=path,
        user_name=path.parent.name,
        tracker_present=isinstance(tracker_settings, dict),
        removable_keys=removable_keys,
    )


def backup_path_for(path: Path) -> Path:
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return path.with_name(
        f"{path.stem}.token-usage-tracker-cleanup-backup-{timestamp}{path.suffix}",
    )


def remove_legacy_usage_keys(data: dict, extension_name: str) -> list[str]:
    extension_settings = data.get("extension_settings")
    if not isinstance(extension_settings, dict):
        return []

    tracker_settings = extension_settings.get(extension_name)
    if not isinstance(tracker_settings, dict):
        return []

    usage = tracker_settings.get("usage")
    if not isinstance(usage, dict):
        return []

    removed: list[str] = []
    for key in LEGACY_USAGE_KEYS:
        if key in usage:
            usage.pop(key, None)
            removed.append(key)
    return removed


def write_json_atomic(path: Path, data: dict) -> None:
    with NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=path.parent,
        delete=False,
        suffix=".tmp",
    ) as handle:
        json.dump(data, handle, indent=4, ensure_ascii=False)
        handle.write("\n")
        temp_path = Path(handle.name)

    temp_path.replace(path)


def process_file(path: Path, extension_name: str) -> str:
    data = load_json(path)
    removed = remove_legacy_usage_keys(data, extension_name)
    if not removed:
        return f"skipped {path} (nothing to remove)"

    backup_path = backup_path_for(path)
    shutil.copy2(path, backup_path)
    write_json_atomic(path, data)
    return f"cleaned {path} (removed {', '.join(removed)}; backup: {backup_path})"


def print_banner(root: Path, extension_name: str) -> None:
    print("Token Usage Tracker Cleanup")
    print()
    print(
        "This cleans token usage data from user settings.json files, so it does not matter "
        "whether the extension code lives in the global third-party folder or a user extensions folder.",
    )
    print()
    print(f"Detected repo root: {root}")
    print(f"Script location: {global_extension_path()}")
    print(f"Detected extension settings key: {extension_name}")
    print()


def print_scan_results(targets: list[TargetInfo]) -> None:
    print("Discovered settings files:")
    for index, target in enumerate(targets, start=1):
        if not target.tracker_present:
            status = "token-usage-tracker settings not present"
        elif target.removable_keys:
            status = f"will remove {', '.join(target.removable_keys)}"
        else:
            status = "nothing to remove"
        print(f"  {index}. {target.user_name}: {target.path}")
        print(f"     {status}")
    print()


def prompt_choice() -> str:
    print("Choose an action:")
    print("  1. Clean every user that still has legacy fields")
    print("  2. Choose specific users")
    print("  3. Exit")
    return input("Enter 1, 2, or 3: ").strip()


def prompt_selection(targets: list[TargetInfo]) -> list[TargetInfo]:
    print()
    print("Enter one or more user numbers separated by commas.")
    raw = input("Selection: ").strip()
    if not raw:
        return []

    chosen_indices: set[int] = set()
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        if not part.isdigit():
            print(f"Ignoring invalid entry: {part}")
            continue
        chosen_indices.add(int(part))

    result: list[TargetInfo] = []
    for index in sorted(chosen_indices):
        if 1 <= index <= len(targets) and targets[index - 1].removable_keys:
            result.append(targets[index - 1])
        else:
            print(f"Ignoring unavailable selection: {index}")
    return result


def confirm_cleanup(targets: list[TargetInfo]) -> bool:
    print()
    print("Ready to clean these settings files:")
    for target in targets:
        print(f"  - {target.path}")
    print()
    print("A backup will be created next to each settings.json before rewriting it.")
    return input("Proceed? [y/N]: ").strip().lower() in {"y", "yes"}


def main() -> int:
    root = find_repo_root()
    extension_name = get_extension_name()
    print_banner(root, extension_name)

    paths = resolve_targets(root)
    if not paths:
        print("No settings.json files found.")
        return 1

    targets: list[TargetInfo] = []
    had_errors = False

    for path in paths:
        try:
            if not path.exists():
                print(f"Skipping missing file: {path}")
                continue
            if not path.is_file():
                print(f"Skipping non-file path: {path}")
                continue
            targets.append(inspect_target(path, extension_name))
        except Exception as exc:
            had_errors = True
            print(f"Error reading {path}: {exc}")

    if not targets:
        print("No readable settings.json files were found.")
        return 1 if had_errors else 0

    print_scan_results(targets)

    cleanup_candidates = [target for target in targets if target.removable_keys]
    if not cleanup_candidates:
        print("No legacy token-usage-tracker fields were found.")
        return 1 if had_errors else 0

    choice = prompt_choice()
    if choice == "1":
        selected = cleanup_candidates
    elif choice == "2":
        selected = prompt_selection(targets)
    else:
        print("Nothing changed.")
        return 1 if had_errors else 0

    if not selected:
        print("Nothing selected.")
        return 1 if had_errors else 0

    if not confirm_cleanup(selected):
        print("Canceled. Nothing changed.")
        return 1 if had_errors else 0

    print()
    changed = 0
    failed = 0
    for target in selected:
        try:
            print(process_file(target.path, extension_name))
            changed += 1
        except Exception as exc:
            failed += 1
            print(f"Error processing {target.path}: {exc}")

    print()
    print(f"Summary: cleaned={changed}, failed={failed}")
    return 1 if failed or had_errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
