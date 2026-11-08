import { describe, expect, it } from "vitest";
import { darkenForWhiteText, FALLBACK_WASH, washFromPixels, whiteContrast, type Rgb } from "../src/listener/wash.ts";

const rgbOf = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
const solid = (rgb: Rgb, n = 16) => Array.from({ length: n }, () => [...rgb, 255]).flat();

describe("wash", () => {
  it("fallback colours all pass AA with white text", () => {
    for (const hex of Object.values(FALLBACK_WASH)) expect(whiteContrast(rgbOf(hex))).toBeGreaterThanOrEqual(4.5);
  });

  it("darkens a light orange until white text passes AA", () => {
    expect(whiteContrast([255, 79, 0])).toBeLessThan(4.5);
    expect(whiteContrast(darkenForWhiteText([255, 79, 0]))).toBeGreaterThanOrEqual(4.5);
  });

  it("returns AA colours from a bright picture", () => {
    const wash = washFromPixels([...solid([255, 230, 0]), ...solid([0, 200, 255], 8)])!;
    for (const hex of Object.values(wash)) expect(whiteContrast(rgbOf(hex))).toBeGreaterThanOrEqual(4.5);
  });

  it("gives null for a grey picture so the caller falls back", () => {
    expect(washFromPixels(solid([120, 120, 120]))).toBeNull();
  });
});
