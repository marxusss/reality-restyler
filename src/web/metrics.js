export function createFrameRate() {
  let previous = null;
  return {
    reset() { previous = null; },
    sample(frames, now) {
      if (!Number.isFinite(frames)) return null;
      const last = previous;
      previous = {frames, now};
      if (!last || frames < last.frames || now <= last.now) return null;
      return (frames - last.frames) * 1000 / (now - last.now);
    }
  };
}

export async function readWebRTCRoundTrip(peer) {
  const stats = await peer.getStats();
  let selected;
  let nominated;
  for (const item of stats.values()) {
    if (item.type === "transport" && item.selectedCandidatePairId) selected = stats.get(item.selectedCandidatePairId);
    if (item.type === "candidate-pair" && item.state === "succeeded" && (item.nominated || item.selected)) nominated = item;
  }
  const seconds = (selected ?? nominated)?.currentRoundTripTime;
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}
