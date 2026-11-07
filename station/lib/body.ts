import type { IncomingMessage } from "node:http";

/** JSON request body (Vercel may have parsed it already; Vite dev and tests have not). Non-object bodies give {}. */
export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = (req as { body?: unknown }).body; // Vercel parses lazily: a getter that throws on malformed JSON
  } catch {
    return {};
  }
  if (parsed !== undefined) return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
