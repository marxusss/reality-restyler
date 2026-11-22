import { test } from "node:test";
import assert from "node:assert/strict";
import { cameraLenses } from "../web/camera.js";

test("selfie camera keeps the rear camera's observed zoom options", () => {
  const devices = [
    {deviceId: "rear", label: "Back Camera"},
    {deviceId: "rear-triple", label: "Back Triple Camera"},
    {deviceId: "selfie", label: "Front Ultra Wide Camera"},
  ];
  const observed = new Map([["rear-triple", {min: 1, max: 4, step: 0.1}]]);
  const lenses = cameraLenses(devices, {deviceId: "selfie", facingMode: "user"}, null, observed);

  assert.deepEqual(lenses.filter(lens => lens.active).map(lens => lens.deviceId), ["selfie"]);
  assert.deepEqual(
    lenses.filter(lens => lens.zoom > 1).map(lens => [lens.deviceId, lens.zoom]),
    [["rear-triple", 2], ["rear-triple", 4]],
  );
});

test("unidentified desktop cameras do not generate lens choices", () => {
  const devices = [
    {deviceId: "webcam", label: "USB Webcam"},
    {deviceId: "obs", label: "OBS Virtual Camera"},
  ];
  assert.deepEqual(cameraLenses(devices, {deviceId: "webcam"}), []);
  assert.deepEqual(cameraLenses(devices, {deviceId: "obs", facingMode: "user"}), []);
});

test("camera can open on a device with only one camera", async t => {
  const originalWindow = globalThis.window;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  t.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete globalThis.navigator;
  });
  globalThis.window = {isSecureContext: true};
  let calls = 0;
  Object.defineProperty(globalThis, "navigator", {configurable: true, value: {
    mediaDevices: {getUserMedia: async constraints => {
      calls++;
      assert.equal(constraints.video.facingMode.ideal, "environment");
      return {getTracks: () => [{stop() {}}]};
    }}
  }});
  const {openStartingCamera} = await import("../web/camera.js");
  const stream = await openStartingCamera();
  assert.ok(stream);
  assert.equal(calls, 1);
});

test("missing selected camera falls back to the available camera", async t => {
  const originalWindow = globalThis.window;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  t.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete globalThis.navigator;
  });
  globalThis.window = {isSecureContext: true};
  const requests = [];
  Object.defineProperty(globalThis, "navigator", {configurable: true, value: {
    mediaDevices: {getUserMedia: async constraints => {
      requests.push(constraints.video);
      if (constraints.video.deviceId) throw Object.assign(new Error("Missing camera"), {name: "NotFoundError"});
      return {getTracks: () => [{stop() {}}]};
    }}
  }});
  const {openStartingCamera} = await import("../web/camera.js");
  assert.ok(await openStartingCamera({deviceId: "missing"}));
  assert.equal(requests.length, 2);
  assert.equal(requests[0].deviceId.exact, "missing");
  assert.equal(requests[1].facingMode.ideal, "environment");
});
