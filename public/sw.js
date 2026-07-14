// TTunes service worker — offline playback (design spec: reads only; the page
// writes audio into AUDIO_CACHE). Hand-rolled, no Workbox.
const SHELL_CACHE = "ttunes-shell-v1";
const AUDIO_CACHE = "ttunes-audio-v1"; // MUST match src/offline/useOfflineLibrary.ts
const KEEP = [SHELL_CACHE, AUDIO_CACHE];

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => !KEEP.includes(n)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/audio/")) {
    event.respondWith(serveAudio(request));
  } else if (url.pathname === "/api/tracks") {
    event.respondWith(networkFirst(request, SHELL_CACHE));
  } else if (request.mode === "navigate") {
    event.respondWith(navigateFirst(request));
  } else {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
  }
});

// Cached audio is served locally; Range requests are sliced from the cached file
// so instant-seek playback keeps working offline. mirrors src/offline/range.ts.
async function serveAudio(request) {
  const cache = await caches.open(AUDIO_CACHE);
  const cached = await cache.match(request.url);
  if (!cached) {
    try {
      return await fetch(request); // not downloaded — stream from network if online
    } catch {
      return new Response("Offline and not downloaded", { status: 503 });
    }
  }
  const range = request.headers.get("range");
  if (!range) return cached;

  const buffer = await cached.arrayBuffer();
  const size = buffer.byteLength;
  const parsed = parseRange(range, size);
  if (!parsed) {
    return new Response(cached.body, { status: 200 });
  }
  const { start, end } = parsed;
  const contentType = cached.headers.get("content-type") || "audio/mpeg";
  return new Response(buffer.slice(start, end + 1), {
    status: 206,
    headers: {
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": String(end - start + 1),
      "Content-Type": contentType,
    },
  });
}

function parseRange(rangeHeader, size) {
  const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
  if (!match) return null;
  const hasStart = match[1] !== "";
  const hasEnd = match[2] !== "";
  let start = hasStart ? Number(match[1]) : 0;
  let end = hasEnd ? Number(match[2]) : size - 1;
  if (!hasStart && hasEnd) {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  }
  start = Math.max(0, start);
  end = Math.min(end, size - 1);
  if (Number.isNaN(start) || Number.isNaN(end) || start > end) return null;
  return { start, end };
}

// App shell + catalog: prefer fresh, fall back to cache when offline.
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw new Error("network-first: no cache");
  }
}

async function navigateFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put("/index.html", response.clone());
    return response;
  } catch {
    return (await cache.match("/index.html")) || (await cache.match(request)) || Response.error();
  }
}

// Hashed build assets are immutable — serve from cache, populate on first fetch.
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}
