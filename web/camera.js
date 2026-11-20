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
    const failure = (message, name = error.name) => Object.assign(new Error(message), {name});
    if (["NotAllowedError", "PermissionDeniedError", "SecurityError"].includes(error.name)) {
      throw failure("Allow camera access in browser settings, then retry.");
    }
    if (["NotFoundError", "DevicesNotFoundError"].includes(error.name)) {
      throw failure("No camera is available.");
    }
    if (["NotReadableError", "TrackStartError", "AbortError"].includes(error.name) || error.message === "Load failed") {
      throw failure("The camera is busy or unavailable. Close other apps using it and try again.",
        error.message === "Load failed" ? "AbortError" : error.name);
    }
    if (error.name === "OverconstrainedError") {
      throw failure("The selected camera is unavailable. Choose another camera.");
    }
    throw error;
  }
}

export async function openStartingCamera(choice) {
  const facing = choice?.facing || "environment";
  let deviceId = choice?.deviceId || "";
  for (let attempt = 0; ; attempt++) {
    try {
      return await cameraStream(deviceId, facing);
    } catch (error) {
      if (deviceId && ["NotFoundError", "DevicesNotFoundError", "OverconstrainedError"].includes(error.name)) {
        deviceId = "";
        continue;
      }
      if (attempt >= 2 || !["NotReadableError", "TrackStartError", "AbortError"].includes(error.name)) throw error;
      await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
}

export function cameraFacing(label = "") {
  if (/\b(front|selfie|user|facetime|true\s*depth)\b/i.test(label)) return "user";
  if (/\b(back|rear|environment)\b/i.test(label)) return "environment";
  return "";
}

export function cameraLenses(devices, settings = {}, zoom = null) {
  const activeDevice = devices.find(device => device.deviceId === settings.deviceId);
  const activeFacing = settings.facingMode || cameraFacing(activeDevice?.label);
  if (!activeDevice || !["user", "environment"].includes(activeFacing) ||
      /\bvirtual\b/i.test(activeDevice.label)) return [];

  const logicalCamera = /\b(?:dual|triple)(?:\s+wide)?\b/i;
  const physicalCameras = devices.filter(device => device.deviceId && !/\bvirtual\b/i.test(device.label));
  const hasRearMain = physicalCameras.some(({label}) => cameraFacing(label) === "environment" &&
    !logicalCamera.test(label) && !/ultra[\s-]*wide|telephoto/i.test(label));
  const cameras = physicalCameras.filter(device =>
    (device.deviceId === settings.deviceId || !hasRearMain || !logicalCamera.test(device.label)));
  const choices = [];
  for (const device of cameras) {
    const current = device.deviceId === settings.deviceId;
    const facing = current ? activeFacing : cameraFacing(device.label);
    if (!facing) continue;
    const ratio = device.label.match(/(?:^|[^\w.])(\d+(?:\.\d+)?|\.\d+)\s*[x×](?!\w)/i);
    const telephoto = /\btelephoto\b/i.test(device.label);
    const magnification = ratio ? Number(ratio[1]) : /ultra[\s-]*wide/i.test(device.label) ? 0.5 : telephoto ? null : 1;
    if (!Number.isFinite(magnification) || magnification <= 0) continue;
    const choice = {deviceId: device.deviceId, facing, magnification, active: current};
    const duplicate = choices.findIndex(existing =>
      existing.facing === facing && existing.magnification === magnification);
    if (duplicate < 0) choices.push(choice);
    else if (current) choices[duplicate] = choice;
  }
  const base = choices.find(choice => choice.active && choice.magnification === 1);
  if (base && zoom && typeof settings.zoom === "number" && zoom.min <= 1 && zoom.max >= 1) {
    const selfie = base.facing === "user";
    const stops = selfie ? [0.5] : [0.5, 2];
    if (!selfie && !choices.some(choice => choice.facing === base.facing &&
      choice.magnification > 2)) stops.push(zoom.max >= 4 ? 4 : 3);
    for (const target of stops) {
      if (!(target >= zoom.min && target <= zoom.max) ||
          choices.some(choice => choice.facing === base.facing && choice.magnification === target)) continue;
      const active = Math.abs(settings.zoom - target) < Math.max((zoom.step || 0) / 2, 0.01);
      choices.push({...base, magnification: target, zoom: target, active});
      if (active) base.active = false;
    }
    base.zoom = 1;
  }
  return choices.sort((a, b) => Number(b.facing === "user") - Number(a.facing === "user") ||
    a.magnification - b.magnification);
}

export async function setCameraZoom(track, zoom) {
  if (zoom === undefined) return;
  const current = track.getSettings().zoom;
  if (Math.abs(current - zoom) < 0.01) return;
  await track.applyConstraints({zoom: {exact: zoom}, advanced: [{zoom}]});
  const applied = track.getSettings().zoom;
  if (typeof applied !== "number" || Math.abs(applied - zoom) > Math.max((track.getCapabilities?.()?.zoom?.step || 0) / 2, 0.01)) {
    throw new Error("This zoom level is unavailable.");
  }
}


export function currentRotation() {
  let angle = Number(screen.orientation && screen.orientation.angle);
  if (!Number.isFinite(angle) && Number.isFinite(Number(window.orientation))) angle = Number(window.orientation);
  if (!Number.isFinite(angle)) angle = 0;
  return ((Math.round(angle / 90) * 90) % 360 + 360) % 360;
}

