// Network timing belongs to the transport measurement, not the camera session.
export function createLatencyMetrics() {
  let previous = null;
  let jitterMs = 0;
  let decodeMs = 0;
  return {
    reset() {
      previous = null;
      jitterMs = 0;
      decodeMs = 0;
    },
    async measure(peer, metrics, mode, localRoundTripMs) {
      if (mode === "local") return localRoundTripMs;
      let roundTrip = 0;
      if (peer) {
        const stats = await peer.getStats();
        let pair = null;
        let incoming = null;
        for (const item of stats.values()) {
          if (item.type === "transport" && item.selectedCandidatePairId) pair = stats.get(item.selectedCandidatePairId) || pair;
          if (item.type === "candidate-pair" && item.state === "succeeded" && (item.nominated || item.selected)) pair = item;
          if (item.type === "inbound-rtp" && (item.kind === "video" || item.mediaType === "video")) incoming = item;
        }
        if (Number.isFinite(pair?.currentRoundTripTime)) roundTrip = Number(pair.currentRoundTripTime) * 1000;
        if (incoming) {
          const sample = {
            jitterCount: Number(incoming.jitterBufferEmittedCount) || 0,
            jitterDelay: Number(incoming.jitterBufferDelay) || 0,
            decodedCount: Number(incoming.framesDecoded) || 0,
            decodeTime: Number(incoming.totalDecodeTime) || 0
          };
          if (!previous || sample.jitterCount < previous.jitterCount || sample.jitterDelay < previous.jitterDelay ||
              sample.decodedCount < previous.decodedCount || sample.decodeTime < previous.decodeTime) {
            jitterMs = sample.jitterCount ? sample.jitterDelay * 1000 / sample.jitterCount : 0;
            decodeMs = sample.decodedCount ? sample.decodeTime * 1000 / sample.decodedCount : 0;
          } else {
            const jitterCount = sample.jitterCount - previous.jitterCount;
            const decodedCount = sample.decodedCount - previous.decodedCount;
            if (jitterCount > 0) jitterMs = (sample.jitterDelay - previous.jitterDelay) * 1000 / jitterCount;
            if (decodedCount > 0) decodeMs = (sample.decodeTime - previous.decodeTime) * 1000 / decodedCount;
          }
          previous = sample;
        }
      }
      const modelMs = Number(metrics.model_ms) || 0;
      return (Number(metrics.total_ms) || modelMs) + roundTrip + jitterMs + decodeMs;
    }
  };
}
