const ID = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtu.be"]);

/** Video id from any YouTube link form (watch, youtu.be, music, shorts, embed, live) or a bare 11-char id; null if none. */
export function parseVideoId(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const text = input.trim();
  if (ID.test(text)) return text;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!HOSTS.has(host)) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  const first = parts[0] ?? "";
  const candidate = host.endsWith("youtu.be") ? first : first === "watch" ? url.searchParams.get("v") : ["shorts", "embed", "live", "v"].includes(first) ? parts[1] : null;
  return candidate && ID.test(candidate) ? candidate : null;
}
