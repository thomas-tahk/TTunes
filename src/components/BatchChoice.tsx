import type { AddChoice } from "../../shared/addChoice.ts";
import { AddChoiceButtons } from "./AddChoiceButtons.tsx";

// Shown after a batch of files was added: "Added N tracks" + the three choices.
export function BatchChoice({ count, onChoose }: { count: number; onChoose: (choice: AddChoice) => void }) {
  return (
    <div className="uploader__choice">
      <span>
        Added {count} {count === 1 ? "track" : "tracks"}
      </span>
      <AddChoiceButtons busy={false} onChoose={onChoose} />
    </div>
  );
}
