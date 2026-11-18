// Home-screen banners: the app shows every batch banner in a fixed 1200 x 520 box with
// resizeMode "cover" (and a slow 4% "breathing" zoom), so an image of any other shape is cut.
// The dashboard therefore turns whatever image is chosen into an exact 1200 x 520 picture,
// framed the way the owner chose in a card-shaped preview, before it is uploaded.
//
// One framing covers every case: the image is scaled by `zoom` (1 = just covers the card) and
// placed by x / y. Zoom above 1 crops; below 1 the image shrinks on all sides and the space
// around it takes the colour of the image's edges, so nothing is cut.

export const BANNER_W = 1200;
export const BANNER_H = 520;
/** Keep text inside this inset (fraction of each side): the app's 4% zoom crops ~2% per edge. */
export const SAFE_INSET = 0.05;
export const MAX_ZOOM = 3;

export interface Framing {
  zoom: number; // 1 = the image just covers the card; less shrinks it (bands around), more crops
  x: number; // 0 = image against the left (or its left edge shown), 1 = right, 0.5 = centre
  y: number; // 0 = top, 1 = bottom
}

export const DEFAULT_FRAMING: Framing = { zoom: 1, x: 0.5, y: 0.5 };

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const cover = (srcW: number, srcH: number, W: number, H: number) => Math.max(W / srcW, H / srcH);

/** The zoom at which the whole image fits inside the card, less `inset` of each side. */
export function fitZoom(srcW: number, srcH: number, inset = 0, W = BANNER_W, H = BANNER_H): number {
  const k = 1 - 2 * inset;
  return Math.min((W * k) / srcW, (H * k) / srcH) / cover(srcW, srcH, W, H);
}

/** The smallest zoom offered: half the "whole image" size. */
export const minZoom = (srcW: number, srcH: number) => Math.min(1, fitZoom(srcW, srcH) * 0.5);

/** Where the image is drawn on the card (may reach past its edges: that part is cut). */
export function placement(srcW: number, srcH: number, f: Framing, W = BANNER_W, H = BANNER_H): Rect {
  const scale = cover(srcW, srcH, W, H) * clamp(f.zoom, minZoom(srcW, srcH), MAX_ZOOM);
  const w = srcW * scale;
  const h = srcH * scale;
  return { x: (W - w) * clamp(f.x, 0, 1), y: (H - h) * clamp(f.y, 0, 1), w, h };
}

/** What happens to the image's edges: all inside the dashed line, inside the card only, or cut. */
export function edgeState(srcW: number, srcH: number, f: Framing): "safe" | "inside" | "cut" {
  const p = placement(srcW, srcH, f);
  const e = 0.5; // pixels of rounding
  // `inset` of each side: of the width left and right, of the height top and bottom (the dashed line).
  const within = (inset: number) => {
    const mx = BANNER_W * inset;
    const my = BANNER_H * inset;
    return p.x >= mx - e && p.y >= my - e && p.x + p.w <= BANNER_W - mx + e && p.y + p.h <= BANNER_H - my + e;
  };
  if (within(SAFE_INSET)) return "safe";
  if (within(0)) return "inside";
  return "cut";
}

/** A sharp-enough check for the warning under the preview: enlarged more than 10%. */
export const looksSoft = (srcW: number, srcH: number, f: Framing) => placement(srcW, srcH, f).w / srcW > 1.1;

/** The average colour of the image's border, to fill the space around a smaller image. */
export function edgeColor(img: CanvasImageSource & { width: number; height: number }): string {
  const c = document.createElement("canvas");
  c.width = 32;
  c.height = 32;
  const ctx = c.getContext("2d");
  if (!ctx) return "#eef1f6";
  ctx.drawImage(img, 0, 0, 32, 32);
  const d = ctx.getImageData(0, 0, 32, 32).data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < 32; i++) {
    for (const [px, py] of [[i, 0], [i, 31], [0, i], [31, i]] as const) {
      const o = (py * 32 + px) * 4;
      r += d[o]!; g += d[o + 1]!; b += d[o + 2]!; n++;
    }
  }
  const hex = (v: number) => Math.round(v / n).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** Draw the framed banner onto a canvas context of any size with the banner's shape. */
export function drawBanner(ctx: CanvasRenderingContext2D, img: CanvasImageSource & { width: number; height: number }, f: Framing, W: number, H: number, background: string) {
  ctx.clearRect(0, 0, W, H);
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, W, H);
  const p = placement(img.width, img.height, f, W, H);
  ctx.drawImage(img, p.x, p.y, p.w, p.h);
}

// --- the image in its own shape --------------------------------------------------------------
// The app's card takes a banner's own width / height (between OWN_MIN_RATIO and OWN_MAX_RATIO,
// like the app's BANNER_MIN_RATIO / BANNER_MAX_RATIO), so a picture uploaded whole shows whole:
// nothing cut, no bands. Only scaled down to OWN_MAX_W pixels across.
export const OWN_MAX_W = 1600;
export const OWN_MIN_RATIO = 1;
export const OWN_MAX_RATIO = 3.5;

export function ownSize(srcW: number, srcH: number): { w: number; h: number } {
  const k = Math.min(1, OWN_MAX_W / srcW);
  return { w: Math.round(srcW * k), h: Math.round(srcH * k) };
}

/** Whether the app's card can take this picture's shape (else the card cuts its edges). */
export const ownShapeFits = (srcW: number, srcH: number) => srcW / srcH >= OWN_MIN_RATIO && srcW / srcH <= OWN_MAX_RATIO;

export function drawOwn(ctx: CanvasRenderingContext2D, img: CanvasImageSource & { width: number; height: number }, W: number, H: number) {
  ctx.clearRect(0, 0, W, H);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, W, H);
}

/** The whole picture as a JPEG in its own shape, ready to upload. */
export function ownFile(img: CanvasImageSource & { width: number; height: number }, name: string): Promise<File> {
  const { w, h } = ownSize(img.width, img.height);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) return Promise.reject(new Error("This browser can't prepare the image."));
  drawOwn(ctx, img, w, h);
  return new Promise((resolve, reject) =>
    c.toBlob((blob) => (blob ? resolve(new File([blob], `${name}.jpg`, { type: "image/jpeg" })) : reject(new Error("The image couldn't be prepared."))), "image/jpeg", 0.92),
  );
}

export function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve(img); // the object URL stays alive for redraws; revoked on unmount
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file isn't an image the browser can open.")); };
    img.src = url;
  });
}

/** The finished 1200 x 520 JPEG, ready to upload. */
export function bannerFile(img: CanvasImageSource & { width: number; height: number }, f: Framing, background: string, name: string): Promise<File> {
  const c = document.createElement("canvas");
  c.width = BANNER_W;
  c.height = BANNER_H;
  const ctx = c.getContext("2d");
  if (!ctx) return Promise.reject(new Error("This browser can't prepare the banner."));
  drawBanner(ctx, img, f, BANNER_W, BANNER_H, background);
  return new Promise((resolve, reject) =>
    c.toBlob((blob) => (blob ? resolve(new File([blob], `${name}.jpg`, { type: "image/jpeg" })) : reject(new Error("The banner couldn't be prepared."))), "image/jpeg", 0.92),
  );
}
