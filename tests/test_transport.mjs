import {test} from "node:test";
import assert from "node:assert/strict";
import {openWebRTC} from "../web/transport.js";

test("WebRTC negotiation keeps ownership checks across both stages", async () => {
  const Original = globalThis.RTCPeerConnection;
  class FakePeer extends EventTarget {
    constructor() {
      super();
      this.connectionState = "connected";
      this.iceGatheringState = "complete";
      this.localDescription = {sdp: "local-offer", type: "offer"};
    }
    addTrack() {}
    async createOffer() { return this.localDescription; }
    async setLocalDescription() {}
    async setRemoteDescription(answer) { this.answer = answer; }
  }
  globalThis.RTCPeerConnection = FakePeer;
  try {
    let current = null, offers = 0;
    const peer = await openWebRTC({getTracks: () => [{}]}, {
      created: pc => { current = pc; },
      isCurrent: pc => pc === current,
      onTrack: () => {},
      onState: () => {},
      offer: async data => { offers++; assert.equal(data.sdp, "local-offer"); return {sdp:"answer",type:"answer"}; }
    });
    assert.equal(peer, current);
    assert.equal(peer.answer.sdp, "answer");
    assert.equal(offers, 1);
  } finally {
    globalThis.RTCPeerConnection = Original;
  }
});
