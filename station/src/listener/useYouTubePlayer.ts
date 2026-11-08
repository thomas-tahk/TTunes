import { useEffect, useRef, type RefObject } from "react";
import { MAX_DRIFT_SEC } from "./timing.ts";
import { loadYouTubeApi, type YTPlayer } from "./youtube.ts";

const UNPLAYABLE = [101, 150]; // owner disallows embedding

interface Input {
  videoId: string;
  startedAt: number;
  expectedSec: () => number;
  onUnplayable: () => void;
  onLoadFailed: () => void;
  onPausedChange: (paused: boolean) => void;
}

/** Owns one YouTube player inside `host`: loads it, follows the target, keeps it within MAX_DRIFT_SEC, destroys it on unmount. */
export function useYouTubePlayer(host: RefObject<HTMLDivElement | null>, input: Input) {
  const latest = useRef(input);
  latest.current = input;
  const player = useRef<YTPlayer>(undefined);
  const loaded = useRef(input.videoId);

  const correctDrift = () => {
    const p = player.current;
    const expected = latest.current.expectedSec();
    if (p && Math.abs(p.getCurrentTime() - expected) > MAX_DRIFT_SEC) p.seekTo(expected, true);
  };

  // A new video loads at its position; the same video just re-aligns.
  const syncToTarget = () => {
    const p = player.current;
    const { videoId, expectedSec } = latest.current;
    if (!p) return;
    if (loaded.current === videoId) return correctDrift();
    loaded.current = videoId;
    p.loadVideoById({ videoId, startSeconds: expectedSec() });
  };

  useEffect(() => {
    let dead = false;
    let created: YTPlayer | undefined;
    loadYouTubeApi()
      .then((YT) => {
        if (dead || !host.current) return;
        const el = document.createElement("div");
        host.current.replaceChildren(el);
        created = new YT.Player(el, {
          width: "100%",
          height: "100%",
          videoId: latest.current.videoId,
          playerVars: { autoplay: 1, playsinline: 1, rel: 0, enablejsapi: 1, origin: location.origin, start: Math.floor(latest.current.expectedSec()) },
          events: {
            onReady: () => {
              if (dead) return;
              player.current = created; // methods only exist once ready
              syncToTarget();
            },
            onStateChange: (e: { data: number }) => {
              if (e.data === YT.PlayerState.PAUSED) latest.current.onPausedChange(true);
              if (e.data !== YT.PlayerState.PLAYING) return;
              latest.current.onPausedChange(false);
              correctDrift();
            },
            onError: (e: { data: number }) => !dead && UNPLAYABLE.includes(e.data) && latest.current.onUnplayable(),
          },
        });
        if (import.meta.env.DEV) {
          window.__ttunes = { currentTime: () => player.current?.getCurrentTime() ?? 0, videoId: () => latest.current.videoId };
        }
      })
      .catch(() => !dead && latest.current.onLoadFailed());
    return () => {
      dead = true;
      created?.destroy();
      player.current = undefined;
    };
  }, []);

  useEffect(syncToTarget, [input.videoId, input.startedAt]);
}

declare global {
  interface Window {
    __ttunes?: { currentTime: () => number; videoId: () => string }; // dev builds only; read by the e2e test
  }
}
