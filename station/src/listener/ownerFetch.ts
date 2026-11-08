export interface Reply {
  status: number;
  body: Record<string, unknown>;
}

export async function call(method: string, path: string, body?: object): Promise<Reply> {
  const res = await fetch(path, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

export const messageOf = (body: Record<string, unknown>): string => (typeof body.error === "string" ? body.error : "Something went wrong. Try again.");
export const NETWORK_MESSAGE = "Couldn't reach the station. Try again.";

export function minutes(sec: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(sec / 3600);
  return h ? `${h}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}` : `${Math.floor(sec / 60)}:${pad(sec % 60)}`;
}
