import type { AddChoice } from "../../shared/addChoice.ts";

// The three buttons every add path ends with.
export function AddChoiceButtons({ busy, onChoose }: { busy: boolean; onChoose: (choice: AddChoice) => void }) {
  return (
    <div className="add-choice">
      <button className="ctrl ctrl--primary" disabled={busy} onClick={() => onChoose("now")}>
        ▶ Play now
      </button>
      <button className="ctrl" disabled={busy} onClick={() => onChoose("next")}>
        Queue next
      </button>
      <button className="ctrl" disabled={busy} onClick={() => onChoose("last")}>
        Queue last
      </button>
    </div>
  );
}
