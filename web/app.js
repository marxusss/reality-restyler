import { cameraFacing, cameraLenses, currentRotation, openStartingCamera, setCameraZoom } from "./camera.js";
import { mountCapture } from "./capture.js";
import { encodeCameraFrame } from "./frame_encoding.js";
import { createLatencyMetrics } from "./metrics.js";
import { openWebRTC, openLocalSocket } from "./transport.js";
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
const cancelStartupButton = $("cancelStartupButton");
let pendingStartupId = "";
const latency = $("latency");
const promptInput = $("promptInput");
const stepsInput = $("stepsInput");
const stepsValue = $("stepsValue");
const resolutionInput = $("resolutionInput");
const lensBar = $("lensBar");
const upscaleButton = $("upscaleButton");
const flashButton = $("flashButton");
const cameraActions = $("cameraActions");
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
let startInProgress = false;
let sessionClaimInProgress = false;
let sessionEpoch = 0;
let visibilityResumePending = false;
let visibilityPauseTask = Promise.resolve();
let runtimeLoaded = false;
let transportMode = "remote";
let mirror = false;
let upscale = true;
let heartbeatTimer = 0;
let metricsTimer = 0;
let promptApplyTimer = 0;
let settingsApplyQueue = Promise.resolve();
let settingsDirty = false;
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
const latencyMetrics = createLatencyMetrics();
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
function clearErrors() {
  errors.clear();
  showError("");
}

const errorLayoutObserver = new MutationObserver(scheduleErrorPosition);
for (const element of [settingsPanel, ...document.querySelectorAll("dialog")]) {
  errorLayoutObserver.observe(element, { attributes: true, attributeFilter: ["hidden", "open"] });
}
window.addEventListener("resize", scheduleErrorPosition);
window.visualViewport?.addEventListener("resize", scheduleErrorPosition);

const viewport = window.visualViewport;
const touchScreen = window.matchMedia("(any-pointer: coarse)");
const textFields = "textarea, input[type='text']";
let lastTextField = null;

function updateKeyboardLayout() {
  const activeTextField = document.activeElement?.matches(textFields) ? document.activeElement : null;
  if (activeTextField) lastTextField = activeTextField;
  const doneFocused = document.activeElement?.matches(".keyboard-done");
  if (!activeTextField && !doneFocused) lastTextField = null;
  const editing = touchScreen.matches && Boolean(activeTextField || (doneFocused && lastTextField));
  document.body.classList.toggle("text-entry", editing);
  if (editing && viewport) {
    document.body.style.setProperty("--keyboard-top", `${viewport.offsetTop}px`);
    document.body.style.setProperty("--keyboard-height", `${viewport.height}px`);
  }
}

function dismissKeyboard(event) {
  event?.preventDefault();
  const active = document.activeElement?.matches(textFields) ? document.activeElement : null;
  active?.blur();
  if (lastTextField && lastTextField !== active) lastTextField.blur();
  lastTextField = null;
  try { navigator.virtualKeyboard?.hide?.(); } catch (_) {}
  document.body.classList.remove("text-entry");
  document.body.style.removeProperty("--keyboard-top");
  document.body.style.removeProperty("--keyboard-height");
  requestAnimationFrame(updateKeyboardLayout);
}

document.addEventListener("focusin", event => {
  if (event.target?.matches(textFields)) lastTextField = event.target;
  updateKeyboardLayout();
});
document.addEventListener("focusout", () => requestAnimationFrame(updateKeyboardLayout));
viewport?.addEventListener("resize", updateKeyboardLayout);
viewport?.addEventListener("scroll", updateKeyboardLayout);
for (const button of document.querySelectorAll(".keyboard-done")) {
  button.addEventListener("pointerdown", event => event.preventDefault());
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

function fitPrompt() {
  promptInput.style.height = "auto";
  promptInput.style.height = `${Math.min(83, Math.max(37, promptInput.scrollHeight))}px`;
}

function setPlayback(playing = false) {
  quitModelButton.textContent = runtimeLoaded ? "Unload model" : "Load model";
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

function markSettingsDirty() {
  // Before Start, preserve edits in memory. Only the active controller writes
  // preferences to the host through /start and /settings.
  settingsDirty = true;
}

async function loadHostPreferences() {
  try {
    const {settings} = await request("/preferences");
    if (settingsDirty) return;
    if (typeof settings.prompt === "string") promptInput.value = settings.prompt;
    if (Number.isInteger(settings.steps)) stepsInput.value = String(Math.max(1, Math.min(4, settings.steps)));
    if ([512, 640, 768, 896, 1024].includes(settings.resolution)) resolutionInput.value = String(settings.resolution);
    if (typeof settings.upscale === "boolean") upscale = settings.upscale;
    showError("", "preferences");
  } catch (error) {
    showError(error.message || "Could not load saved settings.", "preferences");
  } finally {
    stepsValue.value = stepsInput.value;
    stepsValue.textContent = stepsInput.value;
    upscaleButton.setAttribute("aria-pressed", String(upscale));
    fitPrompt();
  }
}

async function request(path, body, options = {}) {
  const headers = body === undefined ? {} : {"Content-Type": "application/json"};
  if (sessionToken) headers["X-Restyle-Session"] = sessionToken;
  const controller = new AbortController();
  const timer = path === "/start" ? null : setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(path, {
      method: body === undefined ? "GET" : "POST", headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store", signal: controller.signal,
      keepalive: options.keepalive ?? (path === "/pause" && document.visibilityState !== "visible")
    });
    const raw = await response.text();
    let result = {};
    try { result = JSON.parse(raw); } catch (_) {}
    if (!response.ok) {
      const message = result.error || raw || "Request failed (" + response.status + ").";
      const failure = new Error(message.toLowerCase() === "load failed"
        ? "Could not reach the host. Check its connection and try again."
        : message);
      failure.status = response.status;
      failure.data = result;
      throw failure;
    }
    return result;
  } catch (error) {
    if (error.status) throw error;
    if (controller.signal.aborted) throw new Error("The host did not respond in time. Check the connection and try again.");
    if (error instanceof TypeError || error.message?.toLowerCase() === "load failed") {
      throw new Error("Could not reach the host. Check its connection and try again.");
    }
    throw error;
  } finally { if (timer) clearTimeout(timer); }
}

function stopHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = 0;
}

function loseOwnership(message) {
  visibilityResumePending = false;
  sessionEpoch += 1;
  sessionToken = "";
  runtimeLoaded = false;
  stopHeartbeat();
  clearCameraSession();
  setPlayback();
  showError(message || "Camera control moved to another device. Press Start to take over.", "camera");
}

async function requestRuntimeStart(allowLowVram) {
  const startupId = crypto.randomUUID();
  pendingStartupId = startupId;
  cancelStartupButton.hidden = false;
  cancelStartupButton.disabled = false;
  let complete = false;
  let timer;
  let lastStage = "";
  let changedAt = performance.now();
  const poll = async () => {
    try {
      const progress = await request("/startup/" + startupId);
      const stage = modelStartupStages[progress.stage];
      if (progress.stage && progress.stage !== lastStage) {
        lastStage = progress.stage;
        changedAt = performance.now();
      }
      if (!complete && stage) {
        if (performance.now() - changedAt > 120000) showStartup("Still loading", stage[1]);
        else showStartup(...stage);
      }
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
    if (pendingStartupId === startupId) {
      pendingStartupId = "";
      cancelStartupButton.hidden = true;
    }
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
      const proceed = window.confirm(`Low VRAM: ${free.toFixed(1)} GiB free of ${total.toFixed(1)} GiB. Use CPU offloading? This may be slower.`);
      if (!proceed) throw new Error("Start cancelled.");
      result = await requestRuntimeStart(true);
    } else {
      throw error;
    }
  }
  if (!result.ok) throw new Error("Could not start the local runtime.");
  runtimeLoaded = true;
  if (result.preferences_saved === false) showError(result.warning, "preferences");
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
    button.textContent = `${selfie ? "−" : ""}${number}×`;
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
 }

async function connectWebRTC() {
  return openWebRTC(stream, {
    created: current => { peer = current; },
    isCurrent: current => peer === current && !document.hidden,
    onTrack: (current, event) => {
      if (peer !== current || event.track.kind !== "video") return;
      localOutput.hidden = true;
      output.classList.remove("camera-source");
      output.hidden = false;
      const renderedStream = event.streams[0] || new MediaStream([event.track]);
      output.srcObject = renderedStream;
      if (output.requestVideoFrameCallback) {
        if (presentationCallback) output.cancelVideoFrameCallback(presentationCallback);
        const presented = () => {
          if (peer !== current || output.srcObject !== renderedStream) return;
          notePresentation();
          presentationCallback = output.requestVideoFrameCallback(presented);
        };
        presentationCallback = output.requestVideoFrameCallback(presented);
      }
      output.play().catch(() => {});
    },
    onState: current => {
      if (peer !== current) return;
      clearTimeout(disconnectTimer);
      if (["failed", "closed", "disconnected"].includes(current.connectionState)) {
        disconnectTimer = setTimeout(() => {
          if (peer !== current || !started || busy || current.connectionState === "connected") return;
          cameraLost("Camera connection lost.");
        }, current.connectionState === "disconnected" ? 3000 : 0);
      }
    },
    offer: data => trackTransportRequest(request("/offer", data))
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

function connectLocalWebSocket() {
  return trackTransportRequest(openLocalSocket(sessionToken, {
    created: socket => { localSocket = socket; },
    onMessage: (socket, event) => void handleLocalMessage(event, socket),
    onClose: socket => {
      if (localSocket !== socket || !started) return;
      cameraLost("Camera connection closed.");
    }
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
  markSettingsDirty();
  if (!runtimeLoaded) {
    const settings = readSettings();
    const stored = {
      prompt: settings.prompt, steps: settings.steps,
      resolution: settings.resolution, upscale: settings.upscale
    };
    const pending = settingsApplyQueue.catch(() => {}).then(async () => {
      if (runtimeLoaded || pending !== settingsApplyQueue) return;
      try {
        await request("/preferences", {settings: stored});
        showError("", "settings");
      } catch (error) {
        showError(error.message, "settings");
      }
    });
    settingsApplyQueue = pending;
    return pending;
  }
  const settings = readSettings();
  const token = sessionToken;
  const pending = settingsApplyQueue.catch(() => {}).then(async () => {
    if (!runtimeLoaded || token !== sessionToken || pending !== settingsApplyQueue) return;
    try {
      const response = await request("/settings", { settings });
      if (token === sessionToken) showError(response.warning || "", "settings");
    } catch (error) {
      if (token === sessionToken) showError(error.message, "settings");
    }
  });
  settingsApplyQueue = pending;
  return pending;
}

function schedulePromptApply() {
  markSettingsDirty();
  clearTimeout(promptApplyTimer);
  promptApplyTimer = setTimeout(() => {
    promptApplyTimer = 0;
    void applySettings();
  }, 2000);
}

function applyPromptNow() {
  markSettingsDirty();
  clearTimeout(promptApplyTimer);
  promptApplyTimer = 0;
  void applySettings();
}

async function start(automaticResume = false) {
  if (busy || started) return;
  busy = true;
  startInProgress = true;
  const startGeneration = generation;
  const isCurrentStart = () => generation === startGeneration && document.visibilityState === "visible";
  const ensureCurrentStart = () => {
    if (!isCurrentStart()) throw new Error("Start cancelled.");
  };
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
    if (automaticResume) await visibilityPauseTask;
    ensureCurrentStart();
    await preferencesReady;
    ensureCurrentStart();
    const requestedCamera = selectedCamera;
    stream = await openStartingCamera(requestedCamera, {current: isCurrentStart});
    ensureCurrentStart();
    const cameraTrack = stream.getVideoTracks()[0];
    if (!cameraTrack) throw new Error("The selected camera returned no video.");
    output.srcObject = stream;
    output.hidden = false;
    output.classList.add("camera-source");
    localOutput.hidden = true;
    await output.play().catch(() => {});
    ensureCurrentStart();
    if (requestedCamera?.zoom !== undefined && cameraTrack.getSettings().deviceId === requestedCamera.deviceId) {
      try { await setCameraZoom(cameraTrack, requestedCamera.zoom); }
      catch (error) { showCameraSwitchError(error.message); }
    }
    await populateCameras(cameraTrack);
    ensureCurrentStart();
    updateFlashVisibility(cameraTrack);
    applyCameraMirror(cameraTrack, selectedCamera);
    sessionClaimInProgress = true;
    sessionEpoch += 1;
    stopHeartbeat();
    try {
      sessionToken = (await request("/session", automaticResume ? {resume: true} : {})).token;
    } finally {
      sessionClaimInProgress = false;
    }
    ensureCurrentStart();
    runtimeLoaded = Boolean((await request("/health")).loaded);
    ensureCurrentStart();
    if (automaticResume) await request("/pause", {});
    ensureCurrentStart();
    if (runtimeLoaded && !heartbeatTimer) heartbeatTimer = setInterval(() => void heartbeat(), 10000);
    const connection = await request("/transport");
    ensureCurrentStart();
    transportMode = connection.mode;
    await startRuntime();
    ensureCurrentStart();
    if (!heartbeatTimer) heartbeatTimer = setInterval(() => void heartbeat(), 10000);
    if (!(await heartbeat())) throw new Error("The model stopped during startup. Press Start to retry.");
    ensureCurrentStart();
    showStartup("Connecting camera", 6);
    if (transportMode === "local") await connectLocalWebSocket();
    else await connectWebRTC();
    ensureCurrentStart();
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
    void updateMetrics();
  } catch (error) {
    const obsolete = generation !== startGeneration || document.visibilityState !== "visible";
    clearCameraSession();
    if (!obsolete && error.status === 409 && !error.data?.low_vram) loseOwnership(error.message);
    else if (sessionToken && runtimeLoaded) {
      // Release only the camera, never unload a warm model on a connection failure.
      const token = sessionToken;
      try {
        await transportRequest?.catch(() => {});
        if (token === sessionToken) await request("/pause", {}, {keepalive: obsolete});
      } catch (failure) {
        if (!obsolete && failure.status === 409) loseOwnership(failure.message);
      }
    }
    if (!runtimeLoaded) stopHeartbeat();
    setPlayback();
    if (!obsolete && error.message !== "Start cancelled.") showError(error.message);
  } finally {
    startInProgress = false;
    busy = false;
    startButton.disabled = false;
    quitModelButton.disabled = false;
    resumeAfterVisibility();
  }
}

function resumeAfterVisibility() {
  if (!visibilityResumePending || document.visibilityState !== "visible" || busy || started) return;
  visibilityResumePending = false;
  void start(true);
}

function suspendForVisibility() {
  if (!started && !startInProgress) return;
  visibilityResumePending = true;
  const wasStarted = started;
  const token = sessionToken;
  const pendingTransport = transportRequest;
  clearCameraSession();
  setPlayback();
  if (!wasStarted || !token) return;
  visibilityPauseTask = visibilityPauseTask.catch(() => {}).then(async () => {
    await pendingTransport?.catch(() => {});
    if (token !== sessionToken) return;
    await request("/pause", {}, {keepalive: true});
  }).catch(() => {});
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
  latencyMetrics.reset();
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
  busy = true;
  startButton.disabled = true;
  quitModelButton.disabled = true;
  clearCameraSession();
  try {
    const result = await pauseHostTransport();
    if (!result) return;
    runtimeLoaded = Boolean(result.loaded);
    showError("", "pause");
    if (!preserveError) showError("", "camera");
    if (!runtimeLoaded) stopHeartbeat();
  } catch (error) {
    if (error.status === 409) loseOwnership(error.message);
    else showError(error.message, "pause");
  } finally {
    setPlayback();
    startButton.disabled = false;
    quitModelButton.disabled = false;
    busy = false;
  }
}

async function stop() {
  if (busy || !sessionToken) return;
  const token = sessionToken;
  busy = true;
  startButton.disabled = true;
  clearTimeout(promptApplyTimer);
  promptApplyTimer = 0;
  clearCameraSession();
  try {
    await transportRequest?.catch(() => {});
    if (token !== sessionToken) return;
    await request("/stop", {});
    sessionToken = "";
    sessionEpoch += 1;
    runtimeLoaded = false;
    stopHeartbeat();
    clearErrors();
  } catch (error) {
    if (error.status === 409) loseOwnership(error.message);
    else showError(error.message, "stop");
  } finally {
    setPlayback();
    startButton.disabled = false;
    busy = false;
  }
}

async function heartbeat() {
  if (!runtimeLoaded || !sessionToken || sessionClaimInProgress || document.visibilityState !== "visible") return true;
  if (heartbeatPending) return true;
  heartbeatPending = true;
  const token = sessionToken;
  const heartbeatEpoch = sessionEpoch;
  const heartbeatGeneration = generation;
  try {
    const result = await request("/heartbeat", {});
    if (token !== sessionToken || heartbeatEpoch !== sessionEpoch || heartbeatGeneration !== generation || document.hidden) return true;
    showError("", "heartbeat");
    if (!result.loaded) {
      loseOwnership("The model unloaded after inactivity. Press Start.");
      return false;
    }
    return true;
  } catch (error) {
    if (token !== sessionToken || heartbeatGeneration !== generation || document.hidden) return true;
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
    const modelMs = Number(metrics.model_ms) || 0;
    const clientMs = await latencyMetrics.measure(currentPeer, metrics, transportMode, localRoundTripMs);
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
    await connectLocalWebSocket();
  } else {
    await connectWebRTC();
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
  promptInput, applyPromptNow, request, fitPrompt,
  isMirrored: () => mirror, getRenderedFrame
});
startButton.addEventListener("click", () => {
  cameraActions.classList.add("activated");
  if (started) void pause();
  else void start();
});
cancelStartupButton.addEventListener("click", async () => {
  if (!pendingStartupId) return;
  cancelStartupButton.disabled = true;
  showStartup("Cancelling startup");
  try {
    await request("/cancel-start", {startup_id: pendingStartupId});
  } catch (error) {
    showError(error.message, "startup");
    cancelStartupButton.disabled = false;
  }
});
clearPromptButton.addEventListener("click", () => {
  promptInput.value = "";
  applyPromptNow();
});
quitModelButton.addEventListener("click", async () => {
  if (busy) return;
  setPanel(false);
  quitModelButton.disabled = true;
  if (runtimeLoaded) await stop();
  else {
    cameraActions.classList.add("activated");
    await start();
  }
  quitModelButton.disabled = false;
});
flashButton.addEventListener("click", () => void toggleFlash());
upscaleButton.addEventListener("click", () => {
  upscale = !upscale;
  upscaleButton.setAttribute("aria-pressed", String(upscale));
  void applySettings();
});
stepsInput.addEventListener("input", () => {
  stepsValue.value = stepsInput.value;
  stepsValue.textContent = stepsInput.value;
  markSettingsDirty();
});
stepsInput.addEventListener("change", () => void applySettings());
resolutionInput.addEventListener("change", () => void applySettings());
promptInput.addEventListener("input", () => {
  fitPrompt();
  schedulePromptApply();
});
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
    suspendForVisibility();
    return;
  }
  visibleSince = performance.now();
  if (visibilityResumePending) {
    resumeAfterVisibility();
    return;
  }
  if (peer && ["failed", "closed"].includes(peer.connectionState)) {
    cameraLost("Camera connection lost.");
    return;
  }
  checkCameraTrack();
  if (!runtimeLoaded) return;
  await heartbeat();
  if (runtimeLoaded && transportMode === "local") scheduleLocalFrame();
});
window.addEventListener("pagehide", suspendForVisibility);
window.addEventListener("pageshow", () => {
  if (!document.hidden) resumeAfterVisibility();
});

// A passive page never acquires or extends ownership of another camera.
const preferencesReady = loadHostPreferences();

