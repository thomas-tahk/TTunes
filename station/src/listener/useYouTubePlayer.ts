import { useEffect, useRef, type RefObject } from "react";
import { nextPauseState, planSync, shouldSeekToLive, type LiveSettle, type PauseEvent, type PauseState } from "./syncPlan.ts";
import { MAX_DRIFT_SEC } from "./timing.ts";
import { loadYouTubeApi, type YTPlayer } from "./youtube.ts";

const UNPLAYABLE = [101, 150]; // owner disallows embedding

interface Input {
  videoId: string;
  startedAt: number;
  isLocalStart: boolean;
  expectedSec: () => number;
  onUnplayable: () => void;
  onLoadFailed: () => void;
  onPausedChange: (paused: boolean) => void;
}

/** Owns one YouTube player inside `host`: loads it, follows the target, corrects drift once when the player becomes ready (loose playback after that), destroys it on unmount. */
export function useYouTubePlayer(host: RefObject<HTMLDivElement | null>, input: Input) {
  const latest = useRef(input);
  latest.current = input;
  const player = useRef<YTPlayer>(undefined);
  const loaded = useRef(input.videoId);
  const syncedStart = useRef(input.startedAt);
  const syncedLocal = useRef(input.isLocalStart);
  // A pause or seek made before a song's first PLAYING is overridden by settle: a song that hasn't started begins at live. Intended.
  const settle = useRef<LiveSettle>({ pending: true, forced: false }); // the first PLAYING after mount or one of our loads lands on live; later pauses and seeks are the listener's
  const pause = useRef<PauseState>({ listenerPaused: false, loading: false, buffering: false }); // the listener's pause, not YouTube's own PAUSED while it swaps a video
  const step = (event: PauseEvent) => { pause.current = nextPauseState(pause.current, event); };

  const correctDrift = () => {
    const p = player.current;
    const expected = latest.current.expectedSec();
    if (p && Math.abs(p.getCurrentTime() - expected) > MAX_DRIFT_SEC) p.seekTo(expected, true);
  };

  // Live position only at the start (Play/ready) and when a new song starts; otherwise the listener's pause and seek stand.
  const syncToTarget = () => {
    const p = player.current;
    const { videoId, startedAt, isLocalStart, expectedSec } = latest.current;
    if (!p) return;
    const ended = p.getPlayerState() === window.YT?.PlayerState.ENDED;
    const action = planSync({ loadedVideoId: loaded.current, syncedStartedAt: syncedStart.current, wasLocalStart: syncedLocal.current }, { videoId, startedAt, isLocalStart }, { listenerPaused: pause.current.listenerPaused, ended });
    loaded.current = videoId;
    syncedStart.current = startedAt;
    syncedLocal.current = isLocalStart;
    if (action === "drift") correctDrift();
    if (action === "load" || action === "cue") step(action);
    if (action === "load") settle.current = { pending: true, forced: false };
    if (action === "load") p.loadVideoById({ videoId, startSeconds: expectedSec() });
    if (action === "cue") {
      settle.current = { pending: true, forced: true }; // the first PLAYING after a cue is the listener pressing play: start at live
      p.cueVideoById({ videoId, startSeconds: expectedSec() });
    }
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
              if (e.data === YT.PlayerState.PAUSED) {
                step("paused");
                if (pause.current.listenerPaused) latest.current.onPausedChange(true);
              }
              if (e.data === YT.PlayerState.CUED) step("cued");
              if (e.data === YT.PlayerState.BUFFERING) step("buffering");
              if (e.data === -1) { // UNSTARTED: after BUFFERING with our load pending, YouTube's way of reporting a pause that came mid-buffer (it sends no PAUSED)
                step("unstarted");
                if (pause.current.listenerPaused) latest.current.onPausedChange(true);
              }
              if (e.data !== YT.PlayerState.PLAYING) return;
              step("playing");
              latest.current.onPausedChange(false);
              if (!settle.current.pending) return;
              const { forced } = settle.current;
              settle.current = { pending: false, forced: false };
              const expected = latest.current.expectedSec();
              if (shouldSeekToLive(player.current?.getCurrentTime() ?? expected, expected, forced)) player.current?.seekTo(expected, true);
            },
            onError: (e: { data: number }) => {
              step("error");
              if (!dead && UNPLAYABLE.includes(e.data)) latest.current.onUnplayable();
            },
          },
        });
        if (import.meta.env.DEV) {
          window.__ttunes = {
            currentTime: () => player.current?.getCurrentTime() ?? 0,
            videoId: () => latest.current.videoId,
            pause: () => player.current?.pauseVideo(),
            play: () => player.current?.playVideo(),
            seekTo: (sec) => player.current?.seekTo(sec, true),
          };
        }
      })
      .catch(() => !dead && latest.current.onLoadFailed());
    return () => {
      dead = true;
      created?.destroy();
      player.current = undefined;
    };
  }, []);

  // Only a changed target re-syncs; the first run (mount) is a no-op until the player is ready.
  useEffect(() => syncToTarget(), [input.videoId, input.startedAt]);
}

declare global {
  interface Window {
    __ttunes?: { currentTime: () => number; videoId: () => string; pause: () => void; play: () => void; seekTo: (sec: number) => void }; // dev builds only; read by the e2e test
  }
}
