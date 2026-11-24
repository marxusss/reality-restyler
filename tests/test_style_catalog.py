import importlib.util
import json
import re
import tempfile
import unittest
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("generate_style_library", ROOT / "tools" / "generate_style_library.py")
library = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(library)

# New prompts describe looks by technique and era, never by studio, franchise or brand.
NAMES = re.compile(
    r"\b(pixar|disney|ghibli|lego|simpsons|hanna|barbera|looney|muppets?|minecraft|nintendo|playstation|"
    r"sailor moon|aardman|laika|fleischer|cartoon network|nickelodeon|south park)\b", re.I)
SCENE_OBJECT_EXAMPLES = re.compile(
    r"\b(trees?|lamp posts?|lampposts?|buildings?|bridges?|riverbanks?|moons?|spores?|jellyfish|particles?|"
    r"model[- ]railway|trains?|landmarks?|candles?|cobwebs?|petals?|flowers?|orbs?|balloons?|bread|cake|"
    r"broccoli|lettuce|pasta|noodles?|fruits?|vegetables?)\b", re.I)
REMOVED_STYLE_IDS = {"balloon-animal", "blown-glass", "chibi"}


class StyleCatalogTests(unittest.TestCase):
    def setUp(self):
        self.entries = library.load_catalog()

    def test_every_style_has_a_known_group_in_order(self):
        groups = list(dict.fromkeys(entry["group"] for entry in self.entries))
        self.assertEqual(groups, list(library.GROUPS))
        self.assertTrue(6 <= len(groups) <= 9)
        for group in groups:
            self.assertGreaterEqual(sum(entry["group"] == group for entry in self.entries), 3, group)

    def test_every_style_has_a_thumbnail_the_size_of_the_others(self):
        for entry in self.entries:
            path = ROOT / "src" / "web" / "styles" / f"{entry['id']}.webp"
            with Image.open(path) as image:
                self.assertEqual(image.format, "WEBP", entry["id"])
                self.assertEqual(image.size, (512, 368), entry["id"])

    def test_prompts_name_no_studio_or_franchise(self):
        for entry in self.entries:
            self.assertIsNone(NAMES.search(entry["prompt"] + " " + entry["name"]), entry["id"])

    def test_removed_styles_stay_out_and_xray_remains(self):
        style_ids = {entry["id"] for entry in self.entries}
        self.assertTrue(REMOVED_STYLE_IDS.isdisjoint(style_ids))
        self.assertIn("x-ray", style_ids)

    def test_prompts_do_not_list_specific_scene_object_examples(self):
        for entry in self.entries:
            self.assertIsNone(SCENE_OBJECT_EXAMPLES.search(entry["prompt"]), entry["id"])

    def test_haunted_victorian_does_not_request_apparitions(self):
        prompt = next(entry["prompt"] for entry in self.entries if entry["id"] == "haunted-victorian")
        self.assertIn("Victorian", prompt)
        self.assertIn("add nothing", prompt)
        self.assertIsNone(re.search(r"\b(ghosts?|apparitions?|spectral)\b", prompt, re.I))

    def test_validator_rejects_missing_unknown_and_scattered_groups(self):
        def entry(style_id, group):
            item = {"id": style_id, "name": style_id, "prompt": "flat color, keep scene intact",
                    "thumbnail": f"/styles/{style_id}.webp"}
            if group:
                item["group"] = group
            return item

        cases = {
            "missing": [entry("a", None)],
            "unknown": [entry("a", "Sculpture")],
            "scattered": [entry("a", "Painting"), entry("b", "Strange"), entry("c", "Painting")],
            "out of order": [entry("a", "Strange"), entry("b", "Painting")],
        }
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "catalog.json"
            for name, entries in cases.items():
                path.write_text(json.dumps(entries), encoding="utf-8")
                with self.subTest(name), self.assertRaises(SystemExit):
                    library.load_catalog(path)
            path.write_text(json.dumps([entry("a", "Painting"), entry("b", "Painting"), entry("c", "Strange")]),
                            encoding="utf-8")
            self.assertEqual(len(library.load_catalog(path)), 3)


if __name__ == "__main__":
    unittest.main()
