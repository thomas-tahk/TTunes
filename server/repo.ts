import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Track } from "./types.ts";

// Catalog repository (design spec §7): metadata behind an interface so the local
// JSON store below can later be swapped for managed Postgres with no caller changes.
export interface TrackRepo {
  all(): Track[];
  get(id: string): Track | undefined;
  add(track: Track): void;
  remove(id: string): Track | undefined;
}

export class JsonTrackRepo implements TrackRepo {
  private readonly file: string;
  private tracks: Track[];

  constructor(file: string) {
    this.file = file;
    this.tracks = this.load();
  }

  private load(): Track[] {
    if (!existsSync(this.file)) return [];
    return JSON.parse(readFileSync(this.file, "utf8")) as Track[];
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.tracks, null, 2));
  }

  all(): Track[] {
    return [...this.tracks];
  }

  get(id: string): Track | undefined {
    return this.tracks.find((t) => t.id === id);
  }

  add(track: Track): void {
    this.tracks.push(track);
    this.persist();
  }

  remove(id: string): Track | undefined {
    const index = this.tracks.findIndex((t) => t.id === id);
    if (index === -1) return undefined;
    const [removed] = this.tracks.splice(index, 1);
    this.persist();
    return removed;
  }
}
