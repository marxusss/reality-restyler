"""Temporary visual verification of PR #7's real frontend; remove after reviewing."""
import base64
import json
import subprocess
import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
server = subprocess.Popen([sys.executable, "-m", "http.server", "8875", "--bind", "127.0.0.1", "--directory", str(root / "web")],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    time.sleep(1.0)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(args=["--no-sandbox"])
        for name, width, height in [("portrait", 393, 852), ("landscape", 956, 440)]:
            page = browser.new_page(viewport={"width": width, "height": height}, device_scale_factor=1, is_mobile=True, has_touch=True)
            page.route("**/preferences", lambda route: route.fulfill(json={"settings": {"prompt": "", "steps": 4, "resolution": 512, "upscale": True}}))
            page.route("**/styles/user", lambda route: route.fulfill(json={"styles": []}))
            page.route("**/health", lambda route: route.fulfill(json={"loaded": False}))
            page.goto("http://127.0.0.1:8875/", wait_until="networkidle")
            page.evaluate("""() => {
                const out = document.querySelector("#output");
                out.style.background = 'linear-gradient(120deg,rgba(10,15,19,.1),rgba(25,40,45,.2)),url("/styles/academic-realism.webp") center/cover';
            }""")
            def center(selector):
                rect = page.locator(selector).bounding_box()
                assert rect, selector
                return (rect["x"] + rect["width"] / 2, rect["y"] + rect["height"] / 2)
            assert abs(center("#startButton")[0] - width / 2) < 1.5, "Play not horizontally centered"
            assert not page.locator("#cameraActions").get_attribute("class").find("activated") >= 0
            page.locator("#startButton").click()
            page.wait_for_timeout(600)
            assert "activated" in page.locator("#cameraActions").get_attribute("class")
            assert abs(center("#shutterButton")[0] - width / 2) < 1.5, "Shutter not horizontally centered"
            start_x = center("#startButton")[0]
            assert start_x < width / 2 - 40, "Pause not in left dock slot"
            # Capture modes retain real browser/recording logic.
            assert page.locator("#captureModeButton").inner_text() in ("Video", "Photo")
            lenses = page.evaluate("""() => {
                const bar = document.querySelector("#lensBar");
                bar.hidden = false;
                for (const text of [".5×","1×","2×","3×"]) {
                    const el = document.createElement("button");
                    el.className = "lens-button";
                    el.textContent = text;
                    bar.append(el);
                }
                return [...bar.children].map(el => [el.getBoundingClientRect().width, el.getBoundingClientRect().height]);
            }""")
            assert all(abs(w - h) < 0.1 for w,h in lenses), lenses
            page.locator("#settingsButton").click()
            assert not page.locator("#settingsPanel").is_hidden()
            page.locator("#promptInput").fill("Line one\\nLine two\\nLine three")
            size = page.locator("#promptInput").evaluate("(el) => el.getBoundingClientRect().height")
            assert 65 <= size <= 83, ("Prompt did not grow to three lines", size)
            page.locator("#promptInput").blur()
            page.wait_for_timeout(200)
            def snapshot(suffix):
                png = page.screenshot(type="jpeg", quality=60)
                print("RR_UI_SCREEN " + name + "_" + suffix + " " + base64.b64encode(png).decode(), flush=True)
            snapshot("settings")
            page.locator("#stylesButton").click()
            page.locator("#presetStyles .style-card").first.wait_for(timeout=5000)
            assert page.locator("#combineStylesButton").get_attribute("aria-pressed") == "false", "Combine enabled by default"
            cards = page.locator("#presetStyles .style-card")
            assert cards.count() > 6
            rects = [cards.nth(i).bounding_box() for i in range(min(8, cards.count()))]
            for i,a in enumerate(rects):
                if not a: continue
                for b in rects[i+1:]:
                    if not b: continue
                    overlap_x = min(a["x"]+a["width"],b["x"]+b["width"])-max(a["x"],b["x"])
                    overlap_y = min(a["y"]+a["height"],b["y"]+b["height"])-max(a["y"],b["y"])
                    assert overlap_x <= 0.5 or overlap_y <= 0.5, "Styles cards overlap"
            snapshot("styles")
            page.locator("#combineStylesButton").click()
            assert page.locator("#combineStylesButton").get_attribute("aria-pressed") == "true"
            page.locator("#combineStylesButton").click()
            assert page.locator("#combineStylesButton").get_attribute("aria-pressed") == "false"
            page.close()
        browser.close()
finally:
    server.terminate()
    server.wait(timeout=5)
