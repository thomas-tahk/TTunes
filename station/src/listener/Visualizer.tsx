import type { ReactNode } from "react";

const BARS = 9;

function Bars({ side, active }: { side: "top" | "bottom" | "left" | "right"; active: boolean }) {
  return (
    <div className={`bars bars-${side}${active ? " is-live" : ""}`} aria-hidden="true">
      {Array.from({ length: BARS }, (_, i) => (
        <span key={i} style={{ animationDelay: `${((i * 7 + side.length * 3) % 11) * -0.13}s` }} />
      ))}
    </div>
  );
}

// Decorative only: it cannot hear the audio. Bars sit outside the player and never cover it.
export function Visualizer({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div className="visualizer">
      <Bars side="top" active={active} />
      <Bars side="left" active={active} />
      <div className={`stage${active ? " is-live" : ""}`}>{children}</div>
      <Bars side="right" active={active} />
      <Bars side="bottom" active={active} />
    </div>
  );
}
