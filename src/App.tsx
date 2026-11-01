import { useCallback, useEffect, useRef, useState } from "react";
import type { Track } from "./types.ts";
import type { AddChoice } from "./addChoice.ts";
import { fetchTracks, deleteTrack } from "./api.ts";
import { addBatch } from "./addChoice.ts";
import { usePlayer } from "./usePlayer.ts";
import { Uploader } from "./components/Uploader.tsx";
import { YouTubeAdd } from "./components/YouTubeAdd.tsx";
import { Library } from "./components/Library.tsx";
import { PlayerBar } from "./components/PlayerBar.tsx";

export default function App() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const controls = usePlayer(tracks);
  const autoStarted = useRef(false);

  const refresh = useCallback(async () => {
    setTracks(await fetchTracks());
  }, []);

  // Latest controls for async callbacks that outlive the render they were created in.
  const controlsRef = useRef(controls);
  controlsRef.current = controls;

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // "Open it and it's playing" — auto-start once tracks first load. Browser
  // autoplay policy may defer this until the first click; the Play control covers that.
  useEffect(() => {
    if (!tracks.length) autoStarted.current = false; // library emptied: auto-start again when re-filled
    if (autoStarted.current || !tracks.length || controls.currentId) return;
    autoStarted.current = true;
    controls.startShuffle();
  }, [tracks, controls]);

  const handleYouTubeAdded = useCallback(
    async (track: Track, choice: AddChoice) => {
      try {
        await refresh();
      } finally {
        controlsRef.current.add(track.id, choice); // track is saved; play/queue it even if the reload failed
      }
    },
    [refresh],
  );

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
        <Uploader onAdded={refresh} onChoose={(ids, choice) => addBatch(ids, choice, controls.add)} />
        <YouTubeAdd onAdded={handleYouTubeAdded} />
        <Library tracks={tracks} controls={controls} onDelete={handleDelete} />
      </main>

      <PlayerBar tracks={tracks} controls={controls} />
    </div>
  );
}
