export async function encodeCameraFrame(video, canvas, context, resolution) {
  const width = video.videoWidth, height = video.videoHeight;
  const longest = Math.max(width, height);
  if (!longest) throw new Error("Camera frame is not ready.");
  const scale = Math.min(1, resolution / longest);
  const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  context.drawImage(video, 0, 0, w, h);
  const image = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.88));
  if (!image || image.type !== "image/jpeg") throw new Error("Could not encode camera frame.");
  return image.arrayBuffer();
}
