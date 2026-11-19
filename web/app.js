import { cameraStream, currentRotation } from "./camera.js";
import { encodeCameraFrame } from "./transport.js";

const $ = id => document.getElementById(id);
const output = $("output");
const localOutput = $("localOutput");
const localContext = localOutput.getContext("2d", { alpha: false });
const localInputCanvas = document.createElement("canvas");
const localInputContext = localInputCanvas.getContext("2d", { alpha: false });
const startButton = $("startButton");
const settingsButton = $("settingsButton");
const quitModelButton = $("quitModelButton");
const clearPromptButton = $("clearPromptButton");
const settingsPanel = $("settingsPanel");
const errorBox = $("error");
const startup = $("startup");
const startupLabel = $("startupLabel");
const startupProgress = $("startupProgress");
const startupFill = $("startupFill");
const latency = $("latency");
const promptInput = $("promptInput");
const stepsInput = $("stepsInput");
const stepsValue = $("stepsValue");
const resolutionInput = $("resolutionInput");
const cameraInput = $("cameraInput");
const upscaleButton = $("upscaleButton");
const flashButton = $("flashButton");
const mirrorButton = $("mirrorButton");
let peer = null;
let stream = null;
let localSocket = null;
let sessionToken = "";
let started = false;
let busy = false;
let runtimeLoaded = false;
let transportMode = "remote";
let mirror = false;
let upscale = true;
let heartbeatTimer = 0;
let metricsTimer = 0;
let promptApplyTimer = 0;
let settingsApplyQueue = Promise.resolve();
let cameraSwitchQueue = Promise.resolve();
let cameraSwitchSequence = 0;
let localFramePending = false;
let localFrameDeadline = 0;
let localFrameFailures = 0;
let metricsPending = false;
let heartbeatPending = false;
let generation = 0;
let localFrameTimer = 0;
let localFrameSentAt = 0;
let localRoundTripMs = 0;
let previousStats = null;
let jitterMs = 0;
let decodeMs = 0;

const errors = new Map();
function showError(message, source = "action") {
  if (message) errors.set(source, message);
  else errors.delete(source);
  errorBox.textContent = [...errors.values()].join(" · ");
  errorBox.hidden = errors.size === 0;
}
function clearErrors() { errors.clear(); showError(""); }

function showStartup(message) {
  const visible = Boolean(message);
  startupLabel.textContent = message || "";
  startup.hidden = !visible;
  startup.classList.toggle("indeterminate", visible);
  startupProgress.removeAttribute("aria-valuenow");
  startupProgress.setAttribute("aria-valuetext", message || "");
  startupFill.style.width = visible ? "34%" : "0%";
}

function readSettings() {
  return {
    prompt: promptInput.value,
    steps: Number(stepsInput.value),
    resolution: Number(resolutionInput.value),
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
      upscale,
      version: 2
    }));
  } catch (_) {}
}

function restoreSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem("reality-restyle-settings") || "{}");
    if (typeof saved.prompt === "string") promptInput.value = saved.prompt;
    if (Number.isInteger(saved.steps) && saved.steps >= 1 && saved.steps <= 12) stepsInput.value = String(saved.steps);
    if (saved.version !== 2 && Number(saved.resolution) === 640) resolutionInput.value = "1024";
    else if ([512, 640, 768, 896, 1024].includes(Number(saved.resolution))) resolutionInput.value = String(saved.resolution);
    if (typeof saved.upscale === "boolean") upscale = saved.upscale;
  } catch (_) {}
  stepsValue.value = stepsInput.value;
  stepsValue.textContent = stepsInput.value;
  upscaleButton.setAttribute("aria-pressed", String(upscale));
}

async function request(path, body) {
  const headers = body === undefined ? {} : {"Content-Type": "application/json"};
  if (sessionToken) headers["X-Restyle-Session"] = sessionToken;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), path === "/start" ? 600000 : 30000);
  try {
    const response = await fetch(path, {method: body === undefined ? "GET" : "POST", headers,
      body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store", signal: controller.signal});
    const raw = await response.text();
    let result = {};
    try { result = JSON.parse(raw); } catch (_) {}
    if (!response.ok) {
      const failure = new Error(result.error || raw || "Request failed (" + response.status + ").");
      failure.status = response.status; failure.data = result;
      throw failure;
    }
    return result;
  } finally { clearTimeout(timer); }
}
async function claimSession() {
  try { sessionToken = (await request("/session", {})).token; }
  catch (error) {
    if (error.status !== 409 || !sessionToken) throw error;
    sessionToken = ""; runtimeLoaded = false;
    sessionToken = (await request("/session", {})).token;
  }
}

async function startRuntime() {
  let result;
  try {
    result = await request("/start", { settings: readSettings(), allow_low_vram: false });
  } catch (error) {
    if (error.status === 409 && error.data && error.data.low_vram) {
      const free = Number(error.data.free_vram_gb) || 0;
      const total = Number(error.data.total_vram_gb) || 0;
      const proceed = window.confirm(`Low VRAM: ${free.toFixed(1)} GB free of ${total.toFixed(1)} GB. Start anyway? This does not enable a low-memory mode.`);
      if (!proceed) throw new Error("Start cancelled.");
      result = await request("/start", { settings: readSettings(), allow_low_vram: true });
    } else {
      throw error;
    }
  }
  if (!result.ok) throw new Error("Could not start the local runtime.");
  runtimeLoaded = true;
}

function applyCameraMirror(track) {
  const settings = track && track.getSettings ? track.getSettings() : {};
  let facing = settings.facingMode;
  if (facing !== "user" && facing !== "environment") {
    const label = cameraInput.selectedOptions?.[0]?.textContent?.toLowerCase() || "";
    if (/\b(front|selfie|user)\b/.test(label)) facing = "user";
    else if (/\b(back|rear|environment)\b/.test(label)) facing = "environment";
  }
  if (facing === "user") setMirror(true);
  else if (facing === "environment") setMirror(false);
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

function updateFlashVisibility(track) {
  let available = false;
  try { available = Boolean(track && track.getCapabilities && track.getCapabilities().torch); } catch (_) {}
  flashButton.hidden = !available;
  if (!available) flashButton.setAttribute("aria-pressed", "false");
}

function setMirror(value) {
  mirror = Boolean(value);
  output.classList.toggle("mirrored", mirror);
  localOutput.classList.toggle("mirrored", mirror);
  mirrorButton.setAttribute("aria-pressed", String(mirror));
}

async function startPeer() {
  peer = new RTCPeerConnection({ iceServers: [] });
  const active = peer;
  peer.addEventListener("track", event => {
    if (peer !== active || event.track.kind !== "video") return;
    localOutput.hidden = true;
    output.classList.remove("camera-source");
    output.hidden = false;
    output.srcObject = event.streams[0] || new MediaStream([event.track]);
    output.play().catch(() => {});
  });
  peer.addEventListener("connectionstatechange", () => {
    if (!started || peer !== active) return;
    if (["failed", "closed"].includes(active.connectionState)) {
      showError("Camera connection failed. Resume to reconnect.", "camera");
      void pause(true);
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
  await active.setRemoteDescription({ sdp: answer.sdp, type: answer.type });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("Camera connection timed out.")), 18000);
    function finish(error) {
      clearTimeout(timeout);
      active.removeEventListener("connectionstatechange", check);
      if (error) reject(error); else resolve();
    }
    function check() {
      if (peer !== active || ["failed", "closed"].includes(active.connectionState)) finish(new Error("Camera connection failed."));
      else if (active.connectionState === "connected") finish();
    }
    active.addEventListener("connectionstatechange", check);
    check();
  });
}

function openLocalStream() {
  const url = new URL("/local-stream", window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url, ["restyle." + sessionToken]);
  socket.binaryType = "blob";
  localSocket = socket;
  socket.addEventListener("message", event => void handleLocalMessage(event, socket));
  socket.addEventListener("close", async () => {
    if (localSocket !== socket) return;
    localSocket = null;
    if (started) {
      try {
        const result = await request("/health");
        if (!result.loaded) {
          runtimeLoaded = false;
          clearInterval(heartbeatTimer);
          heartbeatTimer = 0;
          clearCameraSession();
          startButton.textContent = "Start";
          showError("The model stopped. Press Start to retry.", "camera");
          return;
        }
      } catch (_) {}
      showError("Camera connection closed. Resume to reconnect.", "camera");
      void pause(true);
    }
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error("Local camera connection timed out.")); }, 10000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    const fail = () => { clearTimeout(timer); reject(new Error("Local camera connection failed.")); };
    socket.addEventListener("error", fail, { once: true });
    socket.addEventListener("close", fail, { once: true });
  });
}

async function handleLocalMessage(event, sourceSocket) {
  if (sourceSocket !== localSocket) return;
  clearTimeout(localFrameDeadline);
  localFrameDeadline = 0;
  if (typeof event.data === "string") {
    try {
      const result = JSON.parse(event.data);
      if (result.error) { showError(result.error, "camera"); if (started) void pause(true); }
    } catch (_) {}
    localFramePending = false;
    return;
  }
  try {
    const bitmap = await createImageBitmap(event.data);
    if (sourceSocket !== localSocket || !started) { bitmap.close(); return; }
    localOutput.width = bitmap.width; localOutput.height = bitmap.height;
    localContext.drawImage(bitmap, 0, 0);
    bitmap.close();
    localRoundTripMs = performance.now() - localFrameSentAt;
    localOutput.hidden = false; output.hidden = false; output.classList.add("camera-source");
    showStartup("");
    latency.hidden = false; localFrameFailures = 0;
    showError("", "camera");
    void updateMetrics();
  } catch (error) {
    if (sourceSocket === localSocket) retryFrame(error);
    return;
  } finally { if (sourceSocket === localSocket) localFramePending = false; }
  if (sourceSocket === localSocket) scheduleLocalFrame();
}
function scheduleLocalFrame(delay = 8) {
  if (localFrameTimer || !started || document.visibilityState !== "visible") return;
  localFrameTimer = setTimeout(() => { localFrameTimer = 0; void sendLocalFrame(); }, delay);
}
function retryFrame(error) {
  localFramePending = false;
  localFrameFailures += 1;
  showError(error.message, "camera");
  if (localFrameFailures >= 3) void pause(true);
  else scheduleLocalFrame(250 * localFrameFailures);
}
async function sendLocalFrame() {
  const socket = localSocket;
  const track = stream && stream.getVideoTracks()[0];
  if (!started || !socket || socket.readyState !== WebSocket.OPEN || localFramePending || !track || document.visibilityState !== "visible") return;
  if (output.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) { scheduleLocalFrame(50); return; }
  const current = generation;
  localFramePending = true;
  try {
    const captureTime = performance.now();
    const image = await encodeCameraFrame(output, localInputCanvas, localInputContext, Number(resolutionInput.value));
    if (socket !== localSocket || current !== generation || !started) return;
    if (socket.readyState !== WebSocket.OPEN) throw new Error("Camera connection closed.");
    localFrameSentAt = captureTime;
    socket.send(image);
    localFrameDeadline = setTimeout(() => {
      if (socket !== localSocket || !started) return;
      showError("Frame processing timed out. Resume to reconnect.", "camera");
      void pause(true);
    }, 30000);
  } catch (error) { if (socket === localSocket && current === generation) retryFrame(error); }
}

async function sendRotation() {
  if (!runtimeLoaded) return;
  try {
    await request("/settings", { settings: { rotation: currentRotation() } });
  } catch (error) {
    showError(error.message);
  }
}

async function applySettings() {
  saveSettings();
  if (!runtimeLoaded) return Promise.resolve();
  const settings = readSettings();
  const token = sessionToken;
  settingsApplyQueue = settingsApplyQueue.catch(() => {}).then(async () => {
    if (!runtimeLoaded || token !== sessionToken) return;
    try {
      await request("/settings", { settings });
      if (token === sessionToken) showError("", "settings");
    } catch (error) {
      if (token === sessionToken) showError(error.message, "settings");
    }
  });
  return settingsApplyQueue;
}

function schedulePromptApply() {
  saveSettings();
  clearTimeout(promptApplyTimer);
  promptApplyTimer = setTimeout(() => {
    promptApplyTimer = 0;
    void applySettings();
  }, 3000);
}

async function start() {
  if (busy || started) return;
  busy = true;
  clearErrors();
  clearTimeout(promptApplyTimer);
  promptApplyTimer = 0;
  showStartup("Opening camera");
  startButton.disabled = true;
  quitModelButton.disabled = true;
  cameraInput.disabled = true;
  localRoundTripMs = 0;
  try {
    stream = await cameraStream(cameraInput.value);
    const cameraTrack = stream.getVideoTracks()[0];
    if (!cameraTrack) throw new Error("The selected camera returned no video.");
    output.srcObject = stream;
    output.hidden = false;
    output.classList.add("camera-source");
    localOutput.hidden = true;
    await output.play().catch(() => {});
    await populateCameras(cameraTrack.getSettings?.().deviceId || "");
    updateFlashVisibility(cameraTrack);
    applyCameraMirror(cameraTrack);
    showStartup("Checking connection");
    const connection = await request("/transport");
    transportMode = connection.mode;
    await claimSession();
    showStartup("Loading");
    await startRuntime();
    if (!heartbeatTimer) heartbeatTimer = setInterval(() => void heartbeat(), 10000);
    if (!(await heartbeat())) throw new Error("The model stopped during startup. Press Start to retry.");
    await request("/settings", { settings: readSettings() });
    showStartup("Connecting");
    if (transportMode === "local") await openLocalStream();
    else await startPeer();
    started = true;
    startButton.textContent = "Pause";
    latency.hidden = false;
    showStartup(transportMode === "local" ? "Generating first frame" : "");
    metricsTimer = setInterval(() => void updateMetrics(), 1000);
    if (transportMode === "local") scheduleLocalFrame();
    await updateMetrics();
  } catch (error) {
    clearCameraSession();
    if (sessionToken && runtimeLoaded) {
      try { await request("/pause", {}); } catch (_) {}
    }
    if (!runtimeLoaded) {
      clearInterval(heartbeatTimer); heartbeatTimer = 0;
    }
    startButton.textContent = runtimeLoaded ? "Resume" : "Start";
    if (error.message !== "Start cancelled.") showError(error.message);
  } finally {
    busy = false;
    startButton.disabled = false;
    quitModelButton.disabled = false;
    cameraInput.disabled = false;
  }
}

function clearCameraSession() {
  cameraSwitchSequence += 1;
  const currentPeer = peer;
  const currentStream = stream;
  peer = null;
  stream = null;
  generation += 1;
  clearTimeout(localFrameDeadline);
  localFrameDeadline = 0;
  localFrameFailures = 0;
  previousStats = null;
  jitterMs = 0;
  decodeMs = 0;
  started = false;
  clearInterval(metricsTimer);
  clearTimeout(localFrameTimer);
  metricsTimer = 0;
  localFrameTimer = 0;
  localFramePending = false;
  localRoundTripMs = 0;
  if (localSocket) {
    const socket = localSocket;
    localSocket = null;
    try { socket.close(); } catch (_) {}
  }
  if (currentPeer) {
    try { currentPeer.close(); } catch (_) {}
  }
  if (currentStream) {
    for (const track of currentStream.getTracks()) {
      try { track.stop(); } catch (_) {}
    }
  }
  output.srcObject = null;
  output.classList.remove("camera-source");
  output.hidden = false;
  localOutput.hidden = true;
  latency.hidden = true;
  showStartup("");
  updateFlashVisibility(null);
  flashButton.setAttribute("aria-pressed", "false");
}

async function pause(preserveError = false) {
  if (busy || !started) return;
  busy = true;
  startButton.disabled = true;
  quitModelButton.disabled = true;
  clearCameraSession();
  try {
    const result = await request("/pause", {});
    showError("", "pause");
    runtimeLoaded = Boolean(result.loaded);
    if (!runtimeLoaded) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = 0;
    }
  } catch (error) {
    showError(error.message, "pause");
  }
  startButton.textContent = runtimeLoaded ? "Resume" : "Start";
  startButton.disabled = false;
  quitModelButton.disabled = false;
  busy = false;
}

async function stop(preserveError = false, sendRequest = true) {
  if (busy) return;
  busy = true;
  startButton.disabled = true;
  clearTimeout(promptApplyTimer);
  promptApplyTimer = 0;
  clearCameraSession();
  clearInterval(heartbeatTimer);
  heartbeatTimer = 0;
  let failure = "";
  if (sendRequest && sessionToken) {
    try {
      await request("/stop", {});
      runtimeLoaded = false;
      sessionToken = "";
    } catch (error) {
      failure = error.message;
      if (error.status === 409) { runtimeLoaded = false; sessionToken = ""; }
      else if (runtimeLoaded && !heartbeatTimer) heartbeatTimer = setInterval(() => void heartbeat(), 10000);
    }
  } else {
    runtimeLoaded = false;
  }
  startButton.textContent = runtimeLoaded ? "Resume" : "Start";
  if (!preserveError) { if (!failure) clearErrors(); else showError(failure); }
  busy = false;
  startButton.disabled = false;
}

async function heartbeat() {
  if (!runtimeLoaded || !sessionToken || document.visibilityState !== "visible") return true;
  if (heartbeatPending) return true;
  heartbeatPending = true;
  const token = sessionToken;
  try {
    const result = await request("/heartbeat", {});
    if (token !== sessionToken) return false;
    showError("", "heartbeat");
    if (!result.loaded) {
      runtimeLoaded = false;
      clearInterval(heartbeatTimer); heartbeatTimer = 0;
      if (started) { clearCameraSession(); showError("The model unloaded after inactivity.", "heartbeat"); }
      startButton.textContent = "Start";
      return false;
    }
    return true;
  } catch (error) {
    if (token !== sessionToken) return false;
    if (error.status === 409) {
      runtimeLoaded = false; sessionToken = "";
      clearInterval(heartbeatTimer); heartbeatTimer = 0;
      clearCameraSession(); startButton.textContent = "Start";
    }
    showError(error.message, "heartbeat");
    return false;
  } finally { heartbeatPending = false; }
}

async function updateMetrics() {
  if (!started || metricsPending || document.visibilityState !== "visible") return;
  metricsPending = true;
  const current = generation;
  try {
    const metrics = await request("/metrics");
    if (!started || current !== generation) return;
    showError(metrics.error || "", "model");
    showError("", "metrics");
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
    const clientMs = transportMode === "local" ? localRoundTripMs : totalMs + roundTrip + jitterMs + decodeMs;
    if (!started || current !== generation) return;
    latency.textContent = "Model " + Math.round(modelMs) + " ms · " + (transportMode === "local" ? "Frame round trip " : "Estimated latency ") + Math.round(clientMs) + " ms";
  } catch (error) { if (current === generation) showError(error.message, "metrics"); }
  finally { metricsPending = false; }
}

async function switchCamera(deviceId, sequence) {
  if (!deviceId || !stream || !started) return;
  const previous = stream;
  const previousTrack = previous.getVideoTracks()[0];
  if (!previousTrack) {
    showError("The current camera is unavailable.");
    return;
  }
  if (previousTrack.getSettings?.().deviceId === deviceId) return;
  const activePeer = peer;
  let next = null;
  try {
    next = await cameraStream(deviceId);
    const nextTrack = next.getVideoTracks()[0];
    if (!nextTrack) throw new Error("The selected camera returned no video.");
    if (sequence !== cameraSwitchSequence || !started || stream !== previous) {
      for (const track of next.getTracks()) track.stop();
      return;
    }
    if (activePeer) {
      const sender = activePeer.getSenders().find(item => item.track && item.track.kind === "video");
      if (!sender) throw new Error("The camera connection is unavailable.");
      await sender.replaceTrack(nextTrack);
      if (sequence !== cameraSwitchSequence || !started || stream !== previous || peer !== activePeer) {
        for (const track of next.getTracks()) track.stop();
        return;
      }
    }
    stream = next;
    updateFlashVisibility(nextTrack);
    applyCameraMirror(nextTrack);
    if (transportMode === "local") {
      output.srcObject = next;
      output.hidden = false;
      output.classList.add("camera-source");
      output.play().catch(() => {});
    }
    if (previous) for (const track of previous.getTracks()) track.stop();
    if (transportMode === "local") scheduleLocalFrame();
    showError("");
  } catch (error) {
    if (next) for (const track of next.getTracks()) track.stop();
    if (sequence !== cameraSwitchSequence) return;
    const previousId = previousTrack.getSettings?.().deviceId;
    if (previousId && [...cameraInput.options].some(option => option.value === previousId)) cameraInput.value = previousId;
    showError(error.message || "Could not switch camera.");
  }
}

function queueCameraSwitch(deviceId) {
  const sequence = ++cameraSwitchSequence;
  cameraSwitchQueue = cameraSwitchQueue.catch(() => {}).then(() => switchCamera(deviceId, sequence));
}

async function toggleFlash() {
  if (!stream) return;
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

settingsButton.addEventListener("click", () => setPanel(settingsPanel.hidden));
$("closeSettingsButton").addEventListener("click", () => setPanel(false));
startButton.addEventListener("click", () => started ? void pause() : void start());
clearPromptButton.addEventListener("click", () => {
  promptInput.value = "";
  promptInput.dispatchEvent(new Event("input", { bubbles: true }));
  promptInput.focus();
});
quitModelButton.addEventListener("click", async () => {
  quitModelButton.disabled = true;
  await stop();
  setPanel(false);
  quitModelButton.disabled = false;
});
flashButton.addEventListener("click", () => void toggleFlash());
mirrorButton.addEventListener("click", () => setMirror(!mirror));
upscaleButton.addEventListener("click", () => {
  upscale = !upscale;
  upscaleButton.setAttribute("aria-pressed", String(upscale));
  void applySettings();
});
stepsInput.addEventListener("input", () => {
  stepsValue.value = stepsInput.value;
  stepsValue.textContent = stepsInput.value;
  saveSettings();
});
stepsInput.addEventListener("change", () => void applySettings());
resolutionInput.addEventListener("change", () => void applySettings());
promptInput.addEventListener("input", schedulePromptApply);
cameraInput.addEventListener("change", () => queueCameraSwitch(cameraInput.value));
for (const eventName of ["orientationchange", "resize"]) {
  window.addEventListener(eventName, () => {
    if (runtimeLoaded) void sendRotation();
  });
}
if (screen.orientation) screen.orientation.addEventListener("change", () => {
  if (runtimeLoaded) void sendRotation();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && runtimeLoaded) {
    void heartbeat();
    if (started && transportMode === "local") scheduleLocalFrame();
  }
});

// New tabs must claim their own controller lease.
restoreSettings();

