"""Temporary, read-only screenshot gallery of PR7's actual web frontend."""
import base64
import io
import json
import subprocess
import sys
import time
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
states = [
    ("idle", "1 · Initial Play"),
    ("loading", "2 · Model loading"),
    ("video", "3 · Video controls"),
    ("photo", "4 · Photo controls"),
    ("recording", "5 · Recording"),
    ("settings", "6 · Settings / prompt"),
    ("styles", "7 · Styles gallery"),
    ("combine", "8 · Combine styles"),
    ("add", "9 · Add custom style"),
    ("edit", "10 · Edit custom style")
]
screens = {}
server = subprocess.Popen([sys.executable, "-m", "http.server", "8875",
                           "--bind", "127.0.0.1", "--directory", str(root / "web")],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
thumb = base64.b64encode((root / "web/styles/academic-realism.webp").read_bytes()).decode()
custom = {"id":"sample-style","name":"My custom style","prompt":"Moody amber cinema",
          "thumbnail":"data:image/webp;base64,"+thumb,"updatedAt":123456}

def mock_api(page):
    page.route("**/preferences", lambda r: r.fulfill(json={"settings":{"prompt":"","steps":4,"resolution":512,"upscale":True}}))
    page.route("**/styles/user", lambda r: r.fulfill(json={"styles":[custom]}))
    page.route("**/health", lambda r: r.fulfill(json={"loaded":False}))

def prepare(page):
    page.goto("http://127.0.0.1:8875/", wait_until="networkidle")
    page.evaluate("""() => {
      const preview = document.querySelector("#output");
      preview.style.setProperty("background",
        "linear-gradient(180deg,rgba(0,0,0,.07),rgba(0,0,0,.17)),url('/styles/academic-realism.webp') center/cover",
        "important");
      const shade = document.querySelector("#shade");
      shade.style.background = "linear-gradient(180deg,rgba(0,0,0,.08),transparent 28%,rgba(0,0,0,.16))";
    }""")
    assert page.locator("#startButton").is_visible()
    assert "Video" in page.locator("#captureModeButton").inner_text()

def enable_controls(page):
    page.evaluate("""() => {
      document.querySelector("#cameraActions").classList.add("activated");
      document.querySelector("#shutterButton").disabled = false;
      const lenses = document.querySelector("#lensBar");
      lenses.hidden = false;
      for (const [idx, text] of [".5×", "1×", "2×", "3×"].entries()) {
        const btn = document.createElement("button");
        btn.className = "lens-button";
        btn.textContent = text;
        btn.setAttribute("aria-pressed", String(idx === 1));
        lenses.append(btn);
      }
    }""")
    page.wait_for_timeout(500)
    width=page.viewport_size["width"]
    shutter=page.locator("#shutterButton").bounding_box()
    assert shutter and abs(shutter["x"] + shutter["width"]/2-width/2)<1.5
    lensRects=page.locator(".lens-button").evaluate_all("(els)=>els.map(e=>[e.getBoundingClientRect().width,e.getBoundingClientRect().height])")
    assert all(abs(w-h)<.2 for w,h in lensRects), lensRects

def open_styles(page):
    page.locator("#quickStylesButton").click()
    page.locator("#presetStyles .style-card").first.wait_for(timeout=5000)
    page.wait_for_timeout(250)
    assert page.locator("#combineStylesButton").get_attribute("aria-pressed")=="false"

def render(page, state):
    if state == "idle":
        btn=page.locator("#startButton").bounding_box()
        assert abs(btn["x"]+btn["width"]/2-page.viewport_size["width"]/2-63)<3 or abs(btn["x"]+btn["width"]/2-page.viewport_size["width"]/2)<2
        return
    enable_controls(page)
    if state == "loading":
        page.evaluate("""() => {
            const panel=document.querySelector("#startup");
            panel.hidden=false;
            document.querySelector("#startupLabel").textContent="Loading model weights";
            document.querySelector("#startupProgress").value=3;
            document.querySelector("#cancelStartupButton").hidden=false;
        }""")
    elif state == "photo":
        page.locator("#captureOtherModeButton").click()
        assert page.locator("#shutterButton").get_attribute("data-mode")=="photo"
    elif state == "recording":
        page.evaluate("""() => document.querySelector("#shutterButton").classList.add("recording")""")
    elif state == "settings":
        page.locator("#settingsButton").click()
        page.locator("#promptInput").fill("Soft natural light\nFilm grain\nKeep composition")
        page.locator("#promptInput").blur()
        assert 65 <= page.locator("#promptInput").evaluate("e=>e.getBoundingClientRect().height") <= 83
    elif state == "styles":
        open_styles(page)
    elif state == "combine":
        open_styles(page)
        page.locator("#combineStylesButton").click()
        page.locator("#presetStyles .style-card").nth(0).click()
        page.locator("#presetStyles .style-card").nth(1).click()
        assert page.locator("#useStylesButton").is_visible()
        assert page.locator("#combineStylesButton").get_attribute("aria-pressed")=="true"
    elif state == "add":
        open_styles(page)
        page.locator("#addStyleButton").click()
        page.locator("#styleName").fill("New cinematic style")
        page.locator("#stylePrompt").fill("Warm tungsten light with soft shadows")
        page.locator("#stylePrompt").blur()
        assert page.locator("#styleEditor").evaluate("e=>e.open")
    elif state == "edit":
        open_styles(page)
        page.locator("#customStyles .style-edit-button").first.click()
        page.locator("#styleName").blur()
        page.wait_for_timeout(150)
        assert page.locator("#deleteStyleButton").is_visible()
    page.wait_for_timeout(100)

def image_from_screenshot(page):
    return Image.open(io.BytesIO(page.screenshot(type="png"))).convert("RGB")

def board_for(images, size, columns):
    font=ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",18)
    sw,sh=size
    pad=16
    labelH=36
    rows=(len(states)+columns-1)//columns
    canvas=Image.new("RGB",(columns*(sw+pad)+pad,rows*(sh+labelH+pad)+pad),(16,18,23))
    d=ImageDraw.Draw(canvas)
    for i,(state,title) in enumerate(states):
        x=pad+(i%columns)*(sw+pad)
        y=pad+(i//columns)*(sh+labelH+pad)
        d.text((x+2,y+7),title,fill=(233,235,239),font=font)
        canvas.paste(images[state],(x,y+labelH))
    return canvas

def emit(name,img,quality=70):
    buf=io.BytesIO()
    img.save(buf,format="WEBP",quality=quality,method=5)
    print("RR_GALLERY "+name+" "+base64.b64encode(buf.getvalue()).decode(),flush=True)

try:
    time.sleep(.8)
    with sync_playwright() as p:
        browser=p.chromium.launch(args=["--no-sandbox","--use-fake-ui-for-media-stream"])
        for orient,size,columns in [
            ("portrait",(393,852),2),
            ("landscape",(956,440),2)
        ]:
            images={}
            for state,title in states:
                page=browser.new_page(viewport={"width":size[0],"height":size[1]},
                                      device_scale_factor=1,is_mobile=True,has_touch=True)
                mock_api(page)
                prepare(page)
                render(page,state)
                images[state]=image_from_screenshot(page)
                page.close()
                print("RR_GALLERY_STATUS "+orient+" "+state+" OK",flush=True)
            # Render a labeled gallery from ten actual Chromium screenshots.
            board=board_for(images,size,columns)
            board.thumbnail((490,2000))
            buf=io.BytesIO()
            board.save(buf,format="JPEG",quality=10,optimize=True,progressive=False,subsampling=2)
            print("RR_SMALL_GALLERY "+orient+" "+base64.b64encode(buf.getvalue()).decode(),flush=True)
            print("RR_GALLERY_COMPLETE "+orient,flush=True)
        browser.close()
finally:
    server.terminate()
    server.wait(timeout=5)
