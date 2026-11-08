import type { ReactNode } from "react";

// Layout wrapper: the look styles it into a bezel or a full-bleed row. Nothing here covers the player.
export function PlayerStage({ children }: { children: ReactNode }) {
  return (
    <div className="player-stage">
      <div className="stage">{children}</div>
    </div>
  );
}
