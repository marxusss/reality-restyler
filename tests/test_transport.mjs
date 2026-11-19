import { test } from "node:test";
import assert from "node:assert/strict";
import { cameraFrameSize, encodeCameraFrame } from "../web/transport.js";

test("adaptive sizing preserves landscape and portrait aspect ratios", () => {
  assert.deepEqual(cameraFrameSize(1920, 1080, 1024), [1024, 576]);
  assert.deepEqual(cameraFrameSize(1080, 1920, 512), [288, 512]);
  assert.deepEqual(cameraFrameSize(320, 240, 1024), [320, 240]);
  assert.throws(() => cameraFrameSize(0, 0, 512));
});

test("camera encoder uses scaled JPEG and returns bytes", async () => {
  const calls = [];
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  const canvas = {width: 0, height: 0, toBlob(callback, mime, quality) {
    calls.push([mime, quality]);
    callback({type: mime, arrayBuffer: async () => bytes});
  }};
  const result = await encodeCameraFrame({videoWidth: 1920, videoHeight: 1080}, canvas,
    {drawImage(...args) {calls.push(args.slice(1));}}, 512);
  assert.equal(canvas.width, 512);
  assert.equal(canvas.height, 288);
  assert.deepEqual(calls, [[0, 0, 512, 288], ["image/jpeg", 0.88]]);
  assert.equal(result, bytes);
});
