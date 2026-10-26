import { useCallback, useEffect, useState } from "react";
import type { Track } from "./types.ts";
import { fetchTracks, deleteTrack, checkSession, onUnauthorized, UnauthorizedError } from "./api.ts";
import { usePlayer } from "./usePlayer.ts";
import { Uploader } from "./components/Uploader.tsx";
import { Library } from "./components/Library.tsx";
import { PlayerBar } from "./components/PlayerBar.tsx";
import { NowPlaying } from "./components/NowPlaying.tsx";
import { UpNext } from "./components/UpNext.tsx";
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
  const [tracks, setTracks] = useState<Track[] | null>(null); // null = still loading
  const [tracksError, setTracksError] = useState(false);
  const player = usePlayer();
  const { refresh: refreshStation } = player;

  const refreshTracks = useCallback(async () => {
    try {
      setTracks(await fetchTracks());
      setTracksError(false);
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) setTracksError(true); // 401: the gate already flipped to login
    }
  }, []);

  useEffect(() => {
    void refreshTracks();
  }, [refreshTracks]);

  // New or removed tracks change what the station can play (an empty station cues its first track).
  const onLibraryChanged = useCallback(() => {
    void refreshTracks();
    void refreshStation();
  }, [refreshTracks, refreshStation]);

  const handleDelete = useCallback(
    async (id: string) => {
      const ok = window.confirm("Delete this track from your library and storage? This can't be undone.");
      if (!ok) return;
      try {
        await deleteTrack(id);
      } catch (err) {
        if (!(err instanceof UnauthorizedError)) window.alert("Couldn't delete that track.");
      }
      onLibraryChanged();
    },
    [onLibraryChanged],
  );

  const empty = tracks !== null && tracks.length === 0;

  return (
    <div className={empty ? "app" : "app app--with-bar"}>
      <header className="topbar">
        <h1 className="brand">
          <span className="brand__dot" /> TTunes
        </h1>
        <span className="tagline">your personal station</span>
      </header>

      <main className="content">
        {empty ? (
          <p className="prompt">Your station is empty. Add a few songs and it starts shuffling.</p>
        ) : (
          <NowPlaying player={player} />
        )}
        <Uploader onAdded={onLibraryChanged} />
        {!empty && <UpNext player={player} />}
        {tracksError ? (
          <div className="state state--error" role="alert">
            <span>Couldn't load your library.</span>
            <button className="ctrl" onClick={() => void refreshTracks()}>
              Try again
            </button>
          </div>
        ) : tracks === null ? (
          <p className="state">Loading your library…</p>
        ) : (
          <Library tracks={tracks} player={player} onDelete={handleDelete} />
        )}
      </main>

      {!empty && <PlayerBar player={player} />}

      {/* The station's audio. The second element warms the next track so it starts with no buffering. */}
      <audio ref={player.audioRef} data-role="main" preload="auto" />
      <audio ref={player.prefetchRef} data-role="prefetch" preload="auto" muted />
    </div>
  );
}
