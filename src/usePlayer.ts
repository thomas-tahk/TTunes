import { useCallback, useEffect, useRef, useState } from "react";
import type { Track } from "./types.ts";
import { audioUrl } from "./api.ts";
import type { AddChoice } from "./addChoice.ts";
import { addMany as addManyStation, advance as advanceStation, emptyStation, peekNext, playNow as playNowStation, queueLast, sync, type Station } from "./station.ts";

export interface PlayerControls {
  currentId: string | null;
  isPlaying: boolean;
  queue: string[];
  playNow: (id: string) => void;
  enqueue: (id: string) => void;
  /** Play or queue tracks the user just added, in drop order. */
  addMany: (ids: string[], choice: AddChoice) => void;
  /** Play or queue one track the user just added. */
  add: (id: string, choice: AddChoice) => void;
  startShuffle: () => void;
  toggle: () => void;
  next: () => void;
}

// Thin audio-element wrapper: all shuffle/queue decisions live in station.ts.
export function usePlayer(tracks: Track[]): PlayerControls {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const prefetchRef = useRef<HTMLAudioElement | null>(null);
  if (!audioRef.current) audioRef.current = new Audio();
  if (!prefetchRef.current) prefetchRef.current = new Audio();

  const [currentId, setCurrentId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [queue, setQueueState] = useState<string[]>([]);

  const stationRef = useRef<Station>(emptyStation());
  const libraryRef = useRef<string[]>([]);
  const failuresRef = useRef(0);

  const commit = useCallback((station: Station) => {
    stationRef.current = station;
    setQueueState(station.queue);
  }, []);

  // Library changed: reconcile only. Never touches the playing song or the cycle position.
  useEffect(() => {
    libraryRef.current = tracks.map((t) => t.id);
    commit(sync(stationRef.current, libraryRef.current, Math.random));
    if (libraryRef.current.length) return;
    const audio = audioRef.current!;
    audio.pause();
    audio.removeAttribute("src");
    setCurrentId(null);
  }, [tracks, commit]);

  const play = useCallback((id: string) => {
    const audio = audioRef.current!;
    audio.src = audioUrl(id);
    void audio.play().catch(() => setIsPlaying(false));
    setCurrentId(id);
  }, []);

  // Queue first, then the shuffle falls through — the station never goes silent.
  const advance = useCallback(() => {
    const step = advanceStation(stationRef.current, libraryRef.current, Math.random);
    commit(step.station);
    if (step.id) play(step.id);
    else setIsPlaying(false);
  }, [play, commit]);

  // Keep the "ended" handler pointing at the latest advance without re-binding.
  const advanceRef = useRef(advance);
  useEffect(() => {
    advanceRef.current = advance;
  }, [advance]);

  useEffect(() => {
    const audio = audioRef.current!;
    const onEnded = () => advanceRef.current();
    // An unplayable/deleted file must not silence the station; give up only if every track fails in a row.
    const onError = () => {
      failuresRef.current += 1;
      if (failuresRef.current <= libraryRef.current.length) advanceRef.current();
      else setIsPlaying(false);
    };
    const onPlaying = () => (failuresRef.current = 0);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);
    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    return () => {
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
    };
  }, []);

  // Warm the next track so playback starts instantly with no buffer (spec §5).
  useEffect(() => {
    const upcoming = peekNext(stationRef.current, libraryRef.current);
    if (!upcoming) return;
    const pf = prefetchRef.current!;
    pf.src = audioUrl(upcoming);
    pf.preload = "auto";
    pf.load();
  }, [currentId, queue, tracks]);

  const playNow = useCallback(
    (id: string) => {
      commit(playNowStation(stationRef.current, id));
      play(id);
    },
    [play, commit],
  );

  const addMany = useCallback(
    (ids: string[], choice: AddChoice) => {
      const before = stationRef.current.current;
      const after = addManyStation(stationRef.current, ids, choice);
      commit(after);
      if (after.current && after.current !== before) play(after.current);
    },
    [play, commit],
  );

  const add = useCallback((id: string, choice: AddChoice) => addMany([id], choice), [addMany]);

  const enqueue = useCallback(
    (id: string) => {
      if (!stationRef.current.current) return add(id, "last");
      commit(queueLast(stationRef.current, id));
    },
    [add, commit],
  );

  const toggle = useCallback(() => {
    const audio = audioRef.current!;
    if (audio.paused) void audio.play().catch(() => {});
    else audio.pause();
  }, []);

  return {
    currentId,
    isPlaying,
    queue,
    playNow,
    enqueue,
    addMany,
    add,
    startShuffle: advance,
    toggle,
    next: advance,
  };
}
