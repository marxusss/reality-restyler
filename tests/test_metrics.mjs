import {test} from "node:test";
import assert from "node:assert/strict";
import {createLatencyMetrics} from "../web/metrics.js";

test("local camera latency uses observed round trip", async () => {
  const metrics = createLatencyMetrics();
  assert.equal(await metrics.measure(null, {model_ms: 10, total_ms: 13}, "local", 42), 42);
});

test("remote camera latency uses per-interval jitter/decode and resets", async () => {
  const metrics = createLatencyMetrics();
  let sample = 1;
  const peer = {getStats: async () => new Map([
    ["pair", {id:"pair", type:"candidate-pair", state:"succeeded", nominated:true, currentRoundTripTime:0.02}],
    ["video", {type:"inbound-rtp", kind:"video", jitterBufferEmittedCount:sample * 2,
      jitterBufferDelay: sample * 0.02, framesDecoded:sample * 2, totalDecodeTime:sample * 0.01}]
  ])};
  assert.equal(await metrics.measure(peer, {model_ms:100,total_ms:120}, "remote", 0), 155);
  sample = 2;
  assert.equal(await metrics.measure(peer, {model_ms:100,total_ms:120}, "remote", 0), 155);
  metrics.reset();
  assert.equal(await metrics.measure(peer, {model_ms:100,total_ms:120}, "remote", 0), 155);
});
