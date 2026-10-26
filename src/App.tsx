import { useCallback, useEffect, useRef, useState } from "react";
import type { Track } from "./types.ts";
import { fetchTracks, deleteTrack, checkSession, onUnauthorized, UnauthorizedError } from "./api.ts";
import { usePlayer } from "./usePlayer.ts";
import { Uploader } from "./components/Uploader.tsx";
import { Library } from "./components/Library.tsx";
import { PlayerBar } from "./components/PlayerBar.tsx";
import { Login } from "./components/Login.tsx";

// Auth gate: ask the server whether we have a session; show the password screen
// on 401 — at load, or whenever an api call / audio load hits 401 mid-session.
export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  useEffect(() => {
    onUnauthorized(() => setAuthed(false));
    checkSession().then(setAuthed, () => setAuthed(false));
  }, []);
  if (authed === null) return null;
  if (!authed) return <Login onSuccess={() => setAuthed(true)} />;
  return <Station />;
}

function Station() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const controls = usePlayer(tracks);
  const autoStarted = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setTracks(await fetchTracks());
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) throw err; // 401: the gate already flipped to login
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // "Open it and it's playing" — auto-start once tracks first load. Browser
  // autoplay policy may defer this until the first click; the Play control covers that.
  useEffect(() => {
    if (autoStarted.current || !tracks.length || controls.currentId) return;
    autoStarted.current = true;
    controls.startShuffle();
  }, [tracks, controls]);

  const handleDelete = useCallback(
    async (id: string) => {
      const ok = window.confirm("Delete this track from your library and storage? This can't be undone.");
      if (!ok) return;
      await deleteTrack(id);
      void refresh();
    },
    [refresh],
  );

  return (
    <div className="app">
      <header className="topbar">
        <h1 className="brand">
          <span className="brand__dot" /> TTunes
        </h1>
        <span className="tagline">your personal station</span>
      </header>

      <main className="content">
        <Uploader onAdded={refresh} />
        <Library tracks={tracks} controls={controls} onDelete={handleDelete} />
      </main>

      <PlayerBar tracks={tracks} controls={controls} />
    </div>
  );
}
