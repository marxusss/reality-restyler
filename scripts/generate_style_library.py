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
BASE = "https://matplinta.github.io/t2i-krea-2-style-library/data/"
STYLES = [
    {
        'source_id': 'anime-style',
        'label': 'Anime',
        'prompt': 'Draw with confident clean contours, appealing simplified proportions, expressive eyes and bright cel-like shading. Keep color blocks readable, use crisp highlights and gentle gradients, and give the image the lively, polished feeling of a modern hand-animated scene while preserving its original structure.',
        'id': 'anime',
    },
    {
        'source_id': 'ghibli-style',
        'label': 'Hand-painted fantasy animation',
        'prompt': 'Use soft, hand-painted animation textures with watercolor-like light and carefully observed natural details. Favor rounded expressive shapes, layered foliage, warm atmospheric color and a quiet sense of wonder, balancing a cozy everyday mood with a hint of gentle fantasy.',
        'id': 'hand-painted-animation',
    },
    {
        'source_id': 'manga-style',
        'label': 'Manga',
        'prompt': 'Render with precise black ink contours, expressive faces and dramatic panel-like contrast. Use fine hatching or screentone dots for shadow, clear white highlights and purposeful line weight, giving the image the energetic, carefully composed look of a printed graphic story.',
        'id': 'manga',
    },
    {
        'source_id': 'chinese-ink-drawing',
        'label': 'Chinese ink drawing',
        'prompt': 'Render the existing subject in its same pose with fluid black brush contours, pooled ink shadows and generous open-paper space. Keep its identity, framing, composition and recognizable background details or landmarks intact, translating all existing scenery into ink work.',
        'id': 'chinese-ink',
    },
    {
        'source_id': 'technical-drawing',
        'label': 'Technical drawing',
        'prompt': 'Use disciplined drafting lines, consistent stroke weights and measured geometric construction. Define edges with clean contours, restrained labels or guide marks and minimal shading, so the result feels engineered and legible while the existing forms and relationships remain clear.',
        'id': 'technical-drawing',
    },
    {
        'source_id': 'very-simplistic-doodle',
        'label': 'Simple doodle',
        'prompt': 'Reduce the scene to playful, uneven hand-drawn outlines and a few simple color patches. Let lines wobble, proportions feel informal and details stay sparse, as if quickly sketched in a notebook by an untrained but imaginative hand.',
        'id': 'doodle',
    },
    {
        'source_id': 'bruce-timm-noir',
        'label': 'Noir animation',
        'prompt': 'Simplify forms into elegant angular silhouettes, strong curved contours and sharply separated shadow shapes. Use a restrained noir palette with decisive highlights, clean graphic edges and expressive poses, creating a sleek animated crime-story mood without adding unnecessary detail.',
        'id': 'noir-animation',
    },
    {
        'source_id': 'corporate-memphis',
        'label': 'Corporate Memphis',
        'prompt': 'Build figures from rounded geometric shapes, tube-like limbs and simplified anatomy. Apply flat cheerful color, minimal shadows and spacious clean forms, with playful asymmetry and an approachable presentation-illustration mood rather than naturalistic surface detail.',
        'id': 'corporate-memphis',
    },
    {
        'source_id': 'graphic-flat-vector-travel-poster-illustration',
        'label': 'Flat travel poster',
        'prompt': 'Compose the scene from bold flat planes, angular cut-paper shapes and a compact vintage palette. Use simplified distant landmarks, confident silhouettes and subtle printed texture, like a destination poster designed for quick recognition from across a room.',
        'id': 'travel-poster',
    },
    {
        'source_id': 'van-gogh-style',
        'label': 'Post-impressionist brushwork',
        'prompt': 'Apply thick directional brush marks that curl and ripple across both subjects and surroundings. Layer vivid blues, yellows and greens in energetic bands, allowing visible paint texture and rhythmic movement to shape the light, sky and solid forms.',
        'id': 'post-impressionist',
    },
    {
        'source_id': 'cubism',
        'label': 'Cubism',
        'prompt': 'Repaint the existing subject and setting as a cubist composition of opaque, overlapping painted planes and fractured contours. Let adjacent facets shift viewpoint while keeping forms recognizable; flatten depth with muted ochre, slate, cream and blue, add visible brush texture, and avoid translucent polygon overlays.',
        'id': 'cubism',
    },
    {
        'source_id': 'jackson-pollock-style',
        'label': 'Abstract action painting',
        'prompt': 'Cover the composition with vigorous sweeping paint gestures, splashes, drips and scattered flecks. Let layered lines move across the full frame with varied scale and color, retaining traces of the underlying scene beneath the expressive abstract marks.',
        'id': 'action-painting',
    },
    {
        'source_id': 'wet-on-wet-watercolor-ink-painting',
        'label': 'Wet-on-wet watercolor ink',
        'prompt': 'Let translucent pigments bloom and bleed through damp paper, with soft-edged color pools beside selective dark ink lines. Preserve airy whites, delicate granulation and unexpected overlaps, giving the image a fluid handmade finish instead of crisp digital edges.',
        'id': 'watercolor-ink',
    },
    {
        'source_id': 'academic-precision-realism',
        'label': 'Academic precision realism',
        'prompt': 'Render forms with smooth layered tones, measured anatomy, precise edges and controlled reflected light. Build depth through subtle glazes rather than obvious brush marks, maintaining balanced classical composition and careful realism without making the scene feel photographic.',
        'id': 'academic-realism',
    },
    {
        'source_id': 'gris-grimly-style',
        'label': 'Gothic storybook illustration',
        'prompt': 'Give the scene a whimsical gothic storybook mood with crooked silhouettes, spindly contours and slightly exaggerated proportions. Add scratchy pen texture, crosshatched shadows and muted aged colors, balancing playful charm with a gently macabre atmosphere.',
        'id': 'gothic-storybook',
    },
    {
        'source_id': 'crayola-colored-book-style',
        'label': 'Colored-pencil book illustration',
        'prompt': 'Fill simple outlined shapes with visible wax-crayon strokes, layered pigments and uneven hand pressure. Keep the colors cheerful and tactile, letting small gaps and overlapping marks show through so the result feels colored by hand on paper.',
        'id': 'crayon-book',
    },
    {
        'source_id': 'blue-hour-cinema',
        'label': 'Blue hour cinema',
        'prompt': 'Use cool twilight illumination with soft blue-violet gradients, long gentle shadows and atmospheric depth. Add restrained warm lights against the dusk, keeping the mood quiet and cinematic with natural color transitions and clear separation between foreground and distance.',
        'id': 'blue-hour-cinema',
    },
    {
        'source_id': 'pixar-animation',
        'label': 'Expressive 3D animation',
        'prompt': 'Shape the scene as polished expressive 3D animation with rounded appealing forms, smooth surfaces and warm soft light. Use subtle subsurface glow, lively eyes and cinematic depth, preserving recognizable subjects while adding a handcrafted family-film sense of warmth.',
        'id': 'animated-3d',
    },
    {
        'source_id': 'neon-photography',
        'label': 'Neon photography',
        'prompt': 'Create a vivid night photograph lit by concentrated neon sources and saturated reflections. Let magenta, cyan or electric blue accents glow against deep shadow, with crisp luminous edges, wet-looking highlights and realistic photographic contrast across the scene.',
        'id': 'neon-photo',
    },
    {
        'source_id': 'direct-flash-photography',
        'label': 'Direct-flash photography',
        'prompt': 'Use a hard on-camera flash that brightly exposes the subject and throws short, abrupt shadows behind it. Keep colors direct, texture crisp and tonal transitions stark, like an unpolished candid photograph taken close to the camera at night.',
        'id': 'direct-flash',
    },
    {
        'source_id': 'low-poly',
        'label': 'Low-poly',
        'prompt': 'Rebuild forms from broad flat-shaded polygons with crisp edges and visible faceted transitions. Simplify small details into angular planes, use a compact coordinated palette and preserve enough structure to make the portrait and surroundings easy to read.',
        'id': 'low-poly',
    },
    {
        'source_id': 'claymation',
        'label': 'Claymation',
        'prompt': 'Rebuild the entire frame as a handcrafted stop-motion clay scene, reshaping the existing subject and every visible background element together. Preserve identity, pose, clothing, props, composition and recognizable setting; use rounded forms, fingerprints and miniature-set lighting, adding no figures.',
        'id': 'claymation',
    },
    {
        'source_id': 'pop-art',
        'label': 'Pop art',
        'prompt': 'Separate bold flat colors with strong outlines and repeated halftone dots. Use punchy primary hues, graphic shadow blocks and a slightly screen-printed texture, turning the full composition into a crisp poster-like image with lively visual rhythm.',
        'id': 'pop-art',
    },
    {
        'source_id': 'etching',
        'label': 'Etching',
        'prompt': 'Construct light and shadow from fine engraved lines, crosshatching and carefully varied mark density. Keep contours sharp, tones monochrome and surface texture consistent, as if the entire image were cut into a metal plate and printed on paper.',
        'id': 'etching',
    },
    {
        'source_id': 'mosaic-art',
        'label': 'Mosaic art',
        'prompt': 'Recreate the full image as a dense arrangement of small flat colored tiles, including the existing subject and every visible background element. Vary tile tones to describe form, preserve identity, pose, framing and recognizable landmarks, and do not omit or replace scene content.',
        'id': 'mosaic',
    },
    {
        'source_id': 'stained-glass-flat-art',
        'label': 'Flat stained glass art',
        'prompt': 'Construct every part of the image from distinct luminous colored-glass pieces, rebuilding the focal subject and background as joined panels. Use bold continuous dark lead lines that fully enclose each pane, jewel tones and transmitted light; preserve the recognizable scene and avoid painting beneath a grid.',
        'id': 'stained-glass',
    },
    {
        'source_id': '8-bit-style',
        'label': '8-bit pixel art',
        'prompt': 'Translate all contours and shading into hard-edged square pixels with a tightly limited retro palette. Use stepped outlines, chunky blocks and simple contrast patterns, keeping the core pose and scenery recognizable at a glance.',
        'id': '8-bit',
    },
    {
        'source_id': 'minecraft-style',
        'label': 'Voxel game art',
        'prompt': 'Construct the image from chunky cubic voxel forms, block-built surfaces and deliberately low-resolution textures. Use clear square silhouettes, stepped terrain and bright game-like colors, translating the person and surroundings into a cohesive miniature world.',
        'id': 'voxel-world',
    },
    {
        'source_id': 'cyberpunk',
        'label': 'Cyberpunk',
        'prompt': 'Give the image a high-contrast animated science-fiction look with sharp linework, neon signage and saturated colored light. Break shadows into graphic shapes, add reflective highlights and a futuristic urban mood while retaining the core layout and subjects.',
        'id': 'cyberpunk',
    },
    {
        'source_id': 'midjourney-niji-inspired-digital-illustration',
        'label': 'Polished anime digital illustration',
        'prompt': 'Use luminous anime-inspired digital painting with soft gradients, glowing rim light and dreamy bloom around important forms. Combine richly saturated color with delicate linework, polished facial features and a gentle fantasy atmosphere, keeping the original scene recognizable.',
        'id': 'anime-digital',
    },
    {
        'source_id': 'sketch',
        'label': 'Loose sketch',
        'prompt': 'Capture the image with loose searching pencil strokes, visible construction lines and varied pressure. Let contours overlap slightly, use sparse hatching for tone and keep the drawing immediate and unfinished, like a confident study made from observation.',
        'id': 'sketch',
    },
    {
        'source_id': 'charcoal-rendering',
        'label': 'Charcoal rendering',
        'prompt': 'Model the scene through smoky charcoal values, soft smudges and expressive dark marks. Preserve a tactile dusty surface, rich blacks and gentle midtone transitions, with edges that fade into atmosphere while important forms remain clear.',
        'id': 'charcoal',
    },
    {
        'source_id': 'vintage-comics',
        'label': 'Vintage comic art',
        'prompt': 'Use bold inked contours, dynamic simplified shapes and coarse halftone shading. Add slightly imperfect print registration, faded paper colors and crisp graphic highlights, creating the worn look of an older illustrated story page.',
        'id': 'vintage-comic',
    },
    {
        'source_id': 'fish-eye-photography',
        'label': 'Fisheye photography',
        'prompt': 'Photograph the scene with an ultra-wide spherical view that bows straight lines toward the frame edges. Exaggerate depth near the center and stretch peripheral forms, while keeping the portrait and major landmarks visible in one continuous view.',
        'id': 'fisheye',
    },
    {
        'source_id': 'surveillance-camera-photo',
        'label': 'Surveillance camera photo',
        'prompt': 'Make the image feel like a fixed security-camera capture with flat illumination, restrained color and coarse digital grain. Use modest sharpness, compressed tonal range and a detached, unposed perspective without changing the scene arrangement.',
        'id': 'surveillance',
    },
    {
        'source_id': 'film-noir-2',
        'label': 'Film noir',
        'prompt': 'Use stark monochrome lighting with hard pools of illumination carved out of deep surrounding shadow. Add smoky atmosphere, wet highlights and dramatic tonal separation, shaping the existing portrait and setting into a tense cinematic night scene.',
        'id': 'film-noir',
    },
    {
        'source_id': 'motion-blur-photography',
        'label': 'Motion-blur photography',
        'prompt': 'Suggest a long exposure with directional streaks and smeared movement around relatively sharp focal areas. Keep the blur aligned with plausible motion, preserve enough detail to identify the original subjects and use realistic photographic light trails.',
        'id': 'motion-blur',
    },
    {
        'source_id': 'hyper-synthwave',
        'label': 'Synthwave',
        'prompt': 'Build a retro-futurist night scene with glowing neon bands, vivid magenta and cyan, and a deep perspective grid. Separate dark silhouettes from luminous edges, add smooth gradients and polished digital glow for a nostalgic electronic mood.',
        'id': 'synthwave',
    },
    {
        'source_id': 'bastien-lecouffe-deharme-fantasy',
        'label': 'Moody dark fantasy painting',
        'prompt': 'Create an atmospheric fantasy painting with refined realistic forms, poetic visual storytelling and layered painterly texture. Use sophisticated cinematic light, a dreamlike mood and emotional focus, keeping the image detailed without becoming glossy or mechanical.',
        'id': 'dark-fantasy-painting',
    },
    {
        'source_id': 'artstation-masterpiece',
        'label': 'Highly polished concept art',
        'prompt': 'Render as high-production concept art with controlled painterly detail and crisp technical definition. Use cinematic lighting to establish depth and scale, carefully balance focal clarity with atmospheric edges, and give materials considered texture and finish.',
        'id': 'concept-art',
    },
    {
        'source_id': 'dark-fantasy-illustration',
        'label': 'Dark fantasy illustration',
        'prompt': 'Turn the image into dark fantasy with moonlit stone textures and an indigo atmosphere. Preserve the same focal subject, identity, pose, crop, composition and recognizable background details or landmarks. Cast clear cool moonlight across the subject so visible features stay readable; add no figures.',
        'id': 'dark-fantasy',
    },
    {
        'source_id': 'hyper-stylized-digital-painting',
        'label': 'Hyper-stylized digital painting',
        'prompt': 'Push proportions and shapes into a bold painterly interpretation while keeping the subject recognizable. Combine layered brush texture, simplified color masses and dramatic accents, balancing expressive distortion with a clear composition and deliberate visual hierarchy.',
        'id': 'stylized-painting',
    },
    {
        'source_id': 'graffiti-painting',
        'label': 'Graffiti painting',
        'prompt': 'Apply layered graffiti marks across the whole existing image, treating the subject and background together. Use spray-textured edges, energetic contours, paint drips and vivid pigment while preserving the same identity, pose, framing, composition and recognizable setting rather than replacing it.',
        'id': 'graffiti',
    },
    {
        'source_id': 'tenebrism',
        'label': 'Tenebrism',
        'prompt': 'Build the image around deep enveloping shadow interrupted by one concentrated pool of light. Let forms emerge abruptly from darkness with strong warm highlights and deliberate tonal contrast, while preserving readable structure and carefully composed edges.',
        'id': 'tenebrism',
    },
]

def fetch(path: str):
    with urlopen(BASE + path, timeout=30) as response:
        return json.load(response)

def write_contact_sheet(entries):
    thumbs = []
    for entry in entries:
        image_path = ROOT / "web" / "styles" / f"{entry['id']}.webp"
        if not image_path.is_file():
            continue
        im = Image.open(image_path).convert("RGB")
        im.thumbnail((192, 192))
        tile = Image.new("RGB", (220, 230), "white")
        tile.paste(im, ((220-im.width)//2, 0))
        ImageDraw.Draw(tile).text((5, 198), entry["name"][:30], fill="black")
        thumbs.append(tile)
    sheet = Image.new("RGB", (220*5, 230*((len(thumbs)+4)//5)), "#ddd")
    for i, tile in enumerate(thumbs): sheet.paste(tile, ((i%5)*220, (i//5)*230))
    (ROOT / "dist").mkdir(exist_ok=True)
    sheet.save(ROOT / "dist" / "style-library-contact-sheet.jpg", quality=88)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input")
    parser.add_argument("--models-dir", default=os.environ.get("REALITY_RESTYLE_MODELS_DIR", str(ROOT / "models")))
    parser.add_argument("--no-generate", action="store_true")
    parser.add_argument("--only", nargs="*", help="Render a subset by source ID")
    parser.add_argument("--extract-to", help="Optional local path for source descriptor extraction")
    args = parser.parse_args()
    if not args.no_generate and not args.input:
        parser.error("--input is required unless --no-generate is set")
    catalog = fetch("styles.json")["styles"]
    by_id = {row["id"]: row for row in catalog}
    missing = [entry["source_id"] for entry in STYLES if entry["source_id"] not in by_id or not by_id[entry["source_id"]].get("descriptor")]
    known_ids = {entry["source_id"] for entry in STYLES}
    unknown = set(args.only or []) - known_ids
    if unknown:
        parser.error(f"Unknown --only source IDs: {sorted(unknown)}")
    if missing:
        raise SystemExit(f"Requested styles missing from current source: {missing}")
    out = ROOT / "web" / "styles"
    out.mkdir(parents=True, exist_ok=True)
    entries = [{"id": row["id"], "name": row["label"], "prompt": row["prompt"] + ", keep scene intact", "thumbnail": f"/styles/{row['id']}.webp"} for row in STYLES]
    if any(not row["prompt"].endswith("keep scene intact") for row in entries):
        raise SystemExit("Prompt suffix check failed")
    (out / "catalog.json").write_text(json.dumps(entries, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if args.extract_to:
        target = Path(args.extract_to).resolve()
        try:
            target.relative_to(ROOT)
        except ValueError:
            pass
        else:
            parser.error("--extract-to must be outside the repository")
        selected = [{"source_id": row["source_id"], "source_name": by_id[row["source_id"]]["name"], "descriptor": by_id[row["source_id"]]["descriptor"]} for row in STYLES]
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(selected, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Prepared {len(entries)} curated entries from {BASE}styles.json; IDs and descriptors verified.", flush=True)
    if args.no_generate:
        write_contact_sheet(entries)
        return
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
        render_entries = [entry for entry in entries if not args.only or next(row["source_id"] for row in STYLES if row["id"] == entry["id"]) in args.only]
        for i, entry in enumerate(render_entries, 1):
            started = time.perf_counter()
            runtime.set_settings({"prompt": entry["prompt"]})
            image = runtime.render(source)
            path = ROOT / "web" / "styles" / f"{entry['id']}.webp"
            image.save(path, "WEBP", quality=82, method=5)
            print(f"{i}/{len(render_entries)} {entry['id']} {time.perf_counter()-started:.1f}s {path.stat().st_size} bytes", flush=True)
        print(f"Generated {len(render_entries)} thumbnails in {time.perf_counter()-start:.1f}s", flush=True)
        write_contact_sheet(entries)
    finally:
        runtime.unload()
        print("Runtime unloaded.", flush=True)

if __name__ == "__main__":
    main()
