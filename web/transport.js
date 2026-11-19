export function cameraFrameSize(width, height, resolution) {
  if (![width, height, resolution].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error("Camera frame is not ready.");
  }
  const scale = Math.min(1, resolution / Math.max(width, height));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

export async function encodeCameraFrame(video, canvas, context, resolution) {
  const [w, h] = cameraFrameSize(video.videoWidth, video.videoHeight, resolution);
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  context.drawImage(video, 0, 0, w, h);
  const image = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.88));
  if (!image || image.type !== "image/jpeg") throw new Error("Could not encode camera frame.");
  return image.arrayBuffer();
}
