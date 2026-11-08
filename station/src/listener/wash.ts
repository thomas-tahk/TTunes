// Colours for the page background, pulled from the current song's thumbnail. Pure maths here; the canvas read is in useWash.ts.
export type Rgb = [number, number, number];
export interface Wash {
  hot: string;
  mid: string;
  deep: string;
}

/** The look when extraction fails: magenta -> orange -> violet, already darkened to pass AA with white text. */
export const FALLBACK_WASH: Wash = { hot: "#C93C00", mid: "#C2185B", deep: "#3D0B5C" };
const AA = 4.6; // 4.5 plus a hair, so rounding never sinks it

const channel = (v: number) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
export const luminance = ([r, g, b]: Rgb) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
/** Contrast ratio of white text on this colour. */
export const whiteContrast = (rgb: Rgb) => 1.05 / (luminance(rgb) + 0.05);

/** Scales the colour toward black until white text on it reaches AA. */
export function darkenForWhiteText(rgb: Rgb): Rgb {
  let out = rgb;
  for (let i = 0; i < 40 && whiteContrast(out) < AA; i++) out = out.map((v) => Math.round(v * 0.94)) as Rgb;
  return out;
}

export const toHex = (rgb: Rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;

function hueOf([r, g, b]: Rgb): { hue: number; sat: number; val: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let hue = 0;
  if (d > 0) {
    if (max === r) hue = ((g - b) / d + 6) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
  }
  return { hue: hue * 60, sat: max === 0 ? 0 : d / max, val: max / 255 };
}

const BUCKETS = 12;
const rotate = ([r, g, b]: Rgb): Rgb => [b, r, g]; // a different hue family when the picture has only one

/** `pixels` is flat RGBA. Picks the two strongest hue families, weighted by how vivid they are; null when the picture is grey/black. */
export function washFromPixels(pixels: ArrayLike<number>): Wash | null {
  const sums = Array.from({ length: BUCKETS }, () => ({ w: 0, rgb: [0, 0, 0] as Rgb }));
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const rgb: Rgb = [pixels[i], pixels[i + 1], pixels[i + 2]];
    const { hue, sat, val } = hueOf(rgb);
    const w = sat * sat * val;
    if (pixels[i + 3] < 128 || w < 0.02) continue;
    const slot = sums[Math.floor(hue / (360 / BUCKETS)) % BUCKETS];
    slot.w += w;
    rgb.forEach((v, c) => (slot.rgb[c] += v * w));
  }
  const ranked = sums.filter((s) => s.w > 0).sort((a, b) => b.w - a.w);
  if (ranked.length === 0) return null;
  const avg = (s: (typeof sums)[number]) => s.rgb.map((v) => Math.round(v / s.w)) as Rgb;
  const first = avg(ranked[0]);
  const second = ranked[1] ? avg(ranked[1]) : rotate(first);
  const deep = first.map((v) => Math.round(v * 0.22)) as Rgb;
  return { hot: toHex(darkenForWhiteText(first)), mid: toHex(darkenForWhiteText(second)), deep: toHex(darkenForWhiteText(deep)) };
}
