import { useCallback, useEffect, useRef, useState } from "react";
import type { Track } from "./types.ts";
import { audioUrl } from "./api.ts";

export const QUEUE_CAP = 6; // manual queue stays a "next few", distinct from playlists (spec §5)

function shuffled(ids: string[]): string[] {
  const out = [...ids];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export interface PlayerControls {
  currentId: string | null;
  isPlaying: boolean;
  queue: string[];
  canQueue: boolean;
  playNow: (id: string) => void;
  enqueue: (id: string) => void;
  startShuffle: () => void;
  toggle: () => void;
  next: () => void;
}

// Shuffle + manual-queue + prefetch player. The active pool here is the whole
// library (MVP); filtered channels/playlists bolt on later without changing this.
export function usePlayer(tracks: Track[]): PlayerControls {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const prefetchRef = useRef<HTMLAudioElement | null>(null);
  if (!audioRef.current) audioRef.current = new Audio();
  if (!prefetchRef.current) prefetchRef.current = new Audio();

  const [currentId, setCurrentId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [queue, setQueueState] = useState<string[]>([]);

  const queueRef = useRef<string[]>([]);
  const orderRef = useRef<string[]>([]);
  const posRef = useRef(0);

  const setQueue = useCallback((next: string[]) => {
    queueRef.current = next;
    setQueueState(next);
  }, []);

  // Rebuild the shuffle order when the track set changes.
  useEffect(() => {
    orderRef.current = shuffled(tracks.map((t) => t.id));
    posRef.current = 0;
  }, [tracks]);

  const play = useCallback((id: string) => {
    const audio = audioRef.current!;
    audio.src = audioUrl(id);
    void audio.play().catch(() => setIsPlaying(false));
    setCurrentId(id);
  }, []);

  const nextShuffleId = useCallback((): string | null => {
    const order = orderRef.current;
    if (!order.length) return null;
    return order[(posRef.current + 1) % order.length];
  }, []);

  // Advance: manual queue takes priority, then the shuffle falls through — so
  // the station never goes silent (spec §5).
  const advance = useCallback(() => {
    if (queueRef.current.length) {
      const [head, ...rest] = queueRef.current;
      setQueue(rest);
      play(head);
      return;
    }
    const order = orderRef.current;
    if (!order.length) {
      setIsPlaying(false);
      return;
    }
    posRef.current = (posRef.current + 1) % order.length;
    play(order[posRef.current]);
  }, [play, setQueue]);

  // Keep the "ended" handler pointing at the latest advance without re-binding.
  const advanceRef = useRef(advance);
  useEffect(() => {
    advanceRef.current = advance;
  }, [advance]);

  useEffect(() => {
    const audio = audioRef.current!;
    const onEnded = () => advanceRef.current();
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    return () => {
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
    };
  }, []);

  // Warm the next track so playback starts instantly with no buffer (spec §5).
  useEffect(() => {
    const upcoming = queueRef.current[0] ?? nextShuffleId();
    if (!upcoming) return;
    const pf = prefetchRef.current!;
    pf.src = audioUrl(upcoming);
    pf.preload = "auto";
    pf.load();
  }, [currentId, queue, nextShuffleId]);

  const playNow = useCallback((id: string) => play(id), [play]);

  const enqueue = useCallback(
    (id: string) => {
      if (!currentId) {
        play(id);
        return;
      }
      if (queueRef.current.length >= QUEUE_CAP) return;
      setQueue([...queueRef.current, id]);
    },
    [currentId, play, setQueue],
  );

  const startShuffle = useCallback(() => {
    const order = orderRef.current;
    if (!order.length) return;
    posRef.current = 0;
    play(order[0]);
  }, [play]);

  const toggle = useCallback(() => {
    const audio = audioRef.current!;
    if (audio.paused) void audio.play().catch(() => {});
    else audio.pause();
  }, []);

  return {
    currentId,
    isPlaying,
    queue,
    canQueue: queue.length < QUEUE_CAP,
    playNow,
    enqueue,
    startShuffle,
    toggle,
    next: advance,
  };
}
