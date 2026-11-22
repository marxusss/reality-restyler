import { test } from "node:test";
import assert from "node:assert/strict";
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
