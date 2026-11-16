const $ = id => document.getElementById(id);
const output = $("output");
const startButton = $("startButton");
const settingsButton = $("settingsButton");
const settingsPanel = $("settingsPanel");
const errorBox = $("error");
const startup = $("startup");
const latency = $("latency");
const promptInput = $("promptInput");
const stepsInput = $("stepsInput");
const stepsValue = $("stepsValue");
const resolutionInput = $("resolutionInput");
const seedInput = $("seedInput");
const cameraInput = $("cameraInput");
const upscaleButton = $("upscaleButton");
const flashButton = $("flashButton");
const mirrorButton = $("mirrorButton");
let peer = null;
let stream = null;
let sessionId = "";
let started = false;
let busy = false;
let mirror = false;
let upscale = true;
let settingsTimer = 0;
let heartbeatTimer = 0;
let metricsTimer = 0;
let previousStats = null;
let jitterMs = 0;
let decodeMs = 0;

function showError(message) {
  errorBox.textContent = message || "";
  errorBox.hidden = !message;
}

function showStartup(message) {
  startup.textContent = message || "";
  startup.hidden = !message;
}

function currentRotation() {
  let angle = Number(screen.orientation && screen.orientation.angle);
  if (!Number.isFinite(angle) && Number.isFinite(Number(window.orientation))) angle = Number(window.orientation);
  if (!Number.isFinite(angle)) angle = 0;
  return ((Math.round(angle / 90) * 90) % 360 + 360) % 360;
}

function readSettings() {
  let seed = Number(seedInput.value);
  if (!Number.isInteger(seed) || seed < 0 || seed > 2147483647) seed = 0;
  return {
    prompt: promptInput.value,
    steps: Number(stepsInput.value),
    resolution: Number(resolutionInput.value),
    seed,
    upscale,
    rotation: currentRotation()
  };
}

function saveSettings() {
  try {
    localStorage.setItem("reality-restyle-settings", JSON.stringify({
      prompt: promptInput.value,
      steps: Number(stepsInput.value),
      resolution: Number(resolutionInput.value),
      seed: Number(seedInput.value) || 0,
      upscale
    }));
  } catch (_) {}
}

function restoreSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem("reality-restyle-settings") || "{}");
    if (typeof saved.prompt === "string") promptInput.value = saved.prompt;
    if (Number.isInteger(saved.steps) && saved.steps >= 1 && saved.steps <= 12) stepsInput.value = String(saved.steps);
    if ([512, 640, 768, 896, 1024].includes(Number(saved.resolution))) resolutionInput.value = String(saved.resolution);
    if (Number.isInteger(saved.seed) && saved.seed >= 0 && saved.seed <= 2147483647) seedInput.value = String(saved.seed);
    if (typeof saved.upscale === "boolean") upscale = saved.upscale;
  } catch (_) {}
  stepsValue.value = stepsInput.value;
  stepsValue.textContent = stepsInput.value;
  upscaleButton.setAttribute("aria-pressed", String(upscale));
}

async function request(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store"
  });
  let result = {};
  try { result = await response.json(); } catch (_) {}
  if (!response.ok) {
    const failure = new Error(result.error || "Request failed (" + response.status + ").");
    failure.status = response.status;
    failure.data = result;
    throw failure;
  }
  return result;
}

async function startRuntime() {
  let result;
  try {
    result = await request("/start", { settings: readSettings(), allow_low_vram: false });
  } catch (error) {
    if (error.status === 409 && error.data && error.data.low_vram) {
      const proceed = window.confirm("Low free VRAM. Starting may fail or cause the system to use shared memory. Continue?");
      if (!proceed) throw new Error("Start cancelled.");
      result = await request("/start", { settings: readSettings(), allow_low_vram: true });
    } else {
      throw error;
    }
  }
  if (!result.ok) throw new Error("Could not start the local runtime.");
}

async function cameraStream(deviceId = "", facingMode = "environment") {
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error("Camera access requires a secure HTTPS page.");
  }
  const video = deviceId
    ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, frameRate: { ideal: 30, max: 30 } }
    : { facingMode: { ideal: facingMode }, width: { ideal: 1280 }, frameRate: { ideal: 30, max: 30 } };
  return navigator.mediaDevices.getUserMedia({ video, audio: false });
}

async function populateCameras(selectedId = "") {
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(item => item.kind === "videoinput");
  cameraInput.replaceChildren();
  for (const [index, device] of devices.entries()) {
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent = device.label || "Camera " + (index + 1);
    cameraInput.append(option);
  }
  if (selectedId && devices.some(item => item.deviceId === selectedId)) cameraInput.value = selectedId;
}

function setMirror(value) {
  mirror = Boolean(value);
  output.classList.toggle("mirrored", mirror);
  mirrorButton.setAttribute("aria-pressed", String(mirror));
}

async function startPeer() {
  peer = new RTCPeerConnection({ iceServers: [] });
  peer.addEventListener("track", event => {
    if (!peer || event.track.kind !== "video") return;
    output.srcObject = event.streams[0] || new MediaStream([event.track]);
    output.play().catch(() => {});
  });
  peer.addEventListener("connectionstatechange", () => {
    if (!started || !peer) return;
    if (peer.connectionState === "failed") {
      showError("Camera connection failed.");
      void stop(false);
    }
  });
  for (const track of stream.getTracks()) peer.addTrack(track, stream);
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  await new Promise((resolve, reject) => {
    if (peer.iceGatheringState === "complete") return resolve();
    const timer = setTimeout(() => reject(new Error("Camera connection timed out.")), 15000);
    const check = () => {
      if (peer && peer.iceGatheringState === "complete") {
        clearTimeout(timer);
        peer.removeEventListener("icegatheringstatechange", check);
        resolve();
      }
    };
    peer.addEventListener("icegatheringstatechange", check);
  });
  const answer = await request("/offer", { sdp: peer.localDescription.sdp, type: peer.localDescription.type });
  sessionId = answer.session_id;
  await peer.setRemoteDescription({ sdp: answer.sdp, type: answer.type });
}

async function sendSettings() {
  if (!started) return;
  try {
    await request("/settings", { settings: readSettings() });
  } catch (error) {
    showError(error.message);
  }
}

function scheduleSettings() {
  saveSettings();
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => void sendSettings(), 120);
}

async function start() {
  if (busy || started) return;
  busy = true;
  showError("");
  showStartup("Loading");
  startButton.disabled = true;
  try {
    await startRuntime();
    showStartup("Opening camera");
    stream = await cameraStream();
    output.srcObject = stream;
    await populateCameras(stream.getVideoTracks()[0]?.getSettings?.().deviceId || "");
    await request("/settings", { settings: readSettings() });
    showStartup("Connecting");
    await startPeer();
    started = true;
    startButton.textContent = "Stop";
    latency.hidden = false;
    showStartup("");
    heartbeatTimer = setInterval(() => void heartbeat(), 10000);
    metricsTimer = setInterval(() => void updateMetrics(), 1000);
    await updateMetrics();
  } catch (error) {
    await stop(true, true);
    if (error.message !== "Start cancelled.") showError(error.message);
  } finally {
    busy = false;
    startButton.disabled = false;
  }
}

async function stop(sendRequest = true, preserveError = false) {
  const currentPeer = peer;
  const currentStream = stream;
  peer = null;
  stream = null;
  sessionId = "";
  started = false;
  clearInterval(heartbeatTimer);
  clearInterval(metricsTimer);
  clearTimeout(settingsTimer);
  heartbeatTimer = 0;
  metricsTimer = 0;
  if (currentPeer) {
    try { currentPeer.close(); } catch (_) {}
  }
  if (currentStream) {
    for (const track of currentStream.getTracks()) {
      try { track.stop(); } catch (_) {}
    }
  }
  output.srcObject = null;
  latency.hidden = true;
  showStartup("");
  startButton.textContent = "Start";
  flashButton.setAttribute("aria-pressed", "false");
  if (sendRequest) {
    try { await request("/stop", {}); } catch (error) { if (!preserveError) showError(error.message); }
  }
  if (!preserveError) showError("");
}

async function heartbeat() {
  if (!started || document.visibilityState !== "visible") return;
  try {
    const result = await request("/heartbeat", {});
    if (!result.loaded) {
      await stop(false, true);
      showError("The runtime ended after inactivity.");
    }
  } catch (error) {
    showError(error.message);
  }
}

async function updateMetrics() {
  if (!started || document.visibilityState !== "visible") return;
  try {
    const metrics = await request("/metrics");
    if (metrics.error) showError(metrics.error);
    else showError("");
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
        if (!previousStats || sample.jitterCount < previousStats.jitterCount || sample.jitterDelay < previousStats.jitterDelay || sample.decodedCount < previousStats.decodedCount || sample.decodeTime < previousStats.decodeTime) {
          jitterMs = sample.jitterCount ? sample.jitterDelay * 1000 / sample.jitterCount : 0;
          decodeMs = sample.decodedCount ? sample.decodeTime * 1000 / sample.decodedCount : 0;
        } else {
          const jitterCount = sample.jitterCount - previousStats.jitterCount;
          const decodedCount = sample.decodedCount - previousStats.decodedCount;
          if (jitterCount > 0) jitterMs = (sample.jitterDelay - previousStats.jitterDelay) * 1000 / jitterCount;
          if (decodedCount > 0) decodeMs = (sample.decodeTime - previousStats.decodeTime) * 1000 / decodedCount;
        }
        previousStats = sample;
      }
    }
    const modelMs = Number(metrics.model_ms) || 0;
    const totalMs = Number(metrics.total_ms) || modelMs;
    const phoneMs = totalMs + roundTrip + jitterMs + decodeMs;
    latency.textContent = "Model " + Math.round(modelMs) + " ms · Phone " + Math.round(phoneMs) + " ms";
  } catch (error) {
    showError(error.message);
  }
}

async function switchCamera(deviceId) {
  if (!deviceId) return;
  let next = null;
  try {
    next = await cameraStream(deviceId);
    const nextTrack = next.getVideoTracks()[0];
    if (!nextTrack) throw new Error("The selected camera returned no video.");
    if (peer) {
      const sender = peer.getSenders().find(item => item.track && item.track.kind === "video");
      if (!sender) throw new Error("The camera connection is unavailable.");
      await sender.replaceTrack(nextTrack);
    }
    const previous = stream;
    stream = next;
    output.srcObject = next;
    output.play().catch(() => {});
    if (previous) for (const track of previous.getTracks()) track.stop();
  } catch (error) {
    if (next) for (const track of next.getTracks()) track.stop();
    showError(error.message);
  }
}

async function toggleFlash() {
  if (!stream) {
    showError("Start the camera before using flash.");
    return;
  }
  const track = stream.getVideoTracks()[0];
  const capabilities = track.getCapabilities ? track.getCapabilities() : {};
  if (!capabilities.torch) {
    showError("Flash is unavailable on this camera.");
    return;
  }
  const enabled = flashButton.getAttribute("aria-pressed") === "true";
  try {
    await track.applyConstraints({ advanced: [{ torch: !enabled }] });
    flashButton.setAttribute("aria-pressed", String(!enabled));
    showError("");
  } catch (_) {
    showError("Could not change flash.");
  }
}

function setPanel(open) {
  settingsPanel.hidden = !open;
  settingsButton.setAttribute("aria-expanded", String(open));
}

function randomizeSeed() {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  seedInput.value = String(values[0] % 2147483648);
  scheduleSettings();
}

settingsButton.addEventListener("click", () => setPanel(settingsPanel.hidden));
$("closeSettingsButton").addEventListener("click", () => setPanel(false));
startButton.addEventListener("click", () => started ? void stop(true) : void start());
flashButton.addEventListener("click", () => void toggleFlash());
mirrorButton.addEventListener("click", () => setMirror(!mirror));
upscaleButton.addEventListener("click", () => {
  upscale = !upscale;
  upscaleButton.setAttribute("aria-pressed", String(upscale));
  scheduleSettings();
});
stepsInput.addEventListener("input", () => {
  stepsValue.value = stepsInput.value;
  stepsValue.textContent = stepsInput.value;
  scheduleSettings();
});
for (const element of [promptInput, resolutionInput, seedInput]) {
  element.addEventListener("input", scheduleSettings);
  element.addEventListener("change", scheduleSettings);
}
cameraInput.addEventListener("change", () => void switchCamera(cameraInput.value));
$("randomSeedButton").addEventListener("click", randomizeSeed);
for (const eventName of ["orientationchange", "resize"]) {
  window.addEventListener(eventName, () => {
    if (started) void sendSettings();
  });
}
if (screen.orientation) screen.orientation.addEventListener("change", () => {
  if (started) void sendSettings();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && started) void heartbeat();
});
restoreSettings();
