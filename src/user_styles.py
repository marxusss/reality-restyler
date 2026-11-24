"""Host-owned custom styles, conflict resolution, and atomic JSON persistence."""
import json
import os
import threading

from preferences import USER_DATA_ROOT

USER_STYLES_PATH = USER_DATA_ROOT / "user_styles.json"
USER_STYLE_SECTIONS_PATH = USER_DATA_ROOT / "user_style_sections.json"
USER_STYLES_LOCK = threading.Lock()
DEFAULT_STYLE_SECTION = "Custom Styles"
MAX_STYLE_SECTION_LENGTH = 60

def _normalize_user_styles(styles):
    if not isinstance(styles, list):
        raise ValueError("The style list is invalid.")
    normalized = []
    seen = set()
    for item in styles:
        if not isinstance(item, dict):
            raise ValueError("A style is invalid.")
        if item.get("deleted", False) is True:
            style_id = item.get("id")
            updated_at = item.get("updatedAt", 0)
            if not isinstance(style_id, str) or not style_id or len(style_id) > 100:
                raise ValueError("A deleted style identifier is invalid.")
            if isinstance(updated_at, bool) or not isinstance(updated_at, (int, float)):
                raise ValueError("A deletion timestamp is invalid.")
            if style_id not in seen:
                seen.add(style_id)
                normalized.append({"id": style_id, "updatedAt": int(max(0, min(updated_at, 9007199254740991))), "deleted": True})
            continue
        name = item.get("name")
        prompt = item.get("prompt")
        if not isinstance(name, str) or not name.strip() or len(name) > 120:
            raise ValueError("A style name is invalid.")
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 12000:
            raise ValueError("A style prompt is invalid.")
        style_id = item.get("id")
        if not isinstance(style_id, str) or not style_id or len(style_id) > 100:
            raise ValueError("A style identifier is invalid.")
        if style_id in seen:
            continue
        seen.add(style_id)
        thumbnail = item.get("thumbnail")
        if thumbnail is not None and (
            not isinstance(thumbnail, str)
            or len(thumbnail) > 600000
            or not thumbnail.startswith("data:image/webp;base64,")
        ):
            raise ValueError("A style thumbnail is invalid.")
        updated_at = item.get("updatedAt", 0)
        if isinstance(updated_at, bool) or not isinstance(updated_at, (int, float)):
            updated_at = 0
        updated_at = int(max(0, min(updated_at, 9007199254740991)))
        if "deleted" in item and item["deleted"] is not False:
            raise ValueError("A style deletion marker is invalid.")
        group = item.get("group", DEFAULT_STYLE_SECTION)
        if not isinstance(group, str) or not group.strip() or len(group) > MAX_STYLE_SECTION_LENGTH:
            raise ValueError("A style section is invalid.")
        normalized.append({
            "id": style_id,
            "name": name.strip(),
            "prompt": prompt,
            "thumbnail": thumbnail,
            "group": group.strip(),
            "updatedAt": updated_at,
        })
    return normalized


def normalize_user_style_sections(sections):
    if not isinstance(sections, list):
        raise ValueError("The section list is invalid.")
    normalized = []
    seen = set()
    for section in sections:
        if (not isinstance(section, str) or not section.strip()
                or len(section) > MAX_STYLE_SECTION_LENGTH
                or any(ord(character) < 32 for character in section)):
            raise ValueError("A section name is invalid.")
        name = section.strip()
        key = name.casefold()
        if key not in seen:
            seen.add(key)
            normalized.append(name)
    return normalized

def read_user_styles():
    with USER_STYLES_LOCK:
        if not USER_STYLES_PATH.exists():
            return []
        data = json.loads(USER_STYLES_PATH.read_text(encoding="utf-8"))
        return _normalize_user_styles(data)

def _merge_user_styles(existing, incoming):
    merged = {}
    for style in existing + incoming:
        previous = merged.get(style["id"])
        if (previous is None or style["updatedAt"] > previous["updatedAt"]
                or (style["updatedAt"] == previous["updatedAt"] and
                    style.get("deleted", False) and not previous.get("deleted", False))):
            merged[style["id"]] = style
    return sorted(merged.values(), key=lambda style: style["updatedAt"], reverse=True)

def write_user_styles(styles):
    incoming = _normalize_user_styles(styles)
    with USER_STYLES_LOCK:
        existing = []
        if USER_STYLES_PATH.exists():
            try:
                existing = _normalize_user_styles(json.loads(USER_STYLES_PATH.read_text(encoding="utf-8")))
            except Exception as exc:
                raise RuntimeError("The custom style store is invalid.") from exc
        normalized = _merge_user_styles(existing, incoming)
        if {style["id"]: style for style in normalized} == {style["id"]: style for style in existing}:
            return existing
        payload = json.dumps(normalized, ensure_ascii=False, separators=(",", ":"))
        USER_STYLES_PATH.parent.mkdir(parents=True, exist_ok=True)
        pending = USER_STYLES_PATH.with_name(
            f".{USER_STYLES_PATH.name}.{os.getpid()}.{threading.get_ident()}.tmp"
        )
        try:
            with pending.open("w", encoding="utf-8", newline="") as output:
                output.write(payload)
                output.flush()
                os.fsync(output.fileno())
            os.replace(pending, USER_STYLES_PATH)
        finally:
            pending.unlink(missing_ok=True)
    return normalized


def read_user_style_sections():
    with USER_STYLES_LOCK:
        if not USER_STYLE_SECTIONS_PATH.exists():
            return []
        data = json.loads(USER_STYLE_SECTIONS_PATH.read_text(encoding="utf-8"))
        return normalize_user_style_sections(data)


def write_user_style_sections(sections):
    incoming = normalize_user_style_sections(sections)
    with USER_STYLES_LOCK:
        existing = []
        if USER_STYLE_SECTIONS_PATH.exists():
            try:
                existing = normalize_user_style_sections(
                    json.loads(USER_STYLE_SECTIONS_PATH.read_text(encoding="utf-8"))
                )
            except Exception as exc:
                raise RuntimeError("The custom section store is invalid.") from exc
        merged = list(existing)
        seen = {section.casefold() for section in existing}
        for section in incoming:
            if section.casefold() not in seen:
                seen.add(section.casefold())
                merged.append(section)
        if merged == existing:
            return existing
        payload = json.dumps(merged, ensure_ascii=False, separators=(",", ":"))
        USER_STYLE_SECTIONS_PATH.parent.mkdir(parents=True, exist_ok=True)
        pending = USER_STYLE_SECTIONS_PATH.with_name(
            f".{USER_STYLE_SECTIONS_PATH.name}.{os.getpid()}.{threading.get_ident()}.tmp"
        )
        try:
            with pending.open("w", encoding="utf-8", newline="") as output:
                output.write(payload)
                output.flush()
                os.fsync(output.fileno())
            os.replace(pending, USER_STYLE_SECTIONS_PATH)
        finally:
            pending.unlink(missing_ok=True)
    return merged

