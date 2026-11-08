import { useEffect, useState } from "react";
import { FALLBACK_WASH, type Wash, washFromPixels } from "./wash.ts";

const SIZE = 24;

function readWash(img: HTMLImageElement): Wash | null {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, SIZE, SIZE);
  return washFromPixels(ctx.getImageData(0, 0, SIZE, SIZE).data); // throws if the image tainted the canvas
}

/** Background colours for the song with this id; the fixed magenta/orange/violet look whenever anything goes wrong. */
export function useWash(videoId: string | undefined): Wash {
  const [wash, setWash] = useState<Wash>(FALLBACK_WASH);
  useEffect(() => {
    if (!videoId) return setWash(FALLBACK_WASH);
    let live = true;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        if (live) setWash(readWash(img) ?? FALLBACK_WASH);
      } catch {
        if (live) setWash(FALLBACK_WASH);
      }
    };
    img.onerror = () => live && setWash(FALLBACK_WASH);
    img.src = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    return () => {
      live = false;
    };
  }, [videoId]);
  return wash;
}
