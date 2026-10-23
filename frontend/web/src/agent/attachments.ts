import { newId } from '@worktree/core';
import type { ChatAttachment } from './conversations';

/** Images are model input, so they are bounded and re-encoded before sending. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_MB = MAX_IMAGE_BYTES / (1024 * 1024);

/** One turn may carry at most three images; more context rarely helps. */
export const MAX_ATTACHMENTS = 3;

/** The longest edge kept when re-encoding; larger edges carry no extra text. */
const MAX_IMAGE_EDGE = 1600;
const JPEG_QUALITY = 0.82;

export type ImageFileProblem = 'type' | 'size';

const IMAGE_EXTENSION_RE = /\.(png|jpe?g|webp|gif|bmp|avif|heic|heif)$/i;

/** Why a chosen file cannot be used as an image attachment; null when it can. */
export function imageFileProblem(file: File): ImageFileProblem | null {
  if (!file.type.startsWith('image/') && !IMAGE_EXTENSION_RE.test(file.name)) return 'type';
  if (file.size > MAX_IMAGE_BYTES) return 'size';
  return null;
}

function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('the browser could not decode this image'));
    image.src = url;
  });
}

/**
 * Re-encodes an image file as a JPEG data URL, downscaling so the long edge is
 * at most 1600px, and reports the output dimensions for the thumbnail layout.
 * A chat request carries the whole image as base64, so the original camera
 * file is both too large and needlessly detailed.
 */
export async function prepareAttachment(file: File): Promise<ChatAttachment> {
  const problem = imageFileProblem(file);
  if (problem === 'type') throw new Error('choose an image file');
  if (problem === 'size') throw new Error(`the image is larger than ${MAX_IMAGE_MB} MB`);

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await loadImageElement(objectUrl);
    const longest = Math.max(image.naturalWidth, image.naturalHeight);
    if (longest === 0) throw new Error('the image has no pixels');
    const scale = Math.min(1, MAX_IMAGE_EDGE / longest);
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('canvas 2d context is unavailable');
    context.drawImage(image, 0, 0, width, height);
    const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    return { id: newId(), name: file.name, dataUrl, width, height };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Wraps an already-encoded data URL. Dimensions are unknown without decoding
 * the image, so they are 0; this helper is for tests and vision payloads, not
 * for composer files (use `prepareAttachment` there).
 */
export function attachmentFromDataUrl(dataUrl: string, name = 'image'): ChatAttachment {
  return { id: newId(), name, dataUrl, width: 0, height: 0 };
}
