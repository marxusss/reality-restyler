import { cameraFacing, cameraLenses, currentRotation, openStartingCamera, setCameraZoom } from "./camera.js";
import { mountCapture } from "./capture.js";
import { encodeCameraFrame } from "./transport.js";
import { mountStyles } from "./styles.js";
import { ErrorState } from "./errors.js";

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
const latency = $("latency");
const promptInput = $("promptInput");
const stepsInput = $("stepsInput");
const stepsValue = $("stepsValue");
const resolutionInput = $("resolutionInput");
const lensBar = $("lensBar");
const upscaleButton = $("upscaleButton");
const flashButton = $("flashButton");
const mirrorButton = $("mirrorButton");
let peer = null;
let stream = null;
let localSocket = null;
let sessionToken = "";
let generation = 0;
let localFrameDeadline = 0;
let localFailures = 0;
let metricsPending = false;
let heartbeatPending = false;
let disconnectTimer = 0;
let cameraWatch = null;
let muteTimer = 0;
let cameraSwitchErrorTimer = 0;
let presentationCallback = 0;
let lastPresentation = 0;
let visibleSince = 0;
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
let cameraChanging = false;
let recoveryAttempts = 0;
let transportRequest = null;
let selectedCamera = null;
let localFramePending = false;
let localFrameTimer = 0;
let localFrameSentAt = 0;
let localRoundTripMs = 0;
let localCaptureMs = 0;
let localEncodeMs = 0;
let localImageDecodeMs = 0;
let localDrawMs = 0;
let localFrameTimingSamples = [];
let previousStats = null;
let jitterMs = 0;
let decodeMs = 0;
let firstFrameReceived = false;
const cameraFrameTimeout = 15000;
const modelStartupStages = {
  checking: ["Checking model files and GPU", 1],
  text_encoder: ["Loading text encoder", 2],
  model: ["Loading model weights", 3],
  pipeline: ["Assembling the model", 4],
  gpu: ["Preparing the model on the GPU", 5]
};

const errors = new ErrorState();
function positionError() {
  if (errorBox.hidden) {
    errorBox.style.removeProperty("position");
    errorBox.style.removeProperty("top");
    errorBox.style.removeProperty("bottom");
    return;
  }
  const dialogs = document.querySelectorAll("dialog[open]");
  const obstacle = dialogs.length ? dialogs[dialogs.length - 1] : settingsPanel.hidden ? null : settingsPanel;
  if (!obstacle) {
    errorBox.style.removeProperty("position");
    errorBox.style.removeProperty("top");
    errorBox.style.removeProperty("bottom");
    return;
  }
  const obstacleTop = obstacle.getBoundingClientRect().top;
  const errorHeight = errorBox.getBoundingClientRect().height;
  errorBox.style.position = "fixed";
  errorBox.style.top = `${Math.max(8, obstacleTop - errorHeight - 12)}px`;
  errorBox.style.bottom = "auto";
}

function scheduleErrorPosition() {
  requestAnimationFrame(() => {
    positionError();
    setTimeout(positionError, 80);
  });
}

function showError(message, source = "action") {
  const text = errors.set(message, source);
  errorBox.textContent = text;
  errorBox.hidden = !text;
  scheduleErrorPosition();
}
function clearErrors() { errors.clear(); showError(""); }

const errorLayoutObserver = new MutationObserver(scheduleErrorPosition);
for (const element of [settingsPanel, ...document.querySelectorAll("dialog")]) {
  errorLayoutObserver.observe(element, { attributes: true, attributeFilter: ["hidden", "open"] });
}
window.addEventListener("resize", scheduleErrorPosition);
window.visualViewport?.addEventListener("resize", scheduleErrorPosition);

const viewport = window.visualViewport;
const touchScreen = window.matchMedia("(any-pointer: coarse)");
const textFields = "textarea, input[type='text']";

function updateKeyboardLayout() {
  const editing = touchScreen.matches && document.activeElement?.matches(textFields);
  document.body.classList.toggle("text-entry", editing);
  if (editing && viewport) {
    document.body.style.setProperty("--keyboard-top", `${viewport.offsetTop}px`);
    document.body.style.setProperty("--keyboard-height", `${viewport.height}px`);
  }
}

function dismissKeyboard() {
  if (document.activeElement?.matches(textFields)) document.activeElement.blur();
}

document.addEventListener("focusin", updateKeyboardLayout);
document.addEventListener("focusout", () => requestAnimationFrame(updateKeyboardLayout));
viewport?.addEventListener("resize", updateKeyboardLayout);
viewport?.addEventListener("scroll", updateKeyboardLayout);
for (const button of document.querySelectorAll(".keyboard-done")) {
  button.addEventListener("click", dismissKeyboard);
}
for (const name of ["gesturestart", "gesturechange"]) {
  document.addEventListener(name, event => event.preventDefault(), { passive: false });
}
document.addEventListener("wheel", event => {
  if (event.ctrlKey) event.preventDefault();
}, { passive: false });

function showStartup(message, completed = 0) {
  if (startupLabel.textContent !== message) startupLabel.textContent = message;
  startup.hidden = !message;
  startupProgress.value = completed;
}

function showFirstFrame() {
  if (firstFrameReceived) return;
  firstFrameReceived = true;
  if (started) {
    showStartup("");
    latency.hidden = false;
    capture.setAvailable(true);
  }
}

function setPlayback(playing = false) {
  const label = playing ? "Pause" : runtimeLoaded ? "Resume" : "Start";
  startButton.classList.toggle("playing", playing);
  startButton.setAttribute("aria-label", label);
  startButton.title = label;
}

function cameraLost(message) {
  if (!started || busy || cameraChanging || document.hidden) return;
  const current = generation;
  cameraChanging = true;
  cameraSwitchQueue = cameraSwitchQueue.catch(() => {}).then(() => recoverCamera(current, message));
}

function showCameraSwitchError(message = "") {
  clearTimeout(cameraSwitchErrorTimer);
  showError(message, "camera-switch");
  if (message) {
    cameraSwitchErrorTimer = setTimeout(() => showError("", "camera-switch"), 6000);
  }
}

function checkCameraTrack() {
  if (!started || cameraChanging || document.hidden) return;
  const track = stream?.getVideoTracks()[0];
  if (!track || track.readyState === "ended") {
    cameraLost("Camera disconnected.");
  } else if (track.muted && !muteTimer) {
    muteTimer = setTimeout(() => {
      muteTimer = 0;
      if (stream?.getVideoTracks()[0] === track && track.muted) cameraLost("Camera stopped sending video.");
    }, 5000);
  } else if (!track.muted) {
    clearTimeout(muteTimer);
    muteTimer = 0;
  }
}

function watchCameraTrack(track) {
  cameraWatch?.abort();
  clearTimeout(muteTimer);
  muteTimer = 0;
  cameraWatch = new AbortController();
  for (const name of ["ended", "mute", "unmute"]) {
    track.addEventListener(name, checkCameraTrack, {signal: cameraWatch.signal});
  }
  checkCameraTrack();
}

function notePresentation() {
  lastPresentation = performance.now();
  showFirstFrame();
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
    if (Number.isInteger(saved.steps)) stepsInput.value = String(Math.max(1, Math.min(4, saved.steps)));
    if ([512, 640, 768, 896, 1024].includes(Number(saved.resolution))) resolutionInput.value = String(saved.resolution);
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
    const response = await fetch(path, {
      method: body === undefined ? "GET" : "POST", headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store", signal: controller.signal
    });
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

function loseOwnership(message) {
  sessionToken = "";
  runtimeLoaded = false;
  clearInterval(heartbeatTimer); heartbeatTimer = 0;
  clearCameraSession();
  setPlayback();
  showError(message || "Camera control moved to another device. Press Start to take over.", "camera");
}

async function requestRuntimeStart(allowLowVram) {
  const startupId = crypto.randomUUID();
  let complete = false;
  let timer;
  const poll = async () => {
    try {
      const progress = await request("/startup/" + startupId);
      const stage = modelStartupStages[progress.stage];
      if (!complete && stage) showStartup(...stage);
    } catch (_) {
    } finally {
      if (!complete) timer = setTimeout(poll, 350);
    }
  };
  showStartup(...modelStartupStages.checking);
  timer = setTimeout(poll, 200);
  try {
    return await request("/start", { settings: readSettings(), allow_low_vram: allowLowVram, startup_id: startupId });
  } finally {
    complete = true;
    clearTimeout(timer);
  }
}

async function startRuntime() {
  let result;
  try {
    result = await requestRuntimeStart(false);
  } catch (error) {
    if (error.status === 409 && error.data && error.data.low_vram) {
      const free = Number(error.data.free_vram_gb) || 0;
      const total = Number(error.data.total_vram_gb) || 0;
      const proceed = window.confirm(`Low VRAM: ${free.toFixed(1)} GB free of ${total.toFixed(1)} GB. Start anyway? This does not activate a low-memory mode.`);
      if (!proceed) throw new Error("Start cancelled.");
      result = await requestRuntimeStart(true);
    } else {
      throw error;
    }
  }
  if (!result.ok) throw new Error("Could not start the local runtime.");
  runtimeLoaded = true;
}

function applyCameraMirror(track, choice) {
  const settings = track && track.getSettings ? track.getSettings() : {};
  const facing = choice?.facing || settings.facingMode || cameraFacing(track?.label);
  if (facing === "user") setMirror(true);
  else if (facing === "environment") setMirror(false);
}

let cameraDevices = [];
const knownCameraZoom = new Map();
function renderLenses(track) {
  const settings = track.getSettings();
  const zoom = typeof settings.zoom === "number" ? track.getCapabilities?.()?.zoom : null;
  if (settings.deviceId && zoom) knownCameraZoom.set(settings.deviceId, zoom);
  else knownCameraZoom.delete(settings.deviceId);
  const lenses = cameraLenses(cameraDevices, settings, zoom, knownCameraZoom);
  selectedCamera = lenses.find(lens => lens.active) ||
    {deviceId: settings.deviceId, facing: settings.facingMode};
  lensBar.replaceChildren();
  lensBar.hidden = lenses.length <= 1;
  if (lensBar.hidden) return;
  for (const lens of lenses) {
    const button = document.createElement("button");
    button.type = "button";
    const selfie = lens.facing === "user";
    const number = String(lens.magnification).replace(/^0\./, ".");
    button.className = "lens-button";
    button.textContent = `${selfie ? "−" : ""}${number}`;
    button.setAttribute("aria-label", `${selfie ? "Selfie" : "Rear"} ${lens.magnification}×`);
    button.setAttribute("aria-pressed", String(lens.active));
    button.addEventListener("click", () => {
      if (busy) return;
      if (started) {
        if (!lens.active || cameraChanging) queueCameraSwitch(lens);
      } else {
        selectedCamera = lens;
        for (const item of lensBar.children) item.setAttribute("aria-pressed", String(item === button));
      }
    });
    lensBar.append(button);
  }
}

async function populateCameras(track) {
  cameraDevices = await navigator.mediaDevices.enumerateDevices()
    .then(devices => devices.filter(device => device.kind === "videoinput"), () => cameraDevices);
  renderLenses(track);
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
  const activePeer = peer;
  peer.addEventListener("track", event => {
    if (peer !== activePeer || event.track.kind !== "video") return;
    localOutput.hidden = true;
    output.classList.remove("camera-source");
    output.hidden = false;
    const renderedStream = event.streams[0] || new MediaStream([event.track]);
    output.srcObject = renderedStream;
    if (output.requestVideoFrameCallback) {
      if (presentationCallback) output.cancelVideoFrameCallback(presentationCallback);
      const presented = () => {
        if (peer !== activePeer || output.srcObject !== renderedStream) return;
        notePresentation();
        presentationCallback = output.requestVideoFrameCallback(presented);
      };
      presentationCallback = output.requestVideoFrameCallback(presented);
    }
    output.play().catch(() => {});
  });
  peer.addEventListener("connectionstatechange", () => {
    if (peer !== activePeer) return;
    clearTimeout(disconnectTimer);
    if (["failed", "closed", "disconnected"].includes(activePeer.connectionState)) {
      disconnectTimer = setTimeout(() => {
        if (peer !== activePeer || !started || busy || activePeer.connectionState === "connected") return;
        cameraLost("Camera connection lost.");
      }, activePeer.connectionState === "disconnected" ? 3000 : 0);
    }
  });
  for (const track of stream.getTracks()) peer.addTrack(track, stream);
  const offer = await activePeer.createOffer();
  await activePeer.setLocalDescription(offer);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Camera connection timed out.")), 15000);
    function finish(error) {
      clearTimeout(timer);
      activePeer.removeEventListener("icegatheringstatechange", check);
      activePeer.removeEventListener("connectionstatechange", check);
      if (error) reject(error); else resolve();
    }
    function check() {
      if (peer !== activePeer || activePeer.connectionState === "closed") finish(new Error("Camera connection was interrupted."));
      else if (activePeer.iceGatheringState === "complete") finish();
    }
    activePeer.addEventListener("icegatheringstatechange", check);
    activePeer.addEventListener("connectionstatechange", check);
    check();
  });
  if (peer !== activePeer || document.hidden) throw new Error("Camera connection was interrupted.");
  const answer = await trackTransportRequest(request("/offer", {
    sdp: activePeer.localDescription.sdp, type: activePeer.localDescription.type
  }));
  if (peer !== activePeer) throw new Error("Camera connection was interrupted.");
  await activePeer.setRemoteDescription({ sdp: answer.sdp, type: answer.type });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Camera connection timed out.")), 18000);
    function finish(error) {
      clearTimeout(timer);
      activePeer.removeEventListener("connectionstatechange", check);
      if (error) reject(error); else resolve();
    }
    function check() {
      if (peer !== activePeer || ["failed", "closed"].includes(activePeer.connectionState)) finish(new Error("Camera connection failed."));
      else if (activePeer.connectionState === "connected") finish();
    }
    activePeer.addEventListener("connectionstatechange", check);
    check();
  });
}

function trackTransportRequest(pending) {
  transportRequest = pending;
  const clear = () => { if (transportRequest === pending) transportRequest = null; };
  pending.then(clear, clear);
  return pending;
}

async function pauseHostTransport(current = () => true) {
  const token = sessionToken;
  await transportRequest?.catch(() => {});
  if (!token || token !== sessionToken || !current()) return null;
  return request("/pause", {});
}

function openLocalStream() {
  const url = new URL("/local-stream", window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url, ["restyle." + sessionToken]);
  socket.binaryType = "blob";
  localSocket = socket;
  socket.addEventListener("message", event => void handleLocalMessage(event, socket));
  socket.addEventListener("close", () => {
    if (localSocket !== socket || !started) return;
    cameraLost("Camera connection closed.");
  });
  return trackTransportRequest(new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error("Local connection timed out.")); }, 10000);
    const failed = () => { clearTimeout(timer); reject(new Error("Local camera connection failed.")); };
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", failed, { once: true });
    socket.addEventListener("close", failed, { once: true });
  }));
}

async function handleLocalMessage(event, sourceSocket) {
  if (sourceSocket !== localSocket) return;
  clearTimeout(localFrameDeadline);
  localFrameDeadline = 0;
  if (typeof event.data === "string") {
    try {
      const result = JSON.parse(event.data);
      if (result.error) { showError(result.error, "camera"); if (started) void pause(true); }
    } catch (_) { retryFrame(new Error("Invalid camera response.")); }
    localFramePending = false;
    return;
  }
  try {
    const decodeStartedAt = performance.now();
    const bitmap = await createImageBitmap(event.data);
    localImageDecodeMs = performance.now() - decodeStartedAt;
    if (sourceSocket !== localSocket || !started) { bitmap.close(); return; }
    if (localOutput.width !== bitmap.width) localOutput.width = bitmap.width;
    if (localOutput.height !== bitmap.height) localOutput.height = bitmap.height;
    const drawStartedAt = performance.now();
    localContext.drawImage(bitmap, 0, 0);
    localDrawMs = performance.now() - drawStartedAt;
    bitmap.close();
    localRoundTripMs = performance.now() - localFrameSentAt;
    recordLocalFrameTiming();
    localOutput.hidden = false;
    notePresentation();
    output.hidden = false;
    output.classList.add("camera-source");
    latency.hidden = false;
    localFailures = 0;
    showError("", "camera");
  } catch (error) {
    if (sourceSocket === localSocket) retryFrame(error);
    return;
  } finally { if (sourceSocket === localSocket) localFramePending = false; }
  if (sourceSocket === localSocket) scheduleLocalFrame();
}

function recordLocalFrameTiming() {
  localFrameTimingSamples.push({
    capture: localCaptureMs,
    encode: localEncodeMs,
    decode: localImageDecodeMs,
    draw: localDrawMs,
    roundTrip: localRoundTripMs
  });
  if (localFrameTimingSamples.length < 30) return;
  const fields = [];
  for (const name of ["capture", "encode", "decode", "draw", "roundTrip"]) {
    const values = localFrameTimingSamples.map(sample => sample[name]).sort((a, b) => a - b);
    const p95 = values[Math.ceil(values.length * 0.95) - 1];
    fields.push(`${name}_avg_ms=${(values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1)}`);
    fields.push(`${name}_p95_ms=${p95.toFixed(1)}`);
  }
  console.debug(`FRAME_TIMING local frames=${localFrameTimingSamples.length} ${fields.join(" ")}`);
  localFrameTimingSamples = [];
}

function scheduleLocalFrame(delay = 0) {
  if (!started || cameraChanging || document.visibilityState !== "visible" || localFramePending || localFrameTimer) return;
  localFrameTimer = setTimeout(() => {
    localFrameTimer = 0;
    void sendLocalFrame();
  }, delay);
}

function retryFrame(error) {
  localFramePending = false;
  localFailures += 1;
  if (localFailures >= 3) cameraLost(error.message);
  else scheduleLocalFrame(250 * localFailures);
}

async function sendLocalFrame() {
  const socket = localSocket;
  const track = stream && stream.getVideoTracks()[0];
  if (!started || cameraChanging || !socket || socket.readyState !== WebSocket.OPEN || localFramePending || !track || document.visibilityState !== "visible") return;
  if (output.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) { scheduleLocalFrame(50); return; }
  const current = generation;
  localFramePending = true;
  try {
    localFrameSentAt = performance.now();
    const frame = await encodeCameraFrame(output, localInputCanvas, localInputContext, Number(resolutionInput.value));
    if (!started || localSocket !== socket || current !== generation) return;
    if (cameraChanging || track !== stream?.getVideoTracks()[0]) {
      localFramePending = false;
      scheduleLocalFrame();
      return;
    }
    if (socket.readyState !== WebSocket.OPEN) throw new Error("Camera connection closed.");
    localCaptureMs = frame.captureMs;
    localEncodeMs = frame.encodeMs;
    socket.send(frame.data);
    localFrameDeadline = setTimeout(() => {
      if (socket !== localSocket || !started) return;
      cameraLost("Frame processing timed out.");
    }, 30000);
  } catch (error) { if (socket === localSocket && current === generation) retryFrame(error); }
}

async function sendRotation() {
  if (!runtimeLoaded) return;
  try {
    await request("/settings", { settings: { rotation: currentRotation() } });
    showError("", "rotation");
  } catch (error) {
    showError(error.message, "rotation");
  }
}

async function applySettings() {
  saveSettings();
  if (!runtimeLoaded) return Promise.resolve();
  const settings = readSettings();
  const token = sessionToken;
  const pending = settingsApplyQueue.catch(() => {}).then(async () => {
    if (!runtimeLoaded || token !== sessionToken || pending !== settingsApplyQueue) return;
    try {
      await request("/settings", { settings });
      if (token === sessionToken) showError("", "settings");
    } catch (error) {
      if (token === sessionToken) showError(error.message, "settings");
    }
  });
  settingsApplyQueue = pending;
  return pending;
}

function schedulePromptApply() {
  saveSettings();
  clearTimeout(promptApplyTimer);
  promptApplyTimer = setTimeout(() => {
    promptApplyTimer = 0;
    void applySettings();
  }, 2000);
}

function applyPromptNow() {
  clearTimeout(promptApplyTimer);
  promptApplyTimer = 0;
  void applySettings();
}

async function start() {
  if (busy || started) return;
  busy = true;
  recoveryAttempts = 0;
  clearErrors();
  clearTimeout(promptApplyTimer);
  promptApplyTimer = 0;
  showStartup("Opening camera");
  startButton.disabled = true;
  quitModelButton.disabled = true;
  localRoundTripMs = 0;
  localCaptureMs = 0;
  localEncodeMs = 0;
  localImageDecodeMs = 0;
  localDrawMs = 0;
  localFrameTimingSamples = [];
  try {
    const requestedCamera = selectedCamera;
    stream = await openStartingCamera(requestedCamera);
    const cameraTrack = stream.getVideoTracks()[0];
    if (!cameraTrack) throw new Error("The selected camera returned no video.");
    output.srcObject = stream;
    output.hidden = false;
    output.classList.add("camera-source");
    localOutput.hidden = true;
    await output.play().catch(() => {});
    if (requestedCamera?.zoom !== undefined && cameraTrack.getSettings().deviceId === requestedCamera.deviceId) {
      try { await setCameraZoom(cameraTrack, requestedCamera.zoom); }
      catch (error) { showCameraSwitchError(error.message); }
    }
    await populateCameras(cameraTrack);
    updateFlashVisibility(cameraTrack);
    applyCameraMirror(cameraTrack, selectedCamera);
    sessionToken = (await request("/session", {})).token;
    runtimeLoaded = Boolean((await request("/health")).loaded);
    if (runtimeLoaded && !heartbeatTimer) heartbeatTimer = setInterval(() => void heartbeat(), 10000);
    const connection = await request("/transport");
    transportMode = connection.mode;
    await startRuntime();
    if (!heartbeatTimer) heartbeatTimer = setInterval(() => void heartbeat(), 10000);
    if (!(await heartbeat())) throw new Error("The model stopped during startup. Press Start to retry.");
    await request("/settings", { settings: readSettings() });
    showStartup("Connecting camera", 6);
    if (transportMode === "local") await openLocalStream();
    else await startPeer();
    if (cameraTrack.readyState === "ended") throw new Error("Camera disconnected during startup. Try again.");
    started = true;
    visibleSince = performance.now();
    watchCameraTrack(cameraTrack);
    setPlayback(true);
    latency.hidden = false;
    if (firstFrameReceived) {
      showStartup("");
      capture.setAvailable(true);
    }
    else showStartup("Waiting for the first frame", 7);
    metricsTimer = setInterval(() => void updateMetrics(), 1000);
    if (transportMode === "local") scheduleLocalFrame();
    await updateMetrics();
  } catch (error) {
    clearCameraSession();
    if (error.status === 409 && !error.data?.low_vram) loseOwnership(error.message);
    else if (sessionToken && runtimeLoaded) {
      // Release only the camera, never unload a warm model on a connection failure.
      try { await request("/pause", {}); } catch (failure) {
        if (failure.status === 409) loseOwnership(failure.message);
      }
    }
    if (!runtimeLoaded) { clearInterval(heartbeatTimer); heartbeatTimer = 0; }
    setPlayback();
    if (error.message !== "Start cancelled.") showError(error.message);
  } finally {
    busy = false;
    startButton.disabled = false;
    quitModelButton.disabled = false;
  }
}

function releaseCameraInput() {
  cameraWatch?.abort();
  cameraWatch = null;
  clearTimeout(muteTimer);
  muteTimer = 0;
  const previous = stream;
  stream = null;
  if (previous) for (const track of previous.getTracks()) track.stop();
  updateFlashVisibility(null);
}

function closeCameraTransport() {
  capture.setAvailable(false);
  if (presentationCallback) output.cancelVideoFrameCallback(presentationCallback);
  presentationCallback = 0;
  lastPresentation = 0;
  const currentPeer = peer;
  peer = null;
  clearTimeout(disconnectTimer);
  clearTimeout(localFrameDeadline);
  localFrameDeadline = 0;
  localFailures = 0;
  previousStats = null;
  jitterMs = 0;
  decodeMs = 0;
  firstFrameReceived = false;
  clearTimeout(localFrameTimer);
  localFrameTimer = 0;
  localFramePending = false;
  localRoundTripMs = 0;
  localCaptureMs = 0;
  localEncodeMs = 0;
  localImageDecodeMs = 0;
  localDrawMs = 0;
  localFrameTimingSamples = [];
  if (localSocket) {
    const socket = localSocket;
    localSocket = null;
    try { socket.close(); } catch (_) {}
  }
  if (currentPeer) {
    try { currentPeer.close(); } catch (_) {}
  }
  output.srcObject = null;
  output.classList.remove("camera-source");
  output.hidden = false;
  localOutput.hidden = true;
  latency.hidden = true;
}

function clearCameraSession() {
  cameraSwitchSequence += 1;
  generation += 1;
  started = false;
  cameraChanging = false;
  clearInterval(metricsTimer);
  metricsTimer = 0;
  showCameraSwitchError();
  releaseCameraInput();
  closeCameraTransport();
  showStartup("");
}

async function pause(preserveError = false) {
  if (busy || !started) return;
  busy = true; startButton.disabled = true; quitModelButton.disabled = true;
  clearCameraSession();
  try {
    const result = await pauseHostTransport();
    if (!result) return;
    runtimeLoaded = Boolean(result.loaded);
    showError("", "pause");
    if (!preserveError) showError("", "camera");
    if (!runtimeLoaded) { clearInterval(heartbeatTimer); heartbeatTimer = 0; }
  } catch (error) {
    if (error.status === 409) loseOwnership(error.message);
    else showError(error.message, "pause");
  } finally {
    setPlayback();
    startButton.disabled = false; quitModelButton.disabled = false; busy = false;
  }
}

async function stop() {
  if (busy || !sessionToken) return;
  const token = sessionToken;
  busy = true; startButton.disabled = true;
  clearTimeout(promptApplyTimer); promptApplyTimer = 0;
  clearCameraSession();
  try {
    await transportRequest?.catch(() => {});
    if (token !== sessionToken) return;
    await request("/stop", {});
    sessionToken = ""; runtimeLoaded = false;
    clearInterval(heartbeatTimer); heartbeatTimer = 0;
    clearErrors();
  } catch (error) {
    if (error.status === 409) loseOwnership(error.message);
    else showError(error.message, "stop");
  } finally {
    setPlayback();
    startButton.disabled = false; busy = false;
  }
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
      loseOwnership("The model unloaded after inactivity. Press Start.");
      return false;
    }
    return true;
  } catch (error) {
    if (token !== sessionToken) return false;
    if (error.status === 409) loseOwnership(error.message);
    else showError(error.message, "heartbeat");
    return false;
  } finally { heartbeatPending = false; }
}

async function updateMetrics() {
  if (!started || cameraChanging || document.visibilityState !== "visible") return;
  checkCameraTrack();
  if (!started || cameraChanging) return;
  const now = performance.now();
  if (now - Math.max(lastPresentation, visibleSince) > (peer ? cameraFrameTimeout : 30000)) {
    cameraLost(firstFrameReceived ? "Video stopped arriving." : "No video arrived.");
    return;
  }
  if (metricsPending) return;
  metricsPending = true;
  const current = generation;
  const currentPeer = peer;
  const currentSocket = localSocket;
  const sameTransport = () => started && !cameraChanging && current === generation &&
    currentPeer === peer && currentSocket === localSocket;
  try {
    const metrics = await request("/metrics");
    if (!sameTransport()) return;
    if (peer && performance.now() - visibleSince > cameraFrameTimeout && metrics.fresh_frame_age_ms > cameraFrameTimeout) {
      if (metrics.error) {
        showError(metrics.error, "camera");
        void pause(true);
      } else {
        cameraLost("No new restyled frames arrived.");
      }
      return;
    }
    const freshAge = metrics.fresh_frame_age_ms;
    if (now - visibleSince > 5000 && now - lastPresentation < 2500 && firstFrameReceived &&
        !stream?.getVideoTracks()[0]?.muted && (!Number.isFinite(freshAge) || freshAge < 2500)) recoveryAttempts = 0;
    showError(metrics.error || "", "model");
    showError("", "metrics");
    let roundTrip = 0;
    if (currentPeer) {
      const stats = await currentPeer.getStats();
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
    if (!sameTransport()) return;
    latency.textContent = "Model " + Math.round(modelMs) + " ms · " + (transportMode === "local" ? "Frame round trip " : "Estimated latency ") + Math.round(clientMs) + " ms";
  } catch (error) { if (sameTransport()) showError(error.message, "metrics"); }
  finally { metricsPending = false; }
}

function showLocalInput() {
  output.srcObject = stream;
  output.hidden = false;
  output.classList.add("camera-source");
  output.play().catch(() => {});
}

async function restartTransport(current) {
  closeCameraTransport();
  let result;
  try {
    result = await pauseHostTransport(current);
  } catch (error) {
    if (current() && error.status === 409) loseOwnership(error.message);
    throw error;
  }
  if (!current() || !result) return;
  if (!result.loaded) {
    loseOwnership("The model unloaded after inactivity. Press Start.");
    return;
  }
  if (transportMode === "local") {
    showLocalInput();
    await openLocalStream();
  } else {
    await startPeer();
  }
}

async function replaceCamera(lens, current, {reconnect = false, fallback = false} = {}) {
  releaseCameraInput();
  const next = await openStartingCamera(lens, {fallback, current});
  try {
    const track = next.getVideoTracks()[0];
    if (!track || track.readyState === "ended") throw new Error("The selected camera returned no video.");
    if (track.getSettings().deviceId === lens?.deviceId) await setCameraZoom(track, lens?.zoom);
    if (!current()) return;
    if (!reconnect && peer) {
      const sender = peer.getSenders().find(item => item.track?.kind === "video");
      if (!sender || peer.connectionState === "closed" || peer.connectionState === "failed") reconnect = true;
      else {
        try { await sender.replaceTrack(track); }
        catch (_) { reconnect = true; }
      }
    } else if (!reconnect && localSocket?.readyState !== WebSocket.OPEN) {
      reconnect = true;
    }
    if (!current()) return;
    stream = next;
    if (reconnect) await restartTransport(current);
    else if (transportMode === "local") showLocalInput();
    if (!current()) return;
    if (track.readyState === "ended") throw new Error("The selected camera stopped sending video.");
    visibleSince = performance.now();
    flashButton.setAttribute("aria-pressed", "false");
    updateFlashVisibility(track);
    renderLenses(track);
    applyCameraMirror(track, selectedCamera);
    watchCameraTrack(track);
  } catch (error) {
    if (stream === next) releaseCameraInput();
    throw error;
  } finally {
    if (stream !== next || !current()) {
      if (stream === next) releaseCameraInput();
      else for (const track of next.getTracks()) track.stop();
    }
  }
}

async function recoverCamera(epoch, message) {
  const current = () => started && epoch === generation && !document.hidden;
  let failure = message;
  try {
    if (!current()) return;
    capture.setAvailable(false);
    showStartup("Reconnecting camera", 6);
    while (current() && recoveryAttempts < 2) {
      recoveryAttempts += 1;
      try {
        await replaceCamera(selectedCamera, current, {reconnect: true, fallback: true});
        if (current() && stream) {
          showError("", "camera");
          if (!firstFrameReceived) showStartup("Waiting for the first frame", 7);
          else latency.hidden = false;
          return;
        }
      } catch (error) {
        failure = error.message || failure;
      }
    }
    if (current()) {
      showError(`${failure.replace(/\.$/, "")}. Resume to try again.`, "camera");
      void pause(true);
    }
  } finally {
    if (epoch === generation) {
      cameraChanging = false;
      if (transportMode === "local") scheduleLocalFrame();
    }
  }
}

async function switchCamera(lens, sequence, epoch) {
  const current = () => started && epoch === generation && !document.hidden;
  if (sequence !== cameraSwitchSequence || !current() || cameraChanging) return;
  const previous = selectedCamera;
  const track = stream?.getVideoTracks()[0];
  cameraChanging = true;
  try {
    if (track?.readyState === "live" && track.getSettings().deviceId === lens.deviceId) {
      await setCameraZoom(track, lens.zoom);
      if (current()) renderLenses(track);
    } else {
      await replaceCamera(lens, current);
    }
    if (current()) showCameraSwitchError();
  } catch (error) {
    if (!current()) return;
    if (!stream && previous) {
      try { await replaceCamera(previous, current); } catch (_) {}
    }
    if (current()) showCameraSwitchError(error.message || "Could not switch camera.");
  } finally {
    if (epoch === generation) {
      cameraChanging = false;
      if (current() && !stream && sequence === cameraSwitchSequence) cameraLost("Could not reopen the camera.");
      else if (transportMode === "local") scheduleLocalFrame();
    }
  }
}

function queueCameraSwitch(lens) {
  showCameraSwitchError();
  const sequence = ++cameraSwitchSequence;
  const epoch = generation;
  cameraSwitchQueue = cameraSwitchQueue.catch(() => {}).then(() => switchCamera(lens, sequence, epoch));
}

async function toggleFlash() {
  if (!stream) return;
  const track = stream.getVideoTracks()[0];
  const capabilities = track.getCapabilities ? track.getCapabilities() : {};
  if (!capabilities.torch) {
    showError("Flash is unavailable on this camera.", "flash");
    return;
  }
  const enabled = flashButton.getAttribute("aria-pressed") === "true";
  try {
    await track.applyConstraints({ advanced: [{ torch: !enabled }] });
    flashButton.setAttribute("aria-pressed", String(!enabled));
    showError("", "flash");
  } catch (_) {
    showError("Could not change flash.", "flash");
  }
}

function setPanel(open) {
  if (!open && settingsPanel.contains(document.activeElement)) dismissKeyboard();
  settingsPanel.hidden = !open;
  settingsButton.setAttribute("aria-expanded", String(open));
  scheduleErrorPosition();
}

function getRenderedFrame() {
  if (!started || !firstFrameReceived) return null;
  if (!localOutput.hidden) return {frame: localOutput, width: localOutput.width, height: localOutput.height};
  if (peer && !output.hidden && !output.classList.contains("camera-source") &&
      output.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    return {frame: output, width: output.videoWidth, height: output.videoHeight};
  }
  return null;
}

settingsButton.addEventListener("click", () => setPanel(settingsPanel.hidden));
const capture = mountCapture({
  getFrame: getRenderedFrame,
  isMirrored: () => mirror,
  reportError: message => showError(message, "capture")
});
mountStyles({
  promptInput, applyPromptNow, request,
  isMirrored: () => mirror, getRenderedFrame
});
startButton.addEventListener("click", () => started ? void pause() : void start());
clearPromptButton.addEventListener("click", () => {
  promptInput.value = "";
  applyPromptNow();
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
promptInput.addEventListener("keydown", event => {
  if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey ||
      event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  if (!event.repeat) {
    applyPromptNow();
    if (touchScreen.matches) dismissKeyboard();
  }
});
if (!output.requestVideoFrameCallback) {
  output.addEventListener("timeupdate", () => {
    if (peer && !output.classList.contains("camera-source")) notePresentation();
  });
}
for (const eventName of ["orientationchange", "resize"]) {
  window.addEventListener(eventName, () => {
    if (runtimeLoaded) void sendRotation();
  });
}
if (screen.orientation) screen.orientation.addEventListener("change", () => {
  if (runtimeLoaded) void sendRotation();
});
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible") {
    clearTimeout(localFrameTimer);
    localFrameTimer = 0;
    clearTimeout(muteTimer);
    muteTimer = 0;
    return;
  }
  visibleSince = performance.now();
  if (peer && ["failed", "closed"].includes(peer.connectionState)) {
    cameraLost("Camera connection lost.");
    return;
  }
  checkCameraTrack();
  if (!runtimeLoaded) return;
  await heartbeat();
  if (runtimeLoaded && transportMode === "local") scheduleLocalFrame();
});

// A passive page never acquires or extends ownership of another camera.
restoreSettings();

