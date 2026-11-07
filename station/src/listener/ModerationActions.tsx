import type { Action } from "./useOwnerRequests.ts";
import type { FeedItem } from "./useRequests.ts";

export interface Moderation {
  note: { text: string; error?: boolean } | null;
  kept: ReadonlySet<number>;
  busyId: number | null;
  onAct: (id: number, action: Action) => void;
}

interface BtnProps {
  item: FeedItem;
  action: Action;
  text: string;
  moderation: Moderation;
  ghost?: boolean;
}
function Btn({ item, action, text, moderation, ghost }: BtnProps) {
  return (
    <button
      type="button"
      className={ghost ? "btn small ghost" : "btn small"}
      aria-disabled={moderation.busyId !== null}
      aria-label={`${text} ${item.title} for ${item.name}`}
      onClick={() => moderation.busyId === null && moderation.onAct(item.id, action)}
    >
      {text}
    </button>
  );
}

export function ModerationActions({ item, moderation }: { item: FeedItem; moderation: Moderation }) {
  const keepable = item.status === "played" || item.status === "playing";
  return (
    <div className="row-actions mod-actions" data-testid="mod-actions">
      {item.status === "waiting" && <Btn item={item} moderation={moderation} action="approve" text="Approve" />}
      {item.status === "waiting" && <Btn item={item} moderation={moderation} action="deny" text="Deny" ghost />}
      {keepable && (moderation.kept.has(item.id) ? <span className="chip in-library">In library</span> : <Btn item={item} moderation={moderation} action="keep" text="Keep" />)}
      {item.status !== "denied" && <Btn item={item} moderation={moderation} action="remove" text="Remove" ghost />}
    </div>
  );
}
