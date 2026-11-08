// Minimal typing for the parts of the YouTube IFrame API we use.
export interface YTPlayer {
  loadVideoById(args: { videoId: string; startSeconds: number }): void;
  cueVideoById(args: { videoId: string; startSeconds: number }): void;
  getPlayerState(): number;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  pauseVideo(): void;
  playVideo(): void;
  destroy(): void;
}
export interface YTNamespace {
  Player: new (el: HTMLElement, opts: unknown) => YTPlayer;
  PlayerState: { PLAYING: number; PAUSED: number };
}
declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let loading: Promise<YTNamespace> | undefined;

export function loadYouTubeApi(): Promise<YTNamespace> {
  loading ??= new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT);
    window.onYouTubeIframeAPIReady = () => resolve(window.YT!);
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.onerror = () => {
      loading = undefined;
      reject(new Error("YouTube player failed to load"));
    };
    document.head.append(script);
  });
  return loading;
}
