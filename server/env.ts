/**
 * Boolean env var: 1/true/yes/on or 0/false/no/off (any case, trimmed). Unset or blank
 * gives `fallback`; anything else throws, so a typo fails startup instead of silently
 * meaning false. `name` (the variable) goes in the error message.
 */
export function parseBool(value: string | undefined, fallback: boolean, name?: string): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new Error(`invalid boolean${name ? ` for ${name}` : ""}: ${value} (use true/false, 1/0, yes/no or on/off)`);
}
