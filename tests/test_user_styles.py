import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aiohttp.test_utils import TestClient, TestServer

import app


class UserStylePersistenceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.styles_path = Path(self.temp_dir.name) / "user_styles.json"
        self.path_patch = patch.object(app, "USER_STYLES_PATH", self.styles_path)
        self.path_patch.start()
        self.client = TestClient(TestServer(app.create_app()))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        self.path_patch.stop()
        self.temp_dir.cleanup()

    async def test_saves_merge_with_existing_styles_and_stale_edits_do_not_revert(self):
        original = {"id": "one", "name": "First", "prompt": "current", "thumbnail": None, "updatedAt": 200}
        added = {"id": "two", "name": "Second", "prompt": "second", "thumbnail": None, "updatedAt": 150}
        stale = {"id": "one", "name": "First", "prompt": "stale", "thumbnail": None, "updatedAt": 100}

        response = await self.client.post("/styles/user", json={"styles": [original]})
        self.assertEqual(response.status, 200)
        response = await self.client.post("/styles/user", json={"styles": [stale, added]})
        self.assertEqual(response.status, 200)
        saved = (await response.json())["styles"]

        self.assertEqual({style["id"] for style in saved}, {"one", "two"})
        self.assertEqual(next(style["prompt"] for style in saved if style["id"] == "one"), "current")
        self.assertEqual(json.loads(self.styles_path.read_text(encoding="utf-8")), saved)

        response = await self.client.post("/styles/user", json={"styles": []})
        self.assertEqual(response.status, 200)
        response = await self.client.get("/styles/user")
        self.assertEqual(response.status, 200)
        self.assertEqual(len((await response.json())["styles"]), 2)

    async def test_invalid_save_does_not_replace_saved_styles(self):
        valid = {"id": "one", "name": "First", "prompt": "current", "thumbnail": None, "updatedAt": 1}
        response = await self.client.post("/styles/user", json={"styles": [valid]})
        self.assertEqual(response.status, 200)
        before = self.styles_path.read_bytes()

        invalid = {"id": "two", "name": "Second", "prompt": "bad", "thumbnail": "data:image/png;base64,AA=="}
        response = await self.client.post("/styles/user", json={"styles": [invalid]})

        self.assertEqual(response.status, 422)
        self.assertEqual(self.styles_path.read_bytes(), before)

    async def test_corrupt_store_is_not_overwritten(self):
        self.styles_path.write_text("{", encoding="utf-8")
        response = await self.client.post("/styles/user", json={"styles": []})
        self.assertEqual(response.status, 500)
        self.assertEqual(self.styles_path.read_text(encoding="utf-8"), "{")


if __name__ == "__main__":
    unittest.main()
