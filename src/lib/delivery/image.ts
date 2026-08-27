"use client";

/**
 * On-device image compression.
 *
 * A modern phone camera produces a 4–8 MB JPEG. Uploading that over a
 * two-bar connection from a stairwell is how a delivery confirmation ends
 * up taking four minutes, so the photo is resized and re-encoded before it
 * ever reaches the offline queue — the queue stores it, and storing eight
 * megabytes per stop fills IndexedDB by lunchtime.
 *
 * Roughly 1600px on the long edge at about 200 KB: legible enough to show
 * a doorway, a carton and a face, small enough to sync in seconds.
 */

const MAX_EDGE = 1600;
const TARGET_BYTES = 200 * 1024;
/** Below this the picture stops being evidence. */
const MIN_QUALITY = 0.4;

export type CompressOptions = {
  maxEdge?: number;
  targetBytes?: number;
};

/** Approximate decoded size of a base64 payload. */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return 0;
  return Math.round((dataUrl.length - comma - 1) * 0.75);
}

export async function compressImage(
  file: File,
  options: CompressOptions = {},
): Promise<{ dataUrl: string; bytes: number; width: number; height: number }> {
  const maxEdge = options.maxEdge ?? MAX_EDGE;
  const targetBytes = options.targetBytes ?? TARGET_BYTES;

  const bitmap = await loadImage(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  if (!context) throw new Error("This device cannot process the photo.");

  // White behind it: a transparent PNG flattened to JPEG otherwise comes
  // out with a black background, which looks like a failed capture.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);

  if ("close" in bitmap && typeof bitmap.close === "function") bitmap.close();

  let quality = 0.8;
  let dataUrl = canvas.toDataURL("image/jpeg", quality);

  while (dataUrlBytes(dataUrl) > targetBytes && quality > MIN_QUALITY) {
    quality -= 0.1;
    dataUrl = canvas.toDataURL("image/jpeg", quality);
  }

  return { dataUrl, bytes: dataUrlBytes(dataUrl), width, height };
}

async function loadImage(file: File): Promise<ImageBitmap | HTMLImageElement> {
  // `createImageBitmap` applies the EXIF orientation on modern browsers,
  // which is what stops portrait photos arriving on their side.
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      // Older WebView. Fall through to the <img> path.
    }
  }

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That file is not an image this device can read."));
    };
    image.src = url;
  });
}

/**
 * The device's position, or nothing.
 *
 * A POD without GPS is still a POD; a delivery blocked because the agent is
 * in a basement is a parcel that does not get handed over. So this resolves
 * to null rather than throwing, and never waits long.
 */
export function currentPosition(
  timeoutMs = 8000,
): Promise<{ latitude: number; longitude: number; accuracy: number } | null> {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (
      value: { latitude: number; longitude: number; accuracy: number } | null,
    ) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        clearTimeout(timer);
        finish({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
        });
      },
      () => {
        clearTimeout(timer);
        finish(null);
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 },
    );
  });
}
