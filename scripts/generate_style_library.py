from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from urllib.request import urlopen

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SOURCE_URL = "https://matplinta.github.io/t2i-krea-2-style-library/data/styles.json"
SOURCE_IDS = {
    "anime": "anime-style",
    "hand-painted-animation": "ghibli-style",
    "manga": "manga-style",
    "technical-drawing": "technical-drawing",
    "doodle": "very-simplistic-doodle",
    "noir-animation": "bruce-timm-noir",
    "corporate-memphis": "corporate-memphis",
    "travel-poster": "graphic-flat-vector-travel-poster-illustration",
    "post-impressionist": "van-gogh-style",
    "cubism": "cubism",
    "watercolor-ink": "wet-on-wet-watercolor-ink-painting",
    "academic-realism": "academic-precision-realism",
    "gothic-storybook": "gris-grimly-style",
    "crayon-book": "crayola-colored-book-style",
    "blue-hour-cinema": "blue-hour-cinema",
    "animated-3d": "pixar-animation",
    "neon-photo": "neon-photography",
    "direct-flash": "direct-flash-photography",
    "low-poly": "low-poly",
    "claymation": "claymation",
    "pop-art": "pop-art",
    "etching": "etching",
    "mosaic": "mosaic-art",
    "stained-glass": "stained-glass-flat-art",
    "8-bit": "8-bit-style",
    "voxel-world": "minecraft-style",
    "cyberpunk": "cyberpunk",
    "sketch": "sketch",
    "charcoal": "charcoal-rendering",
    "vintage-comic": "vintage-comics",
    "fisheye": "fish-eye-photography",
    "film-noir": "film-noir-2",
    "motion-blur": "motion-blur-photography",
    "synthwave": "hyper-synthwave",
    "dark-fantasy-painting": "bastien-lecouffe-deharme-fantasy",
    "concept-art": "artstation-masterpiece",
    "stylized-painting": "hyper-stylized-digital-painting",
    "graffiti": "graffiti-painting",
    "tenebrism": "tenebrism",
    "expressionist-painting": "abstract-expressionism",
    "impasto-oil": "impasto",
    "art-deco": "art-deco-gold-highlights",
    "paper-collage": "collage",
    "bauhaus": "bauhaus",
    "marble-sculpture": "marble-sculpture",
    "art-nouveau": "alphonse-mucha-masterwork",
    "ukiyo-e": "contemporary-ukiyo-e",
    "paper-cut": "paper-cutout",
    "gouache": "children-s-book-drawing",
    "woodcut": "woodcut",
    "lithograph": "contemporary-lithography",
    "conte-pastel": "conte-pastel",
    "editorial-illustration": "editorial-illustration",
    "origami": "origami",
    "mixed-media": "mixed-media",
    "airbrush": "airbrush-fantasy",
}


def load_catalog():
    path = ROOT / "web" / "styles" / "catalog.json"
    entries = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(entries, list):
        raise SystemExit("Style catalog must be a list.")
    ids = [entry.get("id") for entry in entries]
    if len(ids) != len(set(ids)) or any(not isinstance(value, str) or not value for value in ids):
        raise SystemExit("Style IDs must be unique non-empty strings.")
    for entry in entries:
        if not entry.get("name") or not entry.get("prompt", "").endswith("keep scene intact"):
            raise SystemExit(f"Invalid style entry: {entry.get('id')}")
        if entry.get("thumbnail") != f"/styles/{entry['id']}.webp":
            raise SystemExit(f"Invalid thumbnail path: {entry['id']}")
    return entries


def fetch_source_rows():
    with urlopen(SOURCE_URL, timeout=30) as response:
        data = json.load(response)
    return {row["id"]: row for row in data.get("styles", [])}


def write_source_extract(entries, target):
    source_rows = fetch_source_rows()
    selected = []
    missing = []
    for entry in entries:
        source_id = SOURCE_IDS.get(entry["id"])
        if not source_id:
            continue
        source = source_rows.get(source_id)
        if not source or not source.get("descriptor"):
            missing.append(source_id)
            continue
        selected.append({
            "source_id": source_id,
            "source_name": source["name"],
            "descriptor": source["descriptor"],
        })
    if missing:
        raise SystemExit(f"Source styles are missing: {sorted(set(missing))}")
    if not selected:
        raise SystemExit("No selected styles have a source descriptor.")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(selected, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Extracted {len(selected)} public descriptors to {target}", flush=True)


def write_contact_sheet(entries):
    tiles = []
    for entry in entries:
        image_path = ROOT / "web" / "styles" / f"{entry['id']}.webp"
        if not image_path.is_file():
            continue
        image = Image.open(image_path).convert("RGB")
        image.thumbnail((192, 192))
        tile = Image.new("RGB", (220, 230), "white")
        tile.paste(image, ((220 - image.width) // 2, 0))
        ImageDraw.Draw(tile).text((5, 198), entry["name"][:30], fill="black")
        tiles.append(tile)
    if not tiles:
        return
    columns = 5
    sheet = Image.new("RGB", (220 * columns, 230 * ((len(tiles) + columns - 1) // columns)), "#ddd")
    for index, tile in enumerate(tiles):
        sheet.paste(tile, ((index % columns) * 220, (index // columns) * 230))
    output = ROOT / "dist"
    output.mkdir(exist_ok=True)
    sheet.save(output / "style-library-contact-sheet.jpg", quality=88)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input")
    parser.add_argument("--models-dir", default=os.environ.get("REALITY_RESTYLE_MODELS_DIR", str(ROOT / "models")))
    parser.add_argument("--no-generate", action="store_true")
    parser.add_argument("--only", nargs="*", help="Render selected style IDs")
    parser.add_argument("--extract-to")
    args = parser.parse_args()
    entries = load_catalog()
    known_ids = {entry["id"] for entry in entries}
    unknown = set(args.only or []) - known_ids
    if unknown:
        parser.error(f"Unknown style IDs: {sorted(unknown)}")
    selected = [entry for entry in entries if not args.only or entry["id"] in args.only]
    if args.extract_to:
        target = Path(args.extract_to).resolve()
        try:
            target.relative_to(ROOT)
        except ValueError:
            pass
        else:
            parser.error("--extract-to must be outside the repository")
        write_source_extract(selected, target)
    if args.no_generate:
        write_contact_sheet(selected)
        return
    if not args.input:
        parser.error("--input is required unless --no-generate is set")
    source = Image.open(args.input).convert("RGB")
    os.environ["REALITY_RESTYLE_MODELS_DIR"] = str(Path(args.models_dir).resolve())
    sys.path.insert(0, str(ROOT))
    from runtime import Runtime
    runtime = Runtime()
    settings = {"prompt": "", "steps": 4, "resolution": 512, "upscale": False, "rotation": 0}
    start = time.perf_counter()
    try:
        result = runtime.start(settings, allow_low_vram=True)
        print(f"Runtime start: {result}", flush=True)
        for index, entry in enumerate(selected, 1):
            started = time.perf_counter()
            runtime.set_settings({"prompt": entry["prompt"]})
            image = runtime.render(source)
            path = ROOT / "web" / "styles" / f"{entry['id']}.webp"
            image.save(path, "WEBP", quality=82, method=5)
            print(f"{index}/{len(selected)} {entry['id']} {time.perf_counter() - started:.1f}s {path.stat().st_size} bytes", flush=True)
        print(f"Generated {len(selected)} thumbnails in {time.perf_counter() - start:.1f}s", flush=True)
        write_contact_sheet(selected)
    finally:
        runtime.unload()
        print("Runtime unloaded.", flush=True)


if __name__ == "__main__":
    main()
