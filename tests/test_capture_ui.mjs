import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mountCapture } from "../web/capture.js";

function element() {
  const listeners = new Map();
  return {
    dataset: {}, hidden: false, disabled: false, textContent: "",
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute(name, value) { this[name] = value; },
    addEventListener(name, callback) { listeners.set(name, callback); },
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
  } finally {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  }
});

test("settings Done commits edits, closes the panel and replaces clear prompt", () => {
  const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  assert.match(html, /id="doneSettingsButton"/);
  assert.doesNotMatch(html, /id="clearPromptButton"/);
  assert.doesNotMatch(app, /clearPromptButton/);
  assert.match(app, /doneSettingsButton\.addEventListener\("click",[\s\S]*?void applySettings\(\);\s*setPanel\(false\);/);
});

test("diagnostics share one compact footer with Load or Unload model", () => {
  const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../web/style.css", import.meta.url), "utf8");
  assert.match(html, /class="setting-footer"[\s\S]*?id="latency"[^>]*>Model[^<]*<\/div>\s*<button id="quitModelButton"/);
  assert.doesNotMatch(html, /id="latency"[^>]*hidden/);
  assert.match(css, /\.setting-footer #quitModelButton\s*\{\s*flex:\s*0 0 auto/);
});

test("styles sit above the smaller capture dock, with a visible glass background", () => {
  const css = readFileSync(new URL("../web/style.css", import.meta.url), "utf8");
  assert.match(css, /#stylesDialog\[open\]\s*\{[^}]*bottom: calc\(max\(12px,env\(safe-area-inset-bottom\)\) \+ 86px \+ var\(--lens-height,0px\) \+ var\(--capture-save-height,0px\)\)/);
  assert.match(css, /#stylesDialog\[open\]\s*\{[^}]*height: min\(72dvh,480px\)/);
  assert.match(css, /\.shutter-button\s*\{[^}]*width: 42px; height: 42px/);
  assert.match(css, /backdrop-filter: blur\(4px\) saturate\(108%\) contrast\(102%\)/);
});

test("video is opaque, modes readable, and pause stays aligned", () => {
  const css = readFileSync(new URL("../web/style.css", import.meta.url), "utf8");
  assert.match(css, /\.shutter-button:disabled\s*\{\s*opacity:\s*1/);
  assert.match(css, /\.capture-mode-other\s*\{[^}]*rgba\(255,255,255,\.88\)/);
  assert.match(css, /\.actions > #startButton\s*\{[^}]*align-self: end;[^}]*place-items: center/);
});
test("palette icon, outline Done, right-aligned Add style and less-wide thumbnails", () => {
  const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../web/style.css", import.meta.url), "utf8");
  assert.equal((html.match(/a9 9 0 0 0 0 18/g) || []).length, 2);
  assert.match(css, /\.prompt-line \.settings-done\s*\{[^}]*background: rgba\(255,255,255,\.06\)/);
  assert.match(css, /#addStyleButton, #useStylesButton\s*\{ margin-left: auto; \}/);
  assert.match(css, /\.style-thumbnail\s*\{[^}]*aspect-ratio: 7 \/ 5/);
});
test("style names stay original and labels are overlaid within thumbnails", () => {
  const styles = JSON.parse(readFileSync(new URL("../web/styles/catalog.json", import.meta.url), "utf8"));
  const css = readFileSync(new URL("../web/style.css", import.meta.url), "utf8");
  assert.equal(styles.find(s => s.id === "hand-painted-animation").name, "Hand-painted fantasy animation");
  assert.match(css, /\.style-card > span:last-child\s*\{[^}]*white-space: normal/);
  assert.match(css, /\.style-card > span:last-child\s*\{[^}]*background: rgba\(43, 46, 50, \.77\)/);
});

test("settings and lens gap matches lens and mode gap in portrait and landscape", () => {
  const css = readFileSync(new URL("../web/style.css", import.meta.url), "utf8");
  // Portrait: dock 72 + row gap 8 + lens 36; 14px separates both layers.
  assert.match(css, /\.settings-panel\s*\{[^}]*bottom: calc\(max\(12px, env\(safe-area-inset-bottom\)\) \+ 88px\)/);
  // Landscape uses 68px dock, 5px row gap and 8px separation.
  assert.match(css, /\.settings-panel \{ bottom: calc\(max\(6px,env\(safe-area-inset-bottom\)\) \+ 75px\)/);
});

test("thumbnail fits entire style image and custom edit icon clears overlay", () => {
  const css = readFileSync(new URL("../web/style.css", import.meta.url), "utf8");
  assert.match(css, /\.style-thumbnail img\s*\{[^}]*object-fit: contain/);
  assert.match(css, /\.style-card > span:last-child\s*\{[^}]*position: absolute;[^}]*bottom: 0/);
  assert.match(css, /\.style-edit-button\s*\{[^}]*top: 5px/);
});
