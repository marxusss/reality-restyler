import { test } from "node:test";
import assert from "node:assert/strict";
import { cameraFacings, cameraFlipTarget, cameraLenses } from "../src/web/camera.js";

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

test("flip returns to the lens last used on the other side, else its 1x lens", () => {
  const devices = [
    {deviceId: "front", label: "Front Camera"},
    {deviceId: "back", label: "Back Camera"},
    {deviceId: "back-uw", label: "Back Ultra Wide Camera"},
  ];
  const rear = cameraLenses(devices, {deviceId: "back", facingMode: "environment"});
  assert.deepEqual(cameraFlipTarget(rear, "environment"), rear.find(lens => lens.deviceId === "front"));
  const front = cameraLenses(devices, {deviceId: "front", facingMode: "user"});
  assert.equal(cameraFlipTarget(front, "user").deviceId, "back");
  const ultraWide = front.find(lens => lens.deviceId === "back-uw");
  assert.equal(cameraFlipTarget(front, "user", {deviceId: "back-uw", magnification: 0.5}), ultraWide);
  assert.deepEqual(cameraFlipTarget([], "environment"), {facing: "user"});
  assert.deepEqual(cameraFlipTarget([], "user"), {facing: "environment"});
});

test("flip is offered only when labelled cameras face both ways", () => {
  assert.deepEqual([...cameraFacings([{label: "Front Camera"}, {label: "Back Camera"}])].sort(), ["environment", "user"]);
  assert.deepEqual([...cameraFacings([{label: ""}, {label: ""}])], []);
  assert.deepEqual([...cameraFacings([{label: "FaceTime HD Camera"}, {label: "OBS Virtual Camera"}])], ["user"]);
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
  const {openStartingCamera} = await import("../src/web/camera.js");
  const stream = await openStartingCamera();
  assert.ok(stream);
  assert.equal(calls, 1);
});

test("missing selected camera does not open a different camera", async t => {
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
      throw Object.assign(new Error("Missing camera"), {name: "NotFoundError"});
    }}
  }});
  const {openStartingCamera} = await import("../src/web/camera.js");
  await assert.rejects(openStartingCamera({deviceId: "missing"}), /No camera is available\./);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].deviceId.exact, "missing");
});
