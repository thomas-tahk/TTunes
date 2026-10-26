import { describe, expect, it } from "vitest";
import { cleanText } from "../audio-metadata.ts";

describe("cleanText", () => {
  it("strips NUL and other C0 controls plus DEL, then trims", () => {
    expect(cleanText("  A\u0000B\u0001C\u001fD\u007fE\t\n ")).toBe("ABCDE");
  });
  it("keeps printable non-ASCII text as is", () => {
    expect(cleanText("Ünïcødé — 日本語 ✓")).toBe("Ünïcødé — 日本語 ✓");
  });
  it("turns empty, whitespace-only, control-only and missing values into null", () => {
    for (const v of ["", "   ", "\u0000\u0000", null, undefined]) expect(cleanText(v)).toBeNull();
  });
});
