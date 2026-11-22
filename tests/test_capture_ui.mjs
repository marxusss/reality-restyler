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
  assert.match(css, /\.shutter-button\s*\{[^}]*width: 48px; height: 48px/);
  assert.match(css, /backdrop-filter: blur\(5px\) saturate\(112%\) contrast\(102%\)/);
});
