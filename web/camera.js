function recordCameraOpen(startedAt, result) {
  const endedAt = performance.now();
  const timing = { durationMs: endedAt - startedAt, result };
  try {
    performance.clearMeasures("camera.open");
    performance.measure("camera.open", { start: startedAt, end: endedAt, detail: { result } });
  } catch (_) {}
  return timing;
}

export async function cameraStream(deviceId = "", facingMode = "environment") {
  const startedAt = performance.now();
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
    const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    stream.cameraOpenTiming = { ...recordCameraOpen(startedAt, "success") };
    return stream;
  } catch (error) {
    recordCameraOpen(startedAt, "failure");
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


export function currentRotation() {
  let angle = Number(screen.orientation && screen.orientation.angle);
  if (!Number.isFinite(angle) && Number.isFinite(Number(window.orientation))) angle = Number(window.orientation);
  if (!Number.isFinite(angle)) angle = 0;
  return ((Math.round(angle / 90) * 90) % 360 + 360) % 360;
}

