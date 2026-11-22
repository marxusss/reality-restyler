export function mountCapture({getFrame, isMirrored, reportError}) {
  const shutter = document.getElementById("shutterButton");
  const modeButton = document.getElementById("captureModeButton");
  const otherModeButton = document.getElementById("captureOtherModeButton");
  const modeStrip = modeButton.parentElement;
  const fileActions = document.getElementById("captureFileActions");
  const save = document.getElementById("saveCaptureButton");
  const discard = document.getElementById("discardCaptureButton");
  const surface = document.createElement("canvas");
  const context = surface.getContext("2d", {alpha: false});
  const canRecord = Boolean(window.MediaRecorder && surface.captureStream);
  const touch = window.matchMedia("(any-pointer: coarse)");
  const recordingBudget = 64 * 1024 * 1024;
  let videoMode = canRecord;
  let available = false;
  let finishing = false;
  let recorder = null;
  let captureFile = null;
  let swipe = null;
  let suppressClick = false;

  function updateControls() {
    const recording = recorder?.state === "recording";
    shutter.disabled = !recording && (!available || finishing || Boolean(captureFile));
    shutter.dataset.mode = videoMode ? "video" : "photo";
    shutter.classList.toggle("recording", recording);
    shutter.setAttribute("aria-label", recording ? "Stop recording" : videoMode ? "Record video" : "Take photo");
    modeButton.textContent = videoMode ? "Video" : "Photo";
    modeButton.setAttribute("aria-label", videoMode ? "Switch to photo" : "Switch to video");
    otherModeButton.textContent = videoMode ? "Photo" : "Video";
    otherModeButton.setAttribute("aria-label", videoMode ? "Switch to photo" : "Switch to video");
    modeStrip.classList.toggle("photo-active", !videoMode);
    modeButton.disabled = otherModeButton.disabled = Boolean(recorder) || finishing;
    modeButton.hidden = otherModeButton.hidden = !canRecord;
    fileActions.hidden = !captureFile;
  }

  function draw(source) {
    const mirrored = isMirrored();
    context.setTransform(mirrored ? -1 : 1, 0, 0, 1, mirrored ? surface.width : 0, 0);
    const scale = Math.min(surface.width / source.width, surface.height / source.height);
    const width = source.width * scale;
    const height = source.height * scale;
    context.fillStyle = "#000";
    context.fillRect(0, 0, surface.width, surface.height);
    context.drawImage(source.frame, (surface.width - width) / 2, (surface.height - height) / 2, width, height);
  }

  function download(file) {
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = file.name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function finishCapture(blob) {
    if (!blob?.size) {
      reportError("Could not capture the output.");
    } else {
      const extension = blob.type.includes("mp4") ? "mp4" : blob.type.includes("webm") ? "webm" : "jpg";
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      captureFile = new File([blob], `reality-restyling-${stamp}.${extension}`, {type: blob.type});
    }
    finishing = false;
    updateControls();
  }

  function startRecording() {
    const tracks = surface.captureStream(30);
    let active;
    try {
      const formats = touch.matches
        ? ["video/mp4", "video/webm;codecs=vp8", "video/webm"]
        : ["video/webm;codecs=vp8", "video/webm", "video/mp4"];
      const mimeType = formats.find(type => MediaRecorder.isTypeSupported(type));
      active = new MediaRecorder(tracks, mimeType ? {mimeType} : undefined);
      const chunks = [];
      let bytes = 0;
      let frameRequest = 0;
      let failed = false;
      active.ondataavailable = event => {
        if (!event.data.size) return;
        chunks.push(event.data);
        bytes += event.data.size;
        if (bytes >= recordingBudget) stopRecording();
      };
      active.onerror = () => {
        failed = true;
        reportError("Video recording failed.");
      };
      active.onstop = () => {
        cancelAnimationFrame(frameRequest);
        tracks.getTracks().forEach(track => track.stop());
        recorder = null;
        if (failed) {
          finishing = false;
          updateControls();
          return;
        }
        const type = (active.mimeType || chunks[0]?.type || "video/webm").split(";")[0];
        if (chunks.length) {
          finishCapture(new Blob(chunks, {type}));
        } else {
          finishing = false;
          reportError("No video frames were recorded.");
          updateControls();
        }
      };
      const recordFrame = () => {
        if (active.state !== "recording") return;
        const frame = getFrame();
        if (frame) draw(frame);
        frameRequest = requestAnimationFrame(recordFrame);
      };
      active.start(1000);
      recorder = active;
      frameRequest = requestAnimationFrame(recordFrame);
    } catch (error) {
      tracks.getTracks().forEach(track => track.stop());
      throw error;
    }
  }

  function stopRecording() {
    if (recorder?.state !== "recording") return;
    finishing = true;
    recorder.stop();
    updateControls();
  }

  function changeMode(video) {
    if (!canRecord || recorder || finishing) return;
    videoMode = video;
    updateControls();
  }

  for (const choice of [modeButton, otherModeButton]) {
    choice.addEventListener("click", event => {
      if (event.detail && suppressClick) { suppressClick = false; return; }
      changeMode(!videoMode);
    });
  }
  shutter.parentElement.addEventListener("pointerdown", event => {
    if (!event.isPrimary || finishing || recorder) return;
    suppressClick = false;
    swipe = {id: event.pointerId, x: event.clientX, y: event.clientY};
    event.target.setPointerCapture(event.pointerId);
  });
  shutter.parentElement.addEventListener("pointerup", event => {
    if (swipe?.id !== event.pointerId) return;
    const dy = event.clientY - swipe.y;
    const dx = event.clientX - swipe.x;
    swipe = null;
    if (Math.abs(dx) < 24 || Math.abs(dx) <= Math.abs(dy)) return;
    suppressClick = true;
    changeMode(!videoMode);
  });
  shutter.parentElement.addEventListener("pointercancel", () => { swipe = null; });

  shutter.addEventListener("click", event => {
    if (event.detail && suppressClick) {
      suppressClick = false;
      return;
    }
    if (recorder) { stopRecording(); return; }
    const source = getFrame();
    if (!available || finishing || captureFile || !source?.width || !source?.height) return;
    try {
      reportError("");
      surface.width = source.width;
      surface.height = source.height;
      draw(source);
      if (videoMode) startRecording();
      else {
        finishing = true;
        surface.toBlob(finishCapture, "image/jpeg", 0.95);
      }
    } catch (_) {
      finishing = false;
      reportError(videoMode ? "Could not start recording." : "Could not take a photo.");
    }
    updateControls();
  });

  save.addEventListener("click", async () => {
    if (!captureFile) return;
    const file = captureFile;
    save.disabled = true;
    discard.disabled = true;
    try {
      if (touch.matches && navigator.canShare?.({files: [file]})) await navigator.share({files: [file]});
      else download(file);
      captureFile = null;
      reportError("");
    } catch (error) {
      if (error.name !== "AbortError") reportError("Could not save the capture.");
    } finally {
      save.disabled = false;
      discard.disabled = false;
      updateControls();
    }
  });
  discard.addEventListener("click", () => {
    captureFile = null;
    updateControls();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopRecording();
  });
  updateControls();
  return {
    setAvailable(value) {
      available = value;
      if (!value) stopRecording();
      updateControls();
    }
  };
}
