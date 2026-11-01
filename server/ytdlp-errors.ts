// Plain-English yt-dlp failure copy shared by ingest and search.
export const YTDLP_MISSING = "yt-dlp isn't installed — run: brew install yt-dlp";
export const YTDLP_UPGRADE_HINT = " (if this keeps happening, run: brew upgrade yt-dlp)";

const KNOWN_FAILURES: Array<[RegExp, string]> = [
  [/private video|video unavailable/i, "That video is private or unavailable."],
  [/larger than max-filesize/i, "That video is too long/large to add (over 80 MB)."],
  [/ffmpeg|ffprobe/i, "ffmpeg isn't installed — run: brew install ffmpeg"],
];

/** Known causes get a plain message; anything else is yt-dlp's last line plus the upgrade hint. */
export function explainYtDlpFailure(stderr: string, fallback: string): string {
  const known = KNOWN_FAILURES.find(([pattern]) => pattern.test(stderr));
  if (known) return known[1];
  const lines = stderr.trim().split("\n").filter(Boolean);
  const last = lines.length ? lines[lines.length - 1].replace(/^ERROR:\s*/i, "").trim() : "";
  return (last || fallback) + YTDLP_UPGRADE_HINT;
}
