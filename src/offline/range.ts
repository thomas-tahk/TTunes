export interface ParsedRange {
  start: number;
  end: number;
}

// Parse a `Range: bytes=start-end` header against a known total size, clamped to
// valid bounds. Reference implementation for the service worker's range slicing
// (public/sw.js mirrors this — keep them in sync). Returns null for no/invalid range.
export function parseRange(rangeHeader: string | null, size: number): ParsedRange | null {
  if (!rangeHeader) return null;
  const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
  if (!match) return null;

  const hasStart = match[1] !== "";
  const hasEnd = match[2] !== "";
  let start = hasStart ? Number(match[1]) : 0;
  let end = hasEnd ? Number(match[2]) : size - 1;

  // Suffix range "bytes=-N" — last N bytes.
  if (!hasStart && hasEnd) {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  }

  start = Math.max(0, start);
  end = Math.min(end, size - 1);
  if (Number.isNaN(start) || Number.isNaN(end) || start > end) return null;
  return { start, end };
}
