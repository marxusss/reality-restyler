import { cameraFrameSize } from "./frame_encoding.js";

// Own the connection handshake; camera lifecycle and UI remain in app.js.
export async function setWebRTCInputResolution(peer, resolution) {
  const sender = peer.getSenders().find(sender => sender.track?.kind === "video");
  if (!sender) return;
  try {
    const {width, height} = sender.track.getSettings();
    if (!width || !height) return;
    const [targetWidth, targetHeight] = cameraFrameSize(width, height, resolution);
    const parameters = sender.getParameters();
    if (!parameters.encodings?.length) return;
    parameters.encodings[0].scaleResolutionDownBy = Math.max(1, width / targetWidth, height / targetHeight);
    await sender.setParameters(parameters);
  } catch (error) {
    // Input scaling is an optimization; do not interrupt an otherwise working camera.
    console.warn("WebRTC input downscaling unavailable:", error);
  }
}

export async function openWebRTC(stream, {created, isCurrent, onTrack, onState, offer, resolution}) {
  const peer = new RTCPeerConnection({iceServers: []});
  created(peer);
  peer.addEventListener("track", event => onTrack(peer, event));
  peer.addEventListener("connectionstatechange", () => onState(peer));
  for (const track of stream.getTracks()) peer.addTrack(track, stream);
  await peer.setLocalDescription(await peer.createOffer());
  await setWebRTCInputResolution(peer, resolution);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Camera connection timed out.")), 15000);
    function finish(error) {
      clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", check);
      peer.removeEventListener("connectionstatechange", check);
      if (error) reject(error); else resolve();
    }
    function check() {
      if (!isCurrent(peer) || peer.connectionState === "closed") finish(new Error("Camera connection was interrupted."));
      else if (peer.iceGatheringState === "complete") finish();
    }
    peer.addEventListener("icegatheringstatechange", check);
    peer.addEventListener("connectionstatechange", check);
    check();
  });
  if (!isCurrent(peer)) throw new Error("Camera connection was interrupted.");
  const answer = await offer({sdp: peer.localDescription.sdp, type: peer.localDescription.type});
  if (!isCurrent(peer)) throw new Error("Camera connection was interrupted.");
  await peer.setRemoteDescription({sdp: answer.sdp, type: answer.type});
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Camera connection timed out.")), 18000);
    function finish(error) {
      clearTimeout(timer);
      peer.removeEventListener("connectionstatechange", check);
      if (error) reject(error); else resolve();
    }
    function check() {
      if (!isCurrent(peer) || ["failed", "closed"].includes(peer.connectionState)) finish(new Error("Camera connection failed."));
      else if (peer.connectionState === "connected") finish();
    }
    peer.addEventListener("connectionstatechange", check);
    check();
  });
  return peer;
}

export function openLocalSocket(token, {created, onMessage, onClose}) {
  const url = new URL("/local-stream", window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url, ["restyle." + token]);
  socket.binaryType = "blob";
  created(socket);
  socket.addEventListener("message", event => onMessage(socket, event));
  socket.addEventListener("close", () => onClose(socket));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error("Local connection timed out.")); }, 10000);
    const failed = () => { clearTimeout(timer); reject(new Error("Local camera connection failed.")); };
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, {once: true});
    socket.addEventListener("error", failed, {once: true});
    socket.addEventListener("close", failed, {once: true});
  });
}
