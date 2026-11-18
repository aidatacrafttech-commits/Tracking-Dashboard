import { describe, expect, it } from "vitest";
import { BANNER_H, BANNER_W, edgeState, fitZoom, looksSoft, minZoom, placement, SAFE_INSET } from "./bannerFit";

// 1672 x 941: the Class 12 thumbnails (16:9).
const W16 = 1672;
const H9 = 941;

describe("banner framing (the app's 1200 x 520 card)", () => {
  it("zoom 1 just covers the card: a 16:9 thumbnail is cut top and bottom, moving only up and down", () => {
    const mid = placement(W16, H9, { zoom: 1, x: 0.5, y: 0.5 });
    expect(mid.w).toBeCloseTo(BANNER_W);
    expect(mid.h).toBeGreaterThan(BANNER_H);
    expect(mid.y).toBeCloseTo((BANNER_H - mid.h) / 2);
    expect(placement(W16, H9, { zoom: 1, x: 0.5, y: 0 }).y).toBeCloseTo(0); // its top edge shown
    expect(edgeState(W16, H9, { zoom: 1, x: 0.5, y: 0.5 })).toBe("cut");
  });

  it("zoom above 1 crops more, capped at 3", () => {
    expect(placement(W16, H9, { zoom: 2, x: 0.5, y: 0.5 }).w).toBeCloseTo(BANNER_W * 2);
    expect(placement(W16, H9, { zoom: 9, x: 0.5, y: 0.5 }).w).toBeCloseTo(BANNER_W * 3);
  });

  it("zoom below 1 shrinks the image on every side until nothing is cut", () => {
    const whole = fitZoom(W16, H9);
    const p = placement(W16, H9, { zoom: whole, x: 0.5, y: 0.5 });
    expect(p.h).toBeCloseTo(BANNER_H);
    expect(p.x).toBeCloseTo((BANNER_W - p.w) / 2);
    expect(edgeState(W16, H9, { zoom: whole, x: 0.5, y: 0.5 })).toBe("inside");

    const safe = placement(W16, H9, { zoom: fitZoom(W16, H9, SAFE_INSET), x: 0.5, y: 0.5 });
    expect(safe.y).toBeCloseTo(BANNER_H * SAFE_INSET);
    expect(safe.y + safe.h).toBeCloseTo(BANNER_H * (1 - SAFE_INSET));
    expect(edgeState(W16, H9, { zoom: fitZoom(W16, H9, SAFE_INSET), x: 0.5, y: 0.5 })).toBe("safe");
  });

  it("a small image can sit anywhere in the card, and can't shrink below half its whole size", () => {
    const z = minZoom(W16, H9);
    expect(z).toBeCloseTo(fitZoom(W16, H9) / 2);
    expect(placement(W16, H9, { zoom: z, x: 0, y: 0 })).toMatchObject({ x: 0, y: 0 });
    const right = placement(W16, H9, { zoom: z, x: 1, y: 1 });
    expect(right.x + right.w).toBeCloseTo(BANNER_W);
    expect(right.y + right.h).toBeCloseTo(BANNER_H);
    expect(placement(W16, H9, { zoom: 0.01, x: 0.5, y: 0.5 }).h).toBeCloseTo(BANNER_H / 2);
  });

  it("a portrait picture fits with space left and right", () => {
    const p = placement(600, 900, { zoom: fitZoom(600, 900), x: 0.5, y: 0.5 });
    expect(p.h).toBeCloseTo(BANNER_H);
    expect(p.y).toBeCloseTo(0);
    expect(p.x).toBeGreaterThan(0);
  });

  it("warns when the image is enlarged too much to be sharp", () => {
    expect(looksSoft(1200, 520, { zoom: 1, x: 0.5, y: 0.5 })).toBe(false);
    expect(looksSoft(W16, H9, { zoom: 2, x: 0.5, y: 0.5 })).toBe(true);
    expect(looksSoft(640, 360, { zoom: fitZoom(640, 360), x: 0.5, y: 0.5 })).toBe(true);
    expect(looksSoft(1920, 1080, { zoom: fitZoom(1920, 1080), x: 0.5, y: 0.5 })).toBe(false);
  });
});

describe("the whole picture in its own shape", () => {
  it("keeps the shape, only scaled down to 1600 across", async () => {
    const { ownSize, ownShapeFits } = await import("./bannerFit");
    expect(ownSize(1672, 941)).toEqual({ w: 1600, h: Math.round(941 * (1600 / 1672)) });
    expect(ownSize(1200, 520)).toEqual({ w: 1200, h: 520 });
    expect(ownShapeFits(1672, 941)).toBe(true); // 16:9
    expect(ownShapeFits(1200, 520)).toBe(true); // the classic card
    expect(ownShapeFits(600, 900)).toBe(false); // portrait: the app's card can't be that tall
    expect(ownShapeFits(4000, 800)).toBe(false); // 5:1
  });
});
