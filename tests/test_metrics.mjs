import {test} from "node:test";
import assert from "node:assert/strict";
import {createFrameRate, readWebRTCRoundTrip} from "../web/metrics.js";

test("frame rate uses new frames over the measured interval and clears on pause", () => {
  const rate = createFrameRate();
  assert.equal(rate.sample(800, 1000), null);
  assert.equal(rate.sample(809, 2500), 6);
  assert.equal(rate.sample(809, 3500), 0);
  rate.reset();
  assert.equal(rate.sample(813, 8000), null);
  assert.equal(rate.sample(818, 9000), 5);
});

test("WebRTC round trip comes from the selected ICE pair", async () => {
  const peer = {getStats: async () => new Map([
    ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
    ["pair", { type: "candidate-pair", currentRoundTripTime: 0.02 }],
    ["other", { type: "candidate-pair", state: "succeeded", nominated: true, currentRoundTripTime: 0.08 }]
  ])};
  assert.equal(await readWebRTCRoundTrip(peer), 20);
  assert.equal(await readWebRTCRoundTrip({getStats: async () => new Map()}), null);
});
