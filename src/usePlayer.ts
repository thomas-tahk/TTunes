import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { StationView, Track } from "./types.ts";
import {
  QueueFullError,
  UnauthorizedError,
  audioUrl,
  fetchStation,
  recheckSession,
  reportNowPlaying,
  stationDequeue,
  stationEnqueue,
  stationNext,
  stationPlayNow,
} from "./api.ts";

/** How often a playing device tells the station where it is. */
const REPORT_EVERY_MS = 10_000;
const NOTICE_MS = 4_000;

export type LoadState = "loading" | "error" | "ready";

export interface PlayerControls {
  /** Attach to the main <audio> and the hidden prefetch <audio>. */
  audioRef: RefObject<HTMLAudioElement | null>;
  prefetchRef: RefObject<HTMLAudioElement | null>;
  loadState: LoadState;
  station: StationView | null;
  /** The track loaded in this device's player (normally the station's now playing). */
  current: Track | null;
  /** This device has been tapped into playing (browsers block sound before a tap). */
  started: boolean;
  isPlaying: boolean;
  position: number;
  duration: number | null;
  /** Short-lived message for the user ("Queue is full", network trouble). */
  notice: string | null;
  canQueue: boolean;
  start: () => void;
  toggle: () => void;
  next: () => void;
  seek: (sec: number) => void;
  playNow: (track: Track) => void;
  enqueue: (trackId: string) => void;
  dequeue: (index: number, trackId: string) => void;
  refresh: () => Promise<void>;
}

/**
 * The player follows the server-owned station (server/station.ts): it loads the
 * station's now-playing track at its offset, reports position back, and asks the
 * station what's next. Every station response is adopted; the audio source only
 * changes when the station's track id differs from what's loaded.
 */
export function usePlayer(): PlayerControls {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const prefetchRef = useRef<HTMLAudioElement | null>(null);

  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [station, setStation] = useState<StationView | null>(null);
  const [current, setCurrent] = useState<Track | null>(null);
  const [started, setStarted] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState<number | null>(null);
  const [notice, setNoticeState] = useState<string | null>(null);

  const stationRef = useRef<StationView | null>(null);
  const receivedAtRef = useRef(0); // performance.now() when stationRef arrived
  const currentRef = useRef<Track | null>(null);
  const startedRef = useRef(false);
  const pendingSeekRef = useRef<number | null>(null);
  const suppressPauseRef = useRef(false); // a pause caused by switching src isn't a user pause
  const seqRef = useRef(0);
  const adoptedSeqRef = useRef(0);
  const prefetchIdRef = useRef<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const setNotice = useCallback((msg: string) => {
    clearTimeout(noticeTimer.current);
    setNoticeState(msg);
    noticeTimer.current = setTimeout(() => setNoticeState(null), NOTICE_MS);
  }, []);

  const markStarted = useCallback((value: boolean) => {
    startedRef.current = value;
    setStarted(value);
  }, []);

  const onPlayRejected = useCallback(
    (err: unknown) => {
      const name = (err as { name?: string } | null)?.name;
      if (name === "AbortError") return; // src changed under a pending play(); the new one plays
      setIsPlaying(false);
      // Autoplay blocked: show the big play button again so one tap starts it.
      if (name === "NotAllowedError") markStarted(false);
    },
    [markStarted],
  );

  /** Put `track` into the main player at `offsetSec`; `play` starts it immediately. */
  const load = useCallback(
    (track: Track, offsetSec: number, play: boolean) => {
      const audio = audioRef.current;
      if (!audio) return;
      currentRef.current = track;
      setCurrent(track);
      setPosition(offsetSec);
      setDuration(track.durationSec);
      if (!audio.paused) suppressPauseRef.current = true;
      audio.preload = "auto";
      audio.src = audioUrl(track.id);
      pendingSeekRef.current = offsetSec > 0 ? offsetSec : null;
      if (offsetSec > 0) audio.currentTime = offsetSec; // re-applied on loadedmetadata if it didn't stick
      if (play) void audio.play().catch(onPlayRejected);
    },
    [onPlayRejected],
  );

  const prefetch = useCallback((track: Track | null) => {
    const pf = prefetchRef.current;
    if (!pf || !track || prefetchIdRef.current === track.id) return;
    prefetchIdRef.current = track.id;
    pf.preload = "auto";
    pf.src = audioUrl(track.id);
    pf.load();
  }, []);

  /** Make a station response the truth. Responses older than one already adopted are dropped. */
  const adopt = useCallback(
    (view: StationView, seq: number) => {
      if (seq < adoptedSeqRef.current) return;
      adoptedSeqRef.current = seq;
      stationRef.current = view;
      receivedAtRef.current = performance.now();
      setStation(view);

      const np = view.nowPlaying;
      const audio = audioRef.current;
      if (!np) {
        if (currentRef.current && audio) {
          audio.pause();
          audio.removeAttribute("src");
          audio.load();
        }
        currentRef.current = null;
        setCurrent(null);
      } else if (np.track.id !== currentRef.current?.id) {
        load(np.track, np.offsetSec, startedRef.current);
      } else {
        currentRef.current = np.track; // same track; pick up any metadata change
        setCurrent(np.track);
      }
      prefetch(view.upNext);
    },
    [load, prefetch],
  );

  /** Run a station request and adopt its answer. 401s are handled by the login gate. */
  const call = useCallback(
    async (work: () => Promise<StationView>): Promise<StationView | null> => {
      const seq = ++seqRef.current;
      try {
        const view = await work();
        adopt(view, seq);
        return view;
      } catch (err) {
        if (err instanceof UnauthorizedError) return null;
        throw err;
      }
    },
    [adopt],
  );

  const report = useCallback(
    (playing: boolean, offsetSec?: number) => {
      const track = currentRef.current;
      const audio = audioRef.current;
      if (!track || !audio || !startedRef.current) return;
      const offset = Math.max(0, offsetSec ?? audio.currentTime);
      call(() => reportNowPlaying({ trackId: track.id, offsetSec: offset, playing, fromTrackId: track.id })).catch(
        () => {}, // position reports are best-effort; the next one catches up
      );
    },
    [call],
  );

  const refresh = useCallback(async () => {
    try {
      await call(fetchStation);
      setLoadState("ready");
    } catch {
      setLoadState((s) => (s === "ready" ? s : "error"));
    }
  }, [call]);

  /** Station's position for its now-playing track, as of this moment. */
  const liveOffset = useCallback((): number => {
    const np = stationRef.current?.nowPlaying;
    if (!np) return 0;
    let offset = np.offsetSec;
    if (np.playing) offset += (performance.now() - receivedAtRef.current) / 1000;
    return offset;
  }, []);

  /** Move to the next track: play the prefetched upNext right away, then tell the station. */
  const advance = useCallback(
    (fromTrackId: string | undefined) => {
      const guess = stationRef.current?.upNext;
      if (guess && startedRef.current) load(guess, 0, true);
      call(() => stationNext(fromTrackId)).catch(() => setNotice("Couldn't reach the station."));
    },
    [call, load, setNotice],
  );

  // The one tap: start the station's track where the station is now. No network
  // round-trip before play() — the track is already loaded and the offset is derived.
  const start = useCallback(() => {
    const np = stationRef.current?.nowPlaying;
    const audio = audioRef.current;
    if (!np || !audio) return;
    markStarted(true);
    const offset = liveOffset();
    const dur = np.track.durationSec;
    if (dur != null && offset >= dur - 0.5) {
      // It ran out while the page sat open: unlock the player in this tap, then move on.
      void audio.play().catch(() => {});
      advance(np.track.id);
      return;
    }
    if (currentRef.current?.id !== np.track.id) load(np.track, offset, false);
    pendingSeekRef.current = offset;
    audio.currentTime = offset;
    setPosition(offset);
    void audio.play().catch(onPlayRejected);
    report(true, offset);
  }, [advance, liveOffset, load, markStarted, onPlayRejected, report]);

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!startedRef.current) {
      start();
      return;
    }
    if (audio.paused) {
      void audio.play().catch(onPlayRejected);
      report(true);
    } else {
      audio.pause(); // the pause listener reports it
    }
  }, [onPlayRejected, report, start]);

  const next = useCallback(() => {
    if (!startedRef.current) markStarted(true); // a tap on Next counts as tuning in
    advance(currentRef.current?.id);
  }, [advance, markStarted]);

  const seek = useCallback((sec: number) => {
    const audio = audioRef.current;
    if (!audio || !currentRef.current) return;
    audio.currentTime = sec; // the seeked listener reports it
    setPosition(sec);
  }, []);

  const playNow = useCallback(
    (track: Track) => {
      markStarted(true);
      load(track, 0, true); // play-now always starts this track from 0, so don't wait for the answer
      call(() => stationPlayNow(track.id)).catch(() => setNotice("Couldn't reach the station."));
    },
    [call, load, markStarted, setNotice],
  );

  const enqueue = useCallback(
    (trackId: string) => {
      call(() => stationEnqueue(trackId)).catch((err) => {
        if (err instanceof QueueFullError) {
          setNotice(`Queue is full (${stationRef.current?.queueCap ?? 6} max).`);
          void refresh();
        } else setNotice("Couldn't add to the queue.");
      });
    },
    [call, refresh, setNotice],
  );

  const dequeue = useCallback(
    (index: number, trackId: string) => {
      call(() => stationDequeue(index, trackId)).catch(() => {
        setNotice("The queue changed; here's the latest.");
        void refresh();
      });
    },
    [call, refresh, setNotice],
  );

  // First load, and re-sync when the page comes back while nothing plays here
  // (e.g. you were listening on another device).
  useEffect(() => {
    void refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible" && audioRef.current?.paused) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  // Audio element events. Handlers read refs, so they bind once.
  const handlers = useRef({ advance, report });
  useEffect(() => {
    handlers.current = { advance, report };
  }, [advance, report]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onPlay = () => setIsPlaying(true);
    const onPlaying = () => {
      suppressPauseRef.current = false;
      setIsPlaying(true);
    };
    const onPause = () => {
      setIsPlaying(false);
      if (audio.ended || suppressPauseRef.current) return;
      handlers.current.report(false);
    };
    const onEnded = () => handlers.current.advance(currentRef.current?.id);
    const onSeeked = () => {
      const want = pendingSeekRef.current;
      pendingSeekRef.current = null;
      if (want !== null && Math.abs(audio.currentTime - want) < 0.5) return; // our own seek to the station offset
      if (startedRef.current) handlers.current.report(!audio.paused);
    };
    const onMeta = () => {
      if (Number.isFinite(audio.duration)) setDuration(audio.duration);
      const want = pendingSeekRef.current;
      if (want !== null && Math.abs(audio.currentTime - want) > 0.25) audio.currentTime = want;
    };
    const onTime = () => setPosition(audio.currentTime);
    const onError = () => {
      // A load failure may be a 401 (session gone) — let the auth gate check.
      if (audio.getAttribute("src")) recheckSession();
    };
    const events: [string, () => void][] = [
      ["play", onPlay],
      ["playing", onPlaying],
      ["pause", onPause],
      ["ended", onEnded],
      ["seeked", onSeeked],
      ["loadedmetadata", onMeta],
      ["timeupdate", onTime],
      ["error", onError],
    ];
    for (const [name, fn] of events) audio.addEventListener(name, fn);
    return () => {
      for (const [name, fn] of events) audio.removeEventListener(name, fn);
      audio.pause(); // player unmounted (e.g. back to the login screen): stop playback
    };
  }, []);

  // Tell the station where we are while playing.
  useEffect(() => {
    if (!isPlaying) return;
    const id = setInterval(() => handlers.current.report(true), REPORT_EVERY_MS);
    return () => clearInterval(id);
  }, [isPlaying]);

  // Lock-screen / notification controls.
  const mediaHandlers = useRef({ toggle, next });
  useEffect(() => {
    mediaHandlers.current = { toggle, next };
  }, [toggle, next]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    const set = (action: MediaSessionAction, fn: MediaSessionActionHandler | null) => {
      try {
        ms.setActionHandler(action, fn);
      } catch {
        // action not supported by this browser
      }
    };
    set("play", () => {
      if (audioRef.current?.paused) mediaHandlers.current.toggle();
    });
    set("pause", () => {
      if (!audioRef.current?.paused) mediaHandlers.current.toggle();
    });
    set("nexttrack", () => mediaHandlers.current.next());
    return () => {
      for (const a of ["play", "pause", "nexttrack"] as const) set(a, null);
    };
  }, []);

  useEffect(() => {
    if (!("mediaSession" in navigator) || typeof MediaMetadata === "undefined") return;
    navigator.mediaSession.metadata = current
      ? new MediaMetadata({ title: current.title, artist: current.artist, album: current.album ?? "TTunes" })
      : null;
  }, [current]);

  useEffect(() => {
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
  }, [isPlaying]);

  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  return {
    audioRef,
    prefetchRef,
    loadState,
    station,
    current,
    started,
    isPlaying,
    position,
    duration,
    notice,
    canQueue: station ? station.queue.length < station.queueCap : false,
    start,
    toggle,
    next,
    seek,
    playNow,
    enqueue,
    dequeue,
    refresh,
  };
}
