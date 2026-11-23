import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mountCapture } from "../src/web/capture.js";

function element() {
  const listeners = new Map();
  return {
    dataset: {}, hidden: false, disabled: false, textContent: "",
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute(name, value) { this[name] = value; },
    addEventListener(name, callback) { listeners.set(name, callback); },
    emit(name, event) { listeners.get(name)?.(event); },
    setPointerCapture() {},
    click() { listeners.get("click")?.({detail: 1}); }
  };
}

test("camera defaults to video with a visible one-tap Photo alternative", () => {
  const ids = Object.fromEntries([
    "shutterButton", "captureModeButton", "captureOtherModeButton",
    "captureFileActions", "saveCaptureButton", "discardCaptureButton"
  ].map(id => [id, element()]));
  const strip = element();
  const shutterParent = element();
  ids.captureModeButton.parentElement = strip;
  ids.shutterButton.parentElement = shutterParent;
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  globalThis.window = {
    MediaRecorder: class {},
    matchMedia: () => ({matches: false})
  };
  globalThis.document = {
    getElementById: id => ids[id],
    createElement: () => ({getContext: () => ({}), captureStream() {}}),
    addEventListener() {}
  };
  try {
    mountCapture({getFrame: () => null, isMirrored: () => false, reportError() {}});
    assert.equal(ids.captureModeButton.textContent, "Video");
    assert.equal(ids.captureOtherModeButton.textContent, "Photo");
    assert.equal(ids.shutterButton.dataset.mode, "video");
    ids.captureOtherModeButton.click();
    assert.equal(ids.captureModeButton.textContent, "Photo");
    assert.equal(ids.captureOtherModeButton.textContent, "Video");
    assert.equal(ids.shutterButton.dataset.mode, "photo");

    shutterParent.emit("pointerdown", {isPrimary: true, pointerId: 1, clientX: 0, clientY: 0, target: shutterParent});
    shutterParent.emit("pointerup", {pointerId: 1, clientX: 5, clientY: 35});
    assert.equal(ids.captureModeButton.textContent, "Video");
    assert.equal(ids.shutterButton.dataset.mode, "video");
    shutterParent.emit("pointerdown", {isPrimary: true, pointerId: 2, clientX: 0, clientY: 0, target: shutterParent});
    shutterParent.emit("pointerup", {pointerId: 2, clientX: 40, clientY: 0});
    assert.equal(ids.shutterButton.dataset.mode, "video");
  } finally {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  }
});

test("settings Done commits edits, closes the panel and replaces clear prompt", () => {
  const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("../src/web/app.js", import.meta.url), "utf8");
  assert.match(html, /id="doneSettingsButton"/);
  assert.doesNotMatch(html, /id="clearPromptButton"/);
  assert.doesNotMatch(app, /clearPromptButton/);
  assert.match(app, /doneSettingsButton\.addEventListener\("click",[\s\S]*?void applySettings\(\);\s*setPanel\(false\);/);
});

test("diagnostics share one compact footer with Load or Unload model", () => {
  const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/web/style.css", import.meta.url), "utf8");
  assert.match(html, /class="setting-footer"[\s\S]*?id="latency"[^>]*>Model[^<]*<\/div>\s*<button id="quitModelButton"/);
  assert.doesNotMatch(html, /id="latency"[^>]*hidden/);
  assert.match(css, /\.setting-footer #quitModelButton\s*\{\s*flex:\s*0 0 auto/);
});

test("styles sit above the smaller capture dock, with a visible glass background", () => {
  const css = readFileSync(new URL("../src/web/style.css", import.meta.url), "utf8");
  const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
  const dialog = css.match(/#stylesDialog\[open\]\s*\{[^}]*\}/)?.[0] || "";
  assert.match(dialog, /--styles-bottom:[^;]*var\(--lens-height,[^)]*\)[^;]*var\(--capture-save-height,[^)]*\)/);
  assert.match(dialog, /bottom: var\(--styles-bottom\)/);
  assert.match(dialog, /max-height: calc\(100dvh - var\(--styles-bottom\)/);
  assert.match(css, /\.shutter-button\s*\{[^}]*width: 42px; height: 42px/);
  assert.match(css, /--glass-blur: blur\(\d+px\)/);
  assert.match(css, /\.glass\s*\{[^}]*-webkit-backdrop-filter: var\(--glass-blur\);[^}]*backdrop-filter: var\(--glass-blur\)/);
  assert.match(html, /id="cameraActions" class="actions glass"/);
  assert.match(html, /id="stylesDialog" class="style-dialog glass"/);
});

test("video is opaque, modes readable, and pause stays aligned", () => {
  const css = readFileSync(new URL("../src/web/style.css", import.meta.url), "utf8");
  assert.match(css, /\.shutter-button:disabled\s*\{\s*opacity:\s*1/);
  assert.match(css, /\.capture-mode-other\s*\{[^}]*rgba\(244,245,246,\.44\)/);
  assert.match(css, /\.actions > #startButton\s*\{[^}]*align-self: end;[^}]*place-items: center/);
});
test("palette icon, quiet Done, right-aligned Add style and less-wide thumbnails", () => {
  const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/web/style.css", import.meta.url), "utf8");
  assert.equal((html.match(/a9 9 0 0 0 0 18/g) || []).length, 2);
  // Done is a faint capsule like Styles, never a solid prominent button.
  assert.match(css, /\.prompt-line \.settings-done\s*\{[^}]*background: var\(--fill\)/);
  assert.match(css, /--fill: rgba\(255,255,255,\.1\)/);
  assert.match(css, /#addStyleButton, #useStylesButton\s*\{ margin-left: auto; \}/);
  assert.match(css, /\.style-thumbnail\s*\{[^}]*aspect-ratio: 8 \/ 5/);
});
test("style names stay original and labels are overlaid within thumbnails", () => {
  const styles = JSON.parse(readFileSync(new URL("../src/web/styles/catalog.json", import.meta.url), "utf8"));
  const css = readFileSync(new URL("../src/web/style.css", import.meta.url), "utf8");
  assert.equal(styles.find(s => s.id === "hand-painted-animation").name, "Hand-painted fantasy animation");
  assert.match(css, /\.style-name\s*\{[^}]*white-space: normal/);
  assert.doesNotMatch(css.match(/\.style-name\s*\{[^}]*\}/)?.[0] ?? "", /background\s*:/);
});

test("settings and lens gap matches lens and mode gap in portrait and landscape", () => {
  const css = readFileSync(new URL("../src/web/style.css", import.meta.url), "utf8");
  // Portrait: dock 72 + row gap 8 + lens capsule 42 (34px lenses + 4px padding); 14px separates both layers,
  // so the lens row adds 48px (42 + 8 - 2) to the settings offset.
  assert.match(css, /\.settings-panel\s*\{[^}]*--settings-bottom: calc\(max\(12px, env\(safe-area-inset-bottom\)\) \+ 88px\)/);
  assert.match(css, /#app:has\(\.lens-bar:not\(\[hidden\]\)\) \{\s*--lens-height: 48px;/);
  assert.match(css, /\.lens-bar\s*\{[^}]*padding: 4px;/);
  assert.match(css, /\.lens-button\s*\{[^}]*height: 34px;/);
  // Landscape uses 68px dock, 5px row gap and 8px separation.
  assert.match(css, /\.settings-panel \{ --settings-bottom: calc\(max\(6px,env\(safe-area-inset-bottom\)\) \+ 75px\)/);
});

test("thumbnail crops to fill its card and custom edit icon clears overlay", () => {
  const css = readFileSync(new URL("../src/web/style.css", import.meta.url), "utf8");
  assert.match(css, /\.style-thumbnail img\s*\{[^}]*object-fit: cover/);
  assert.match(css, /\.style-name\s*\{[^}]*position: absolute;[^}]*bottom: 0/);
  assert.match(css, /\.style-edit-button\s*\{[^}]*top: 0/);
});

test("styles layout keeps labels inside thumbnail, removes header, and aligns toolbar", () => {
  const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/web/style.css", import.meta.url), "utf8");
  const js = readFileSync(new URL("../src/web/styles.js", import.meta.url), "utf8");
  assert.match(html, /id="stylesDialog"[^>]*aria-label="Styles"/);
  assert.doesNotMatch(html, /id="stylesTitle"/);
  assert.match(js, /thumbnail\.append\(label\);\s*button\.append\(thumbnail\);/);
  assert.match(css, /\.style-thumbnail img\s*\{[^}]*inset: 0;[^}]*width: 100%;[^}]*height: 100%/);
  assert.match(css, /#combineStylesButton\s*\{[^}]*padding-left: 4px/);
});

test("lenses share one glass capsule instead of a glass disc each", () => {
  const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/web/style.css", import.meta.url), "utf8");
  assert.match(html, /id="lensBar" class="lens-bar glass"/);
  assert.doesNotMatch(css.match(/\.lens-button\s*\{[^}]*\}/)?.[0] ?? "", /backdrop-filter/);
});

test("styles neutral glass, edge-to-edge thumbnails and subtle controls", () => {
  const css = readFileSync(new URL("../src/web/style.css", import.meta.url), "utf8");
  assert.match(css, /\.style-thumbnail\s*\{[^}]*background: transparent/);
  assert.match(css, /\.style-thumbnail img\s*\{[^}]*object-fit: cover/);
  assert.match(css, /\.lens-button\s*\{[^}]*border: 0;[^}]*background: transparent/);
  assert.match(css, /#addStyleButton \{ gap: 5px; padding-right: 13px; \}/);
  assert.match(css, /\.style-edit-button\s*\{[^}]*right: 0;[^}]*width: 32px/);
});

test("glass uses blur without desaturating the background and displays quieter labels", () => {
  const css = readFileSync(new URL("../src/web/style.css", import.meta.url), "utf8");
  const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
  // Saturation may only boost the picture behind glass, never wash it out.
  for (const [, amount, unit] of css.matchAll(/saturate\((\d*\.?\d+)(%?)\)/g)) {
    assert.ok(Number(amount) / (unit ? 100 : 1) >= 1, `saturate(${amount}${unit}) desaturates`);
  }
  assert.doesNotMatch(css.match(/\.style-name\s*\{[^}]*\}/)?.[0] ?? "", /background\s*:/);
  assert.match(css, /\.capture-mode-other\s*\{[^}]*rgba\(244,245,246,\.44\)/);
  assert.match(css, /\.setting-footer #quitModelButton\s*\{[^}]*color: rgba\(235,238,242,\.58\)/);
  assert.match(css, /#combineStylesButton\s*\{[^}]*font-weight: 650/);
  assert.match(html, /id="customStylesTitle">Custom Styles</);
  assert.match(html, /id="combineStylesButton"[^>]*>Combine Styles</);
  assert.match(html, /id="addStyleButton"[^>]*>\+<span>Add Style<\/span>/);
});

test("custom styles appear above presets in the keyboard-scrollable Styles list", () => {
  const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/web/style.css", import.meta.url), "utf8");
  assert.match(html, /id="styleList"[^>]*tabindex="0"[^>]*>[\s\S]*?id="customStyleSection"[\s\S]*?id="presetStyles"/);
  assert.match(css, /\.style-list\s*\{[^}]*flex: 1 1 auto;[^}]*overflow-y: auto/);
  assert.doesNotMatch(css, /#customStyleSection[^{}]*\{[^}]*grid-column:/);
});

test("Pencil has no backing and is legible over bright thumbnails", () => {
  const css = readFileSync(new URL("../src/web/style.css", import.meta.url), "utf8");
  assert.match(css, /\.style-edit-button\s*\{[^}]*width: 32px;[^}]*height: 32px;[^}]*background: transparent/);
  assert.match(css, /\.style-edit-button svg\s*\{[^}]*width: 19px;[^}]*stroke-width: .85;[^}]*filter: drop-shadow/);
  assert.match(css, /\.style-name\s*\{[^}]*text-shadow:/);
});

test("style-name caption never renders its own backdrop", () => {
  const css = readFileSync(new URL("../src/web/style.css", import.meta.url), "utf8");
  const block = css.match(/\.style-name\s*\{[^}]*\}/)?.[0];
  assert.ok(block, "style-name rule exists");
  assert.doesNotMatch(block, /background(?:-color)?\s*:/);
  assert.doesNotMatch(block, /backdrop-filter\s*:/);
  assert.match(block, /text-shadow\s*:/);
});


test("flash is shown only for the current camera's supported torch", () => {
  const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("../src/web/app.js", import.meta.url), "utf8");
  const visibility = app.match(/function updateFlashVisibility\(track\) \{[\s\S]*?\n\}/)?.[0] || "";
  const flash = app.match(/async function toggleFlash\(\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(html, /id="flashButton"[^>]*\bhidden\b/);
  assert.match(visibility, /getCapabilities.*torch/);
  assert.match(visibility, /flashButton\.hidden = !available/);
  assert.doesNotMatch(flash, /openCameraInput|getUserMedia/);
});

test("visibility suspension keeps the live camera stream for automatic resume", () => {
  const app = readFileSync(new URL("../src/web/app.js", import.meta.url), "utf8");
  const suspend = app.match(/function suspendForVisibility\(\) \{[\s\S]*?\n\}/)?.[0] || "";
  const clear = app.match(/function clearCameraSession\([\s\S]*?\n\}/)?.[0] || "";
  const start = app.match(/async function start\(automaticResume = false\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(suspend, /clearCameraSession\(\{preserveCamera: true\}\)/);
  assert.doesNotMatch(suspend, /releaseCameraInput\(\)/);
  assert.match(clear, /if \(preserveCamera\)[\s\S]*?track\.enabled = false/);
  assert.match(clear, /else \{\s*releaseCameraInput\(\)/);
  assert.match(start, /if \(automaticResume\)[\s\S]*?track\.enabled = true/);
});

test("upscaling state is visually distinct", () => {
  const css = readFileSync(new URL("../src/web/style.css", import.meta.url), "utf8");
  assert.match(css, /#upscaleButton\[aria-pressed="true"\]\s*\{[^}]*background:\s*rgba\(62,164,102/);
  assert.match(css, /#upscaleButton\[aria-pressed="false"\]\s*\{[^}]*background:\s*rgba\(255,255,255/);
});

test("styles toggle closed and Settings can take over", () => {
  const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/web/styles.js", import.meta.url), "utf8");
  const app = readFileSync(new URL("../src/web/app.js", import.meta.url), "utf8");
  assert.equal((html.match(/aria-expanded="false"/g) || []).length >= 2, true);
  assert.match(styles, /if \(stylesDialog\.open\) \{\s*stylesDialog\.close\(\);\s*return;/);
  assert.match(styles, /closeSettings\(\);\s*stylesDialog\.show\(\)/);
  assert.doesNotMatch(styles, /stylesDialog\.showModal\(\)/);
  assert.match(app, /closeSettings: \(\) => setPanel\(false\)/);
  assert.match(app, /settingsButton\.addEventListener\("click", \(\) => \{\s*const stylesDialog = \$\("stylesDialog"\);\s*if \(stylesDialog\.open\) stylesDialog\.close\(\);\s*setPanel\(settingsPanel\.hidden\);/);
});

test("camera switching uses lens choices without a separate flip button", () => {
  const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/web/style.css", import.meta.url), "utf8");
  const app = readFileSync(new URL("../src/web/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(html, /flipCameraButton/);
  assert.doesNotMatch(app, /flipCameraButton|cameraFlipTarget|cameraFacings/);
  assert.match(app, /const lenses = cameraLenses\(cameraDevices, settings, zoom, knownCameraZoom\);/);
  assert.match(app, /button\.textContent = `\$\{selfie \? "−" : ""\}\$\{number\}×`;/);
  assert.match(html, /id="quickStylesButton"/);
  assert.match(css, /\.actions > \.capture-controls\s*\{\s*grid-column: 3;/);
  assert.match(css, /\.actions > #quickStylesButton \{ grid-column: 4;/);
  assert.doesNotMatch(css, /flipCameraButton/);
});

test("glass respects reduced transparency and motion, safe areas and no focus zoom", () => {
  const css = readFileSync(new URL("../src/web/style.css", import.meta.url), "utf8");
  const reduced = css.match(/@media \(prefers-reduced-transparency: reduce\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(reduced, /\.glass[^{]*\{[^}]*backdrop-filter: none/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[^}]*\.actions > #startButton[^}]*transition: none/);
  assert.match(css, /\.flash-button\s*\{[^}]*top: max\(12px, env\(safe-area-inset-top\)\);\s*left: max\(12px, env\(safe-area-inset-left\)\)/);
  assert.match(css, /\.camera-controls\s*\{[^}]*bottom: max\(12px, env\(safe-area-inset-bottom\)\)/);
  for (const selector of ["\\.prompt-line textarea", "#styleEditor input", "#styleEditor textarea"]) {
    assert.match(css, new RegExp(`${selector}\\s*\\{[^}]*font-size: 16px`), selector);
  }
});

test("a Home Screen app fills the screen from the top at the screen height", () => {
  const css = readFileSync(new URL("../src/web/style.css", import.meta.url), "utf8");
  const home = css.slice(css.indexOf("/* Home Screen app."));
  const homeHeightRules = home.split("/* While the search field has the keyboard")[0];
  assert.match(home, /html\.home-screen-app, \.home-screen-app body, \.home-screen-app #app\s*\{\s*height: var\(--app-height, 100lvh\);/);
  assert.match(home, /\.home-screen-app body, \.home-screen-app #app\s*\{\s*inset: 0 auto auto 0;/);
  assert.match(home, /\.home-screen-app #stylesDialog\[open\]\s*\{[^}]*top: calc\(var\(--app-height, 100lvh\) - var\(--styles-bottom\)\);[^}]*bottom: auto;/);
  assert.match(home, /\.home-screen-app \.text-entry \.settings-panel\s*\{\s*bottom: calc\(var\(--app-height, 100lvh\) - var\(--keyboard-top, 0px\)/);
  assert.doesNotMatch(homeHeightRules, /dvh/);
});

test("Home Screen height is the screen's, even when iOS reports display-mode browser", async () => {
  const { homeScreenHeight } = await import("../src/web/home_screen.js");
  const phone = { screenWidth: 402, screenHeight: 874 };
  // iOS Home Screen bookmark: navigator.standalone, window short by the status bar.
  assert.equal(homeScreenHeight({ ...phone, standalone: true, displayModeStandalone: false, innerWidth: 402, innerHeight: 812 }), 874);
  assert.equal(homeScreenHeight({ ...phone, standalone: false, displayModeStandalone: true, innerWidth: 402, innerHeight: 812 }), 874);
  // Landscape: iOS keeps screen in portrait terms.
  assert.equal(homeScreenHeight({ ...phone, standalone: true, displayModeStandalone: false, innerWidth: 874, innerHeight: 380 }), 402);
  // A browser tab is left alone, and a window narrower than the screen keeps its own height.
  assert.equal(homeScreenHeight({ ...phone, standalone: false, displayModeStandalone: false, innerWidth: 402, innerHeight: 700 }), 0);
  assert.equal(homeScreenHeight({ screenWidth: 1024, screenHeight: 1366, standalone: true, displayModeStandalone: false, innerWidth: 507, innerHeight: 1300 }), 1300);
});
