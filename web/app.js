import { cameraFacing, cameraLenses, cameraStream, currentRotation, setCameraZoom } from "./camera.js";
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
    capture.setAvailable(true);
  }
}

function setPlayback(playing = false) {
  const label = playing ? "Pause" : runtimeLoaded ? "Resume" : "Start";
  startButton.classList.toggle("playing", playing);
  startButton.setAttribute("aria-label", label);
  startButton.title = label;
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
function renderLenses(track) {
  const settings = track.getSettings();
  const lenses = cameraLenses(cameraDevices, settings, track.getCapabilities?.()?.zoom);
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
        if (!lens.active) queueCameraSwitch(lens);
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
    .then(devices => devices.filter(device => device.kind === "videoinput"), () => []);
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
      output.requestVideoFrameCallback(() => {
        if (peer === activePeer && output.srcObject === renderedStream) showFirstFrame();
      });
    }
    output.play().catch(() => {});
  });
  peer.addEventListener("connectionstatechange", () => {
    if (peer !== activePeer) return;
    clearTimeout(disconnectTimer);
    if (["failed", "closed", "disconnected"].includes(activePeer.connectionState)) {
      disconnectTimer = setTimeout(() => {
        if (peer !== activePeer || !started || busy || activePeer.connectionState === "connected") return;
        showError("Camera connection lost. Resume to reconnect.", "camera");
        void pause(true);
      }, activePeer.connectionState === "disconnected" ? 3000 : 0);
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

function openLocalStream() {
  const url = new URL("/local-stream", window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url, ["restyle." + sessionToken]);
  socket.binaryType = "blob";
  localSocket = socket;
  socket.addEventListener("message", event => void handleLocalMessage(event, socket));
  socket.addEventListener("close", () => {
    if (localSocket !== socket || !started) return;
    showError("Camera connection closed. Resume to reconnect.", "camera");
    void pause(true);
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error("Local connection timed out.")); }, 10000);
    const failed = () => { clearTimeout(timer); reject(new Error("Local camera connection failed.")); };
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", failed, { once: true });
    socket.addEventListener("close", failed, { once: true });
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
    showFirstFrame();
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
  if (!started || document.visibilityState !== "visible" || localFramePending || localFrameTimer) return;
  localFrameTimer = setTimeout(() => {
    localFrameTimer = 0;
    void sendLocalFrame();
  }, delay);
}

function retryFrame(error) {
  localFramePending = false;
  localFailures += 1;
  showError(error.message, "camera");
  if (localFailures >= 3) void pause(true);
  else scheduleLocalFrame(250 * localFailures);
}

async function sendLocalFrame() {
  const socket = localSocket;
  const track = stream && stream.getVideoTracks()[0];
  if (!started || !socket || socket.readyState !== WebSocket.OPEN || localFramePending || !track || document.visibilityState !== "visible") return;
  if (output.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) { scheduleLocalFrame(50); return; }
  const current = generation;
  localFramePending = true;
  try {
    localFrameSentAt = performance.now();
    const frame = await encodeCameraFrame(output, localInputCanvas, localInputContext, Number(resolutionInput.value));
    if (!started || localSocket !== socket || current !== generation) return;
    if (socket.readyState !== WebSocket.OPEN) throw new Error("Camera connection closed.");
    localCaptureMs = frame.captureMs;
    localEncodeMs = frame.encodeMs;
    socket.send(frame.data);
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
    sessionToken = (await request("/session", {})).token;
    runtimeLoaded = Boolean((await request("/health")).loaded);
    if (runtimeLoaded && !heartbeatTimer) heartbeatTimer = setInterval(() => void heartbeat(), 10000);
    const requestedCamera = selectedCamera;
    try {
      stream = await cameraStream(requestedCamera?.deviceId, requestedCamera?.facing || "environment");
    } catch (error) {
      if (!requestedCamera?.deviceId || !/unavailable/.test(error.message)) throw error;
      stream = await cameraStream("", requestedCamera.facing || "environment");
    }
    const cameraTrack = stream.getVideoTracks()[0];
    if (!cameraTrack) throw new Error("The selected camera returned no video.");
    output.srcObject = stream;
    output.hidden = false;
    output.classList.add("camera-source");
    localOutput.hidden = true;
    await output.play().catch(() => {});
    if (requestedCamera?.zoom !== undefined && cameraTrack.getSettings().deviceId === requestedCamera.deviceId) {
      try { await setCameraZoom(cameraTrack, requestedCamera.zoom); }
      catch (error) { showError(error.message, "camera-switch"); }
    }
    await populateCameras(cameraTrack);
    updateFlashVisibility(cameraTrack);
    applyCameraMirror(cameraTrack, selectedCamera);
    const connection = await request("/transport");
    transportMode = connection.mode;
    await startRuntime();
    if (!heartbeatTimer) heartbeatTimer = setInterval(() => void heartbeat(), 10000);
    if (!(await heartbeat())) throw new Error("The model stopped during startup. Press Start to retry.");
    await request("/settings", { settings: readSettings() });
    showStartup("Connecting camera", 6);
    if (transportMode === "local") await openLocalStream();
    else await startPeer();
    started = true;
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

function clearCameraSession() {
  capture.setAvailable(false);
  cameraSwitchSequence += 1;
  const currentPeer = peer;
  const currentStream = stream;
  peer = null;
  stream = null;
  generation += 1;
  clearTimeout(disconnectTimer);
  clearTimeout(localFrameDeadline);
  localFrameDeadline = 0;
  localFailures = 0;
  previousStats = null;
  jitterMs = 0;
  decodeMs = 0;
  started = false;
  firstFrameReceived = false;
  clearInterval(metricsTimer);
  clearTimeout(localFrameTimer);
  metricsTimer = 0;
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
  busy = true; startButton.disabled = true; quitModelButton.disabled = true;
  clearCameraSession();
  try {
    const result = await request("/pause", {});
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
  busy = true; startButton.disabled = true;
  clearTimeout(promptApplyTimer); promptApplyTimer = 0;
  clearCameraSession();
  try {
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

async function switchCamera(lens, sequence) {
  if (sequence !== cameraSwitchSequence || !stream || !started) return;
  const previous = stream;
  const previousTrack = previous.getVideoTracks()[0];
  if (!previousTrack) {
    showError("The current camera is unavailable.", "camera-switch");
    return;
  }
  const activePeer = peer;
  let next = null;
  try {
    if (previousTrack.getSettings().deviceId === lens.deviceId) {
      await setCameraZoom(previousTrack, lens.zoom);
      if (started && stream === previous) renderLenses(previousTrack);
      showError("", "camera-switch");
      return;
    }
    next = await cameraStream(lens.deviceId, lens.facing || "environment");
    const nextTrack = next.getVideoTracks()[0];
    if (!nextTrack) throw new Error("The selected camera returned no video.");
    await setCameraZoom(nextTrack, lens.zoom);
    if (sequence !== cameraSwitchSequence || !started || stream !== previous) {
      for (const track of next.getTracks()) track.stop();
      return;
    }
    if (activePeer) {
      const sender = activePeer.getSenders().find(item => item.track && item.track.kind === "video");
      if (!sender) throw new Error("The camera connection is unavailable.");
      await sender.replaceTrack(nextTrack);
      if (!started || stream !== previous || peer !== activePeer) {
        for (const track of next.getTracks()) track.stop();
        return;
      }
    }
    stream = next;
    flashButton.setAttribute("aria-pressed", "false");
    updateFlashVisibility(nextTrack);
    renderLenses(nextTrack);
    applyCameraMirror(nextTrack, lens);
    if (transportMode === "local") {
      output.srcObject = next;
      output.hidden = false;
      output.classList.add("camera-source");
      output.play().catch(() => {});
    }
    if (previous) for (const track of previous.getTracks()) track.stop();
    if (transportMode === "local") scheduleLocalFrame();
    showError("", "camera-switch");
  } catch (error) {
    if (next) for (const track of next.getTracks()) track.stop();
    if (sequence !== cameraSwitchSequence) return;
    showError(error.message || "Could not switch camera.", "camera-switch");
  }
}

function queueCameraSwitch(lens) {
  const sequence = ++cameraSwitchSequence;
  cameraSwitchQueue = cameraSwitchQueue.catch(() => {}).then(() => switchCamera(lens, sequence));
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
  output.addEventListener("loadeddata", () => {
    if (peer && !output.classList.contains("camera-source")) showFirstFrame();
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
    return;
  }
  if (!runtimeLoaded) return;
  await heartbeat();
  if (runtimeLoaded && transportMode === "local") scheduleLocalFrame();
});

// A passive page never acquires or extends ownership of another camera.
restoreSettings();

