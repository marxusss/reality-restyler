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
let sessionId = "";
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
let localFrameTimer = 0;
let localFrameSentAt = 0;
let localRoundTripMs = 0;
let previousStats = null;
let jitterMs = 0;
let decodeMs = 0;

function showError(message) {
  errorBox.textContent = message || "";
  errorBox.hidden = !message;
}

function showStartup(message) {
  const visible = Boolean(message);
  startupLabel.textContent = message || "";
  startup.hidden = !visible;
  startup.classList.toggle("indeterminate", visible);
  startupProgress.removeAttribute("aria-valuenow");
  startupProgress.setAttribute("aria-valuetext", message || "");
  startupFill.style.width = visible ? "34%" : "0%";
}

function currentRotation() {
  let angle = Number(screen.orientation && screen.orientation.angle);
  if (!Number.isFinite(angle) && Number.isFinite(Number(window.orientation))) angle = Number(window.orientation);
  if (!Number.isFinite(angle)) angle = 0;
  return ((Math.round(angle / 90) * 90) % 360 + 360) % 360;
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
      const free = Number(error.data.free_vram_gb) || 0;
      const total = Number(error.data.total_vram_gb) || 0;
      const proceed = window.confirm(`Low VRAM: ${free.toFixed(1)} GB free of ${total.toFixed(1)} GB. Start anyway?`);
      if (!proceed) throw new Error("Start cancelled.");
      result = await request("/start", { settings: readSettings(), allow_low_vram: true });
    } else {
      throw error;
    }
  }
  if (!result.ok) throw new Error("Could not start the local runtime.");
  runtimeLoaded = true;
}

async function cameraStream(deviceId = "", facingMode = "environment") {
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error("Camera access requires a secure HTTPS page.");
  }
  const camera = {
    width: { ideal: 1920, max: 1920 },
    height: { ideal: 1080, max: 1080 },
    frameRate: { ideal: 30, max: 30 }
  };
  const video = deviceId
    ? { ...camera, deviceId: { exact: deviceId } }
    : { ...camera, facingMode: { ideal: facingMode } };
  try {
    return await navigator.mediaDevices.getUserMedia({ video, audio: false });
  } catch (error) {
    if (["NotAllowedError", "PermissionDeniedError", "SecurityError"].includes(error.name)) {
      throw new Error("Allow camera access in browser settings, then retry.");
    }
    if (["NotFoundError", "DevicesNotFoundError"].includes(error.name)) {
      throw new Error("No camera is available.");
    }
    if (["NotReadableError", "TrackStartError", "AbortError"].includes(error.name) || error.message === "Load failed") {
      throw new Error("The selected camera could not be opened. It may be busy or unavailable.");
    }
    if (error.name === "OverconstrainedError") {
      throw new Error("The selected camera is unavailable. Choose another camera.");
    }
    throw error;
  }
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
  peer.addEventListener("track", event => {
    if (!peer || event.track.kind !== "video") return;
    localOutput.hidden = true;
    output.classList.remove("camera-source");
    output.hidden = false;
    output.srcObject = event.streams[0] || new MediaStream([event.track]);
    output.play().catch(() => {});
  });
  peer.addEventListener("connectionstatechange", () => {
    if (!started || !peer) return;
    if (peer.connectionState === "failed") {
      showError("Camera connection failed.");
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
  sessionId = answer.session_id;
  await peer.setRemoteDescription({ sdp: answer.sdp, type: answer.type });
}

function openLocalStream() {
  const url = new URL("/local-stream", window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url);
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
          showError("");
          return;
        }
      } catch (_) {}
      showError("Camera connection closed.");
      void pause(true);
    }
  });
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("Local camera connection failed.")), { once: true });
  });
}

async function handleLocalMessage(event, sourceSocket) {
  if (sourceSocket !== localSocket) return;
  if (typeof event.data === "string") {
    try {
      const result = JSON.parse(event.data);
      if (result.error) {
        showError(result.error);
        if (started) void pause(true);
      }
    } catch (_) {}
    localFramePending = false;
    return;
  }
  try {
    const bitmap = await createImageBitmap(event.data);
    if (sourceSocket !== localSocket || !started) {
      bitmap.close();
      return;
    }
    localOutput.width = bitmap.width;
    localOutput.height = bitmap.height;
    localContext.drawImage(bitmap, 0, 0);
    bitmap.close();
    localRoundTripMs = performance.now() - localFrameSentAt;
    localOutput.hidden = false;
    output.hidden = false;
    output.classList.add("camera-source");
    latency.hidden = false;
    showError("");
    void updateMetrics();
  } catch (error) {
    showError(error.message);
  } finally {
    localFramePending = false;
    if (started) scheduleLocalFrame();
  }
}

function scheduleLocalFrame() {
  if (localFrameTimer || !started) return;
  localFrameTimer = setTimeout(() => {
    localFrameTimer = 0;
    void sendLocalFrame();
  }, 8);
}

async function sendLocalFrame() {
  const socket = localSocket;
  const track = stream && stream.getVideoTracks()[0];
  if (!started || !socket || socket.readyState !== WebSocket.OPEN || localFramePending || !track || document.visibilityState !== "visible") return;
  if (output.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    scheduleLocalFrame();
    return;
  }
  localFramePending = true;
  try {
    const settings = track.getSettings();
    const width = settings.width || output.videoWidth;
    const height = settings.height || output.videoHeight;
    localInputCanvas.width = width;
    localInputCanvas.height = height;
    localInputContext.drawImage(output, 0, 0, width, height);
    const image = await new Promise(resolve => localInputCanvas.toBlob(resolve, "image/png"));
    if (!image || !localSocket || localSocket.readyState !== WebSocket.OPEN) throw new Error("Could not capture a camera frame.");
    localFrameSentAt = performance.now();
    localSocket.send(await image.arrayBuffer());
  } catch (error) {
    localFramePending = false;
    showError(error.message);
  }
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
  settingsApplyQueue = settingsApplyQueue.catch(() => {}).then(async () => {
    if (!runtimeLoaded) return;
    try {
      await request("/settings", { settings });
      showError("");
    } catch (error) {
      showError(error.message);
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
  const runtimeWasLoaded = runtimeLoaded;
  let loadedDuringStart = false;
  busy = true;
  showError("");
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
    const connection = await request("/transport");
    transportMode = connection.mode;
    showStartup("Loading");
    await startRuntime();
    loadedDuringStart = !runtimeWasLoaded && runtimeLoaded;
    if (!heartbeatTimer) heartbeatTimer = setInterval(() => void heartbeat(), 10000);
    if (!(await heartbeat())) throw new Error("The model stopped during startup. Press Start to retry.");
    await request("/settings", { settings: readSettings() });
    showStartup("Connecting");
    if (transportMode === "local") await openLocalStream();
    else await startPeer();
    started = true;
    startButton.textContent = "Pause";
    latency.hidden = false;
    showStartup("");
    metricsTimer = setInterval(() => void updateMetrics(), 1000);
    if (transportMode === "local") scheduleLocalFrame();
    await updateMetrics();
  } catch (error) {
    if (loadedDuringStart) {
      await stop(true, true);
    } else {
      clearCameraSession();
      if (!runtimeLoaded) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = 0;
      }
      startButton.textContent = runtimeLoaded ? "Resume" : "Start";
    }
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
  sessionId = "";
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
  clearCameraSession();
  try {
    const result = await request("/pause", {});
    runtimeLoaded = Boolean(result.loaded);
    if (!runtimeLoaded) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = 0;
    }
  } catch (error) {
    if (!preserveError) showError(error.message);
  }
  startButton.textContent = runtimeLoaded ? "Resume" : "Start";
  startButton.disabled = false;
  busy = false;
  if (!preserveError) showError("");
}

async function stop(preserveError = false, sendRequest = true) {
  clearTimeout(promptApplyTimer);
  promptApplyTimer = 0;
  clearCameraSession();
  clearInterval(heartbeatTimer);
  heartbeatTimer = 0;
  let failure = "";
  if (sendRequest) {
    try {
      await request("/stop", {});
      runtimeLoaded = false;
    } catch (error) {
      failure = error.message;
    }
  } else {
    runtimeLoaded = false;
  }
  startButton.textContent = runtimeLoaded ? "Resume" : "Start";
  if (!preserveError) showError(failure);
}

async function heartbeat() {
  if (!runtimeLoaded || document.visibilityState !== "visible") return true;
  try {
    const result = await request("/heartbeat", {});
    if (!result.loaded) {
      runtimeLoaded = false;
      clearInterval(heartbeatTimer);
      heartbeatTimer = 0;
      if (started) {
        clearCameraSession();
        showError("The model unloaded after inactivity.");
      }
      startButton.textContent = "Start";
      return false;
    }
    return true;
  } catch (error) {
    showError(error.message);
    return false;
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
    const clientMs = transportMode === "local" ? localRoundTripMs : totalMs + roundTrip + jitterMs + decodeMs;
    latency.textContent = "Model " + Math.round(modelMs) + " ms · End-to-end " + Math.round(clientMs) + " ms";
  } catch (error) {
    showError(error.message);
  }
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
  if (document.visibilityState === "visible" && runtimeLoaded) void heartbeat();
});

async function syncRuntime() {
  try {
    const result = await request("/health");
    if (busy || started) return;
    runtimeLoaded = Boolean(result.loaded);
    if (runtimeLoaded) {
      startButton.textContent = "Resume";
      if (!heartbeatTimer) heartbeatTimer = setInterval(() => void heartbeat(), 10000);
      void heartbeat();
    }
  } catch (_) {}
}

restoreSettings();
void syncRuntime();
