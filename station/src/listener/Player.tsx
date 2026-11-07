import { useEffect, useRef, useState } from "react";
import type { NowPlaying, Song } from "../../lib/schedule.ts";
import { MAX_DRIFT_SEC } from "./timing.ts";
import { loadYouTubeApi, type YTPlayer } from "./youtube.ts";

const UNPLAYABLE = [101, 150]; // owner disallows embedding

interface Props {
  playing: NowPlaying;
  serverTime: () => number;
}

interface Target {
  song: Song;
  startedAt: number; // server epoch ms
}

// Mounted by the Play click, so the browser lets it start with sound. Always visible and unobstructed (YouTube policy).
export function Player({ playing, serverTime }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const player = useRef<YTPlayer>(undefined);
  const [notice, setNotice] = useState<string | null>(null);
  const [local, setLocal] = useState<{ forVideoId: string; target: Target } | null>(null);
  const current = playing.current!;
  const target: Target =
    local && local.forVideoId === current.videoId ? local.target : { song: current, startedAt: playing.startedAt! };
  const latest = useRef({ target, playing, serverTime });
  latest.current = { target, playing, serverTime };

  const expectedSec = () => {
    const { target: t, serverTime: now } = latest.current;
    return Math.min(t.song.durationSec, Math.max(0, (now() - t.startedAt) / 1000));
  };

  const correctDrift = () => {
    const p = player.current;
    if (p && Math.abs(p.getCurrentTime() - expectedSec()) > MAX_DRIFT_SEC) p.seekTo(expectedSec(), true);
  };

  // Error 101/150: play the next song from its start instead, until the server's own schedule catches up.
  const skipUnplayable = () => {
    const { target: t, playing: p, serverTime: now } = latest.current;
    const next = p.next;
    setNotice(`"${t.song.title}" can't be embedded here, so it was skipped.`);
    if (!next || t.song.videoId !== p.current!.videoId) return;
    setLocal({ forVideoId: p.current!.videoId, target: { song: next, startedAt: now() } });
  };

  useEffect(() => {
    let dead = false;
    loadYouTubeApi()
      .then((YT) => {
        if (dead || !host.current) return;
        const el = document.createElement("div");
        host.current.replaceChildren(el);
        const created: YTPlayer = new YT.Player(el, {
          width: "100%",
          height: "100%",
          videoId: latest.current.target.song.videoId,
          playerVars: { autoplay: 1, playsinline: 1, rel: 0, enablejsapi: 1, origin: location.origin, start: Math.floor(expectedSec()) },
          events: {
            onReady: () => {
              player.current = created; // methods only exist once ready
              syncToTarget();
            },
            onStateChange: (e: { data: number }) => e.data === YT.PlayerState.PLAYING && correctDrift(),
            onError: (e: { data: number }) => UNPLAYABLE.includes(e.data) && skipUnplayable(),
          },
        });
        window.__ttunes = { currentTime: () => player.current?.getCurrentTime() ?? 0, videoId: () => latest.current.target.song.videoId };
      })
      .catch(() => setNotice("The YouTube player could not load. Check your connection and reload."));
    return () => {
      dead = true;
      player.current?.destroy();
      player.current = undefined;
    };
  }, []);

  // A new video loads at its position; the same video just re-aligns.
  const loaded = useRef(target.song.videoId);
  const syncToTarget = () => {
    const p = player.current;
    const { target: t } = latest.current;
    if (!p) return;
    if (loaded.current === t.song.videoId) return correctDrift();
    loaded.current = t.song.videoId;
    p.loadVideoById({ videoId: t.song.videoId, startSeconds: expectedSec() });
  };
  useEffect(() => {
    if (!local) setNotice(null);
    syncToTarget();
  }, [target.song.videoId, target.startedAt]);

  return (
    <>
      <div className="player-frame">
        <div ref={host} className="player-host" />
      </div>
      {notice && <p role="status" className="notice">{notice}</p>}
    </>
  );
}

declare global {
  interface Window {
    __ttunes?: { currentTime: () => number; videoId: () => string }; // read by the e2e test only
  }
}
