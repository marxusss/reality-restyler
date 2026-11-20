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
