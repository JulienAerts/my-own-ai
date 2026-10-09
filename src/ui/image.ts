// Photos for the vision model, sized so WebLLM can actually take them.
//
// WebLLM 0.2.85 tiles a Phi-3.5-vision image into crops of 336 px. The number
// of crops, and so of tokens, depends only on the image's aspect ratio, and
// the prebuilt model library is compiled with a 2048-token prefill chunk that
// one image must fit in. A square photo (2,509 tokens) or a 16:9 screenshot
// (2,353) would fail, so such images are letterboxed onto the nearest canvas
// shape that fits. The functions below mirror WebLLM's calculateResizeShape,
// calculateCropShape and computeImageEmbedSize for phi3_v.
const CROP = 336;
const HD_NUM = 16;
/** Leaves room under the 2048-token prefill chunk (desktops). */
export const MAX_IMAGE_TOKENS = 2000;
/**
 * Phones: fewer crops means a faster vision encoder, a shorter prefill and
 * less memory. A square photo goes from 13 crops (1,933 tokens) to 9 (1,357).
 */
export const PHONE_IMAGE_TOKENS = 1400;

function resizeShape(h: number, w: number): [number, number] {
  const ratio = w / h;
  let scale = 1;
  while (scale * Math.ceil(scale / ratio) <= HD_NUM) scale++;
  scale--;
  const newW = scale * CROP;
  return [Math.floor(newW / ratio), newW];
}

function cropShape(h: number, w: number): [number, number] {
  const [rh, rw] = resizeShape(h, w);
  return [Math.ceil(rh / CROP), Math.floor(rw / CROP)];
}

export function imageTokens(h: number, w: number): number {
  const [ch, cw] = cropShape(h, w);
  return ch * 12 * (cw * 12 + 1) + 1 + 12 * 13;
}

/** Canvas grids (cols × rows of 336 px crops) that WebLLM maps to themselves, within `budget`. */
function grids(budget: number): [number, number][] {
  const out: [number, number][] = [];
  for (let cw = 1; cw <= HD_NUM; cw++) {
    for (let ch = 1; ch <= HD_NUM; ch++) {
      const [rch, rcw] = cropShape(ch * CROP, cw * CROP);
      if (rch === ch && rcw === cw && imageTokens(ch * CROP, cw * CROP) <= budget) out.push([cw, ch]);
    }
  }
  return out;
}

/** Output canvas size and where the image goes in it (exported for tests). */
export function imageLayout(w: number, h: number, budget: number): { cw: number; ch: number; x: number; y: number; dw: number; dh: number } {
  if (imageTokens(h, w) <= budget) {
    // The image's own shape fits: just cap the size (WebLLM scales to ≤ 1344 px wide anyway).
    const s = Math.min(1, 1344 / Math.max(w, h));
    const dw = Math.max(1, Math.round(w * s)), dh = Math.max(1, Math.round(h * s));
    return { cw: dw, ch: dh, x: 0, y: 0, dw, dh };
  }
  // Pick the grid that shows the image largest, then letterbox it (no cropping).
  const options = grids(budget);
  let best = options[0], bestScale = 0;
  for (const g of options) {
    const scale = Math.min((g[0] * CROP) / w, (g[1] * CROP) / h);
    if (scale > bestScale) { best = g; bestScale = scale; }
  }
  const cw = best[0] * CROP, ch = best[1] * CROP;
  const dw = Math.round(w * bestScale), dh = Math.round(h * bestScale);
  return { cw, ch, x: Math.round((cw - dw) / 2), y: Math.round((ch - dh) / 2), dw, dh };
}

export function isImage(file: Blob): boolean {
  return file.type.startsWith('image/');
}

export interface PreparedImage {
  url: string;
  /** What WebLLM will turn it into. */
  tokens: number;
}

/** `budget`: most tokens the image may cost (lower on phones; see imageTokenBudget). */
export async function prepareImage(blob: Blob, budget = MAX_IMAGE_TOKENS): Promise<PreparedImage> {
  if (!isImage(blob)) throw new Error('This file is not an image.');
  let bitmap: ImageBitmap;
  try {
    // Applies the photo's EXIF orientation, so phone pictures aren't sideways.
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    throw new Error("Couldn't read this image (unsupported format?).");
  }
  const l = imageLayout(bitmap.width, bitmap.height, budget);
  const canvas = document.createElement('canvas');
  canvas.width = l.cw;
  canvas.height = l.ch;
  const ctx = canvas.getContext('2d')!;
  // White background: JPEG has no transparency, and it fills the letterbox.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, l.cw, l.ch);
  ctx.drawImage(bitmap, l.x, l.y, l.dw, l.dh);
  bitmap.close();
  return { url: canvas.toDataURL('image/jpeg', 0.85), tokens: imageTokens(l.ch, l.cw) };
}

/** The first image on the clipboard, if any (paste a screenshot into the chat). */
export function imageFromClipboard(e: ClipboardEvent): File | null {
  for (const item of e.clipboardData?.items ?? []) {
    if (item.kind === 'file' && item.type.startsWith('image/')) return item.getAsFile();
  }
  return null;
}
