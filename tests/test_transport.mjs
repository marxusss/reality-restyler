import {test} from "node:test";
import assert from "node:assert/strict";
import {openWebRTC, setWebRTCInputResolution} from "../web/transport.js";

test("WebRTC negotiation keeps ownership checks across both stages", async () => {
  const Original = globalThis.RTCPeerConnection;
  class FakePeer extends EventTarget {
    constructor() {
      super();
      this.connectionState = "connected";
      this.iceGatheringState = "complete";
      this.localDescription = {sdp: "local-offer", type: "offer"};
    }
    addTrack(track) {
      this.sender = {
        track,
        getParameters: () => ({encodings: [{}]}),
        setParameters: async parameters => { this.encoding = parameters.encodings[0]; }
      };
    }
    getSenders() { return [this.sender]; }
    async createOffer() { return this.localDescription; }
    async setLocalDescription() {}
    async setRemoteDescription(answer) { this.answer = answer; }
  }
  globalThis.RTCPeerConnection = FakePeer;
  try {
    let current = null, offers = 0;
    const peer = await openWebRTC({getTracks: () => [{
      kind: "video",
      getSettings: () => ({width: 1920, height: 1080})
    }]}, {
      created: pc => { current = pc; },
      isCurrent: pc => pc === current,
      onTrack: () => {},
      onState: () => {},
      offer: async data => { offers++; assert.equal(data.sdp, "local-offer"); return {sdp:"answer",type:"answer"}; },
      resolution: 512
    });
    assert.equal(peer, current);
    assert.equal(peer.answer.sdp, "answer");
    assert.equal(offers, 1);
    assert.equal(peer.encoding.scaleResolutionDownBy, 3.75);
  } finally {
    globalThis.RTCPeerConnection = Original;
  }
});


test("WebRTC sender scaling follows resolution changes without touching camera capture", async () => {
  const track = {kind: "video", getSettings: () => ({width: 1080, height: 1920})};
  let last = 0;
  const sender = {
    track,
    getParameters: () => ({encodings: [{}]}),
    setParameters: async parameters => { last = parameters.encodings[0].scaleResolutionDownBy; }
  };
  const peer = {getSenders: () => [sender]};
  await setWebRTCInputResolution(peer, 512);
  assert.equal(last, 3.75);
  await setWebRTCInputResolution(peer, 1024);
  assert.equal(last, 1.875);
  assert.equal(track.getSettings().width, 1080);
});

test("small camera inputs are never enlarged by WebRTC scaling", async () => {
  let scale = 0;
  const peer = {getSenders: () => [{
    track: {kind: "video", getSettings: () => ({width: 320, height: 240})},
    getParameters: () => ({encodings: [{}]}),
    setParameters: async parameters => { scale = parameters.encodings[0].scaleResolutionDownBy; }
  }]};
  await setWebRTCInputResolution(peer, 1024);
  assert.equal(scale, 1);
});
