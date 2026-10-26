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
/**
 * When the station has moved to another track but this device is still playing the
 * old one this close to its end, finish it and switch on `ended` instead of cutting
 * the last seconds off (e.g. the server advanced while this device sat in a stall).
 */
const FINISH_TAIL_SEC = 5;
/** Same, for a `stale` answer to this device's own report (it lagged behind the station). */
const FINISH_STALE_SEC = 15;
/** A deferred swap happens anyway this long after the local track should have ended (hung tail). */
const FINISH_GRACE_SEC = 2;
/** Tracks in a row that fail to play before the player stops skipping (every file broken, say). */
const MAX_FAILED_IN_A_ROW = 5;
/** Pressing Play on a paused device re-checks the station first when its view is older than this. */
const STALE_VIEW_MS = 5_000;
/** ...and moves to the station's position when it's this far from where the device paused. */
const RESYNC_DRIFT_SEC = 2;

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
  /** The station's position in its now-playing track right now (moves while it plays). */
  liveOffset: () => number;
}

/** This device is playing (or stalled mid-play) and within `withinSec` of the loaded track's end. */
function finishingLocally(audio: HTMLAudioElement | null, withinSec: number): boolean {
  if (!audio || audio.paused || audio.ended || audio.error || !audio.getAttribute("src")) return false;
  if (!Number.isFinite(audio.duration)) return false;
  return audio.duration - audio.currentTime <= withinSec;
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
  /** A station track this device will switch to on `ended` (see deferSwap), with its deadline. */
  const deferRef = useRef<{ trackId: string; until: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Tracks that failed to play since one last loaded fine (the skip-loop guard). */
  const failedInARowRef = useRef(0);
  /** Where the loaded track started playing from (to tell real playback from a failed start). */
  const loadedAtRef = useRef(0);

  /** Show a message; a `sticky` one stays until the next message or the user acts. */
  const setNotice = useCallback((msg: string, sticky = false) => {
    clearTimeout(noticeTimer.current);
    setNoticeState(msg);
    if (!sticky) noticeTimer.current = setTimeout(() => setNoticeState(null), NOTICE_MS);
  }, []);

  const clearNotice = useCallback(() => {
    clearTimeout(noticeTimer.current);
    setNoticeState(null);
  }, []);

  /** A user action (tap, Next, play now): give the skip-loop guard a fresh start. */
  const resetFailures = useCallback(() => {
    if (failedInARowRef.current >= MAX_FAILED_IN_A_ROW) clearNotice();
    failedInARowRef.current = 0;
  }, [clearNotice]);

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

  /** Station's position for its now-playing track, as of this moment. */
  const liveOffset = useCallback((): number => {
    const np = stationRef.current?.nowPlaying;
    if (!np) return 0;
    let offset = np.offsetSec;
    if (np.playing) offset += (performance.now() - receivedAtRef.current) / 1000;
    return offset;
  }, []);

  const clearDeferral = useCallback(() => {
    clearTimeout(deferRef.current?.timer);
    deferRef.current = null;
  }, []);

  /** Put `track` into the main player at `offsetSec`; `play` starts it immediately. */
  const load = useCallback(
    (track: Track, offsetSec: number, play: boolean) => {
      const audio = audioRef.current;
      if (!audio) return;
      clearDeferral();
      currentRef.current = track;
      setCurrent(track);
      setPosition(offsetSec);
      setDuration(track.durationSec);
      if (!audio.paused) suppressPauseRef.current = true;
      audio.preload = "auto";
      audio.src = audioUrl(track.id);
      // Always set the new track's offset, 0 included: a seek still pending from the
      // previous src (its metadata never arrived) must not carry over to this one.
      // Re-applied on loadedmetadata if it didn't stick.
      pendingSeekRef.current = offsetSec;
      audio.currentTime = offsetSec;
      loadedAtRef.current = offsetSec;
      if (play) void audio.play().catch(onPlayRejected);
    },
    [clearDeferral, onPlayRejected],
  );

  /**
   * The station naturally moved on (to the upNext this device knew) while this device
   * still plays the last seconds of its track: finish them, and `ended` joins the
   * station (onTrackEnded). A deadline swaps anyway if the tail hangs. True = deferring.
   */
  const deferSwap = useCallback(
    (view: StationView, knownUpNextId: string | undefined): boolean => {
      const np = view.nowPlaying;
      const audio = audioRef.current;
      const d = deferRef.current;
      if (!np || !audio) return false;
      const natural = np.track.id === knownUpNextId || d?.trackId === np.track.id;
      if (!natural || !finishingLocally(audio, view.stale ? FINISH_STALE_SEC : FINISH_TAIL_SEC)) return false;
      if (d?.trackId === np.track.id) return performance.now() < d.until;
      clearDeferral();
      const ms = (audio.duration - audio.currentTime + FINISH_GRACE_SEC) * 1000;
      const timer = setTimeout(() => {
        deferRef.current = null;
        const cur = stationRef.current?.nowPlaying;
        const a = audioRef.current;
        if (cur && a && cur.track.id !== currentRef.current?.id) {
          load(cur.track, liveOffset(), startedRef.current && !a.paused);
        }
      }, ms);
      deferRef.current = { trackId: np.track.id, until: performance.now() + ms, timer };
      return true;
    },
    [clearDeferral, liveOffset, load],
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
      const knownUpNextId = stationRef.current?.upNext?.id;
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
        // Keep this device's paused/playing state: a pause here must not start another track.
        if (!deferSwap(view, knownUpNextId)) load(np.track, np.offsetSec, startedRef.current && !!audio && !audio.paused);
      } else {
        currentRef.current = np.track; // same track; pick up any metadata change
        setCurrent(np.track);
      }
      prefetch(view.upNext);
    },
    [deferSwap, load, prefetch],
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

  /** Move to the next track: play the prefetched upNext right away, then tell the station. */
  const advance = useCallback(
    (fromTrackId: string | undefined) => {
      const guess = stationRef.current?.upNext;
      if (guess && startedRef.current) load(guess, 0, true);
      call(() => stationNext(fromTrackId)).catch(() => setNotice("Couldn't reach the station."));
    },
    [call, load, setNotice],
  );

  /**
   * `track` can't be played here (the browser can't decode it): say so and move the
   * station past it, so it never sits silent on a broken file. Before the first tap
   * the station still moves on (the tune-in card then offers a playable track) but
   * nothing starts. After MAX_FAILED_IN_A_ROW failures in a row it stops trying.
   */
  const skipBroken = useCallback(
    (track: Track) => {
      const failed = ++failedInARowRef.current;
      setIsPlaying(false);
      if (failed >= MAX_FAILED_IN_A_ROW) {
        setNotice(`Couldn't play ${failed} tracks in a row, so playback stopped. Tap Next to try again.`, true);
        return;
      }
      setNotice(`Couldn't play ${track.title} — skipping.`);
      const wantPlay = startedRef.current;
      const guess = stationRef.current?.upNext;
      if (wantPlay && guess && guess.id !== track.id) load(guess, 0, true);
      call(() => stationNext(track.id))
        .then(() => {
          // No usable guess (or the station picked another track): start whatever it chose.
          const a = audioRef.current;
          const now = currentRef.current;
          if (wantPlay && a?.paused && now && now.id !== track.id && !a.error) {
            void a.play().then(() => report(true), onPlayRejected);
          }
        })
        .catch(() => setNotice("Couldn't reach the station."));
    },
    [call, load, onPlayRejected, report, setNotice],
  );

  /** The main <audio> failed. A 401 goes to the login screen first; only a file this browser can't play is skipped. */
  const onMediaError = useCallback(() => {
    const audio = audioRef.current;
    const track = currentRef.current;
    if (!audio?.error || !track || audio.getAttribute("src") !== audioUrl(track.id)) return;
    const code = audio.error.code;
    void recheckSession().then((sessionOk) => {
      if (sessionOk !== true) return; // logged out (the gate flipped), or offline: not the file's fault
      if (currentRef.current?.id !== track.id) return; // already moved on
      // Network trouble (code 2) or an abort isn't the file's fault either; decode/unsupported is.
      if (code !== MediaError.MEDIA_ERR_DECODE && code !== MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) return;
      skipBroken(track);
    });
  }, [skipBroken]);

  /** `ended`: if the station already moved on while we finished this track, join it there; else advance. */
  const onTrackEnded = useCallback(() => {
    const ended = currentRef.current?.id;
    const np = stationRef.current?.nowPlaying;
    if (np && ended && np.track.id !== ended && startedRef.current) {
      load(np.track, liveOffset(), np.playing); // don't resume a station another device paused
      return;
    }
    advance(ended);
  }, [advance, liveOffset, load]);

  // The one tap: start the station's track where the station is now. No network
  // round-trip before play() — the track is already loaded and the offset is derived.
  const start = useCallback(() => {
    const np = stationRef.current?.nowPlaying;
    const audio = audioRef.current;
    if (!np || !audio) return;
    markStarted(true);
    resetFailures();
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
    loadedAtRef.current = offset;
    setPosition(offset);
    // Tell the station "playing" only once it really is (an autoplay block must not claim it).
    void audio.play().then(() => report(true), onPlayRejected);
  }, [advance, liveOffset, load, markStarted, onPlayRejected, report, resetFailures]);

  /**
   * Resume a paused device. If its view of the station is fresh, just play and report.
   * If it's stale (the tab sat paused while another device moved on), still call play()
   * inside the tap (iOS needs that), then check the station before reporting: on the same
   * track it jumps to the station's position when that's more than RESYNC_DRIFT_SEC away;
   * on another track adopt swaps to it. Reporting first would drag the station back here.
   */
  const resume = useCallback(
    (audio: HTMLAudioElement) => {
      const playing = audio.play();
      if (performance.now() - receivedAtRef.current <= STALE_VIEW_MS) {
        void playing.then(() => report(true), onPlayRejected);
        return;
      }
      void playing.catch(onPlayRejected);
      const resumedId = currentRef.current?.id;
      call(fetchStation)
        .then((view) => {
          const np = view?.nowPlaying;
          const a = audioRef.current;
          if (!np || !a || np.track.id !== resumedId || currentRef.current?.id !== resumedId) return;
          const live = liveOffset();
          if (Math.abs(a.currentTime - live) <= RESYNC_DRIFT_SEC) return;
          pendingSeekRef.current = live; // our own seek: onSeeked doesn't report it
          a.currentTime = live;
          setPosition(live);
        })
        .catch(() => {}) // offline: carry on from here; the report below is best-effort
        .finally(() => {
          if (audioRef.current && !audioRef.current.paused) report(true);
        });
    },
    [call, liveOffset, onPlayRejected, report],
  );

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!startedRef.current) {
      start();
      return;
    }
    if (audio.paused) {
      resume(audio);
    } else {
      audio.pause(); // the pause listener reports it
    }
  }, [resume, start]);

  const next = useCallback(() => {
    if (!startedRef.current) markStarted(true); // a tap on Next counts as tuning in
    resetFailures();
    advance(currentRef.current?.id);
  }, [advance, markStarted, resetFailures]);

  const seek = useCallback((sec: number) => {
    const audio = audioRef.current;
    if (!audio || !currentRef.current) return;
    pendingSeekRef.current = null; // the user's seek wins over any pending station offset
    audio.currentTime = sec; // the seeked listener reports it
    setPosition(sec);
  }, []);

  const playNow = useCallback(
    (track: Track) => {
      markStarted(true);
      resetFailures();
      load(track, 0, true); // play-now always starts this track from 0, so don't wait for the answer
      call(() => stationPlayNow(track.id)).catch(() => setNotice("Couldn't reach the station."));
    },
    [call, load, markStarted, resetFailures, setNotice],
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
  const handlers = useRef({ onTrackEnded, report, onMediaError });
  useEffect(() => {
    handlers.current = { onTrackEnded, report, onMediaError };
  }, [onTrackEnded, report, onMediaError]);

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
    const onEnded = () => handlers.current.onTrackEnded();
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
    const onTime = () => {
      setPosition(audio.currentTime);
      // A second of real playback: this track works, so the skip-loop guard starts over.
      if (failedInARowRef.current && !audio.paused && audio.currentTime - loadedAtRef.current >= 1) {
        failedInARowRef.current = 0;
      }
    };
    // A load failure may be a 401 (session gone): the auth gate checks first; a file
    // this browser can't play is then skipped (onMediaError).
    const onError = () => handlers.current.onMediaError();
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

  useEffect(
    () => () => {
      clearTimeout(noticeTimer.current);
      clearDeferral();
    },
    [clearDeferral],
  );

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
    liveOffset,
  };
}
