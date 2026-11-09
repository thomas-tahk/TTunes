import { applyLook, type Look } from "./look.ts";

const LOOKS: { id: Look; label: string }[] = [
  { id: "afterglow", label: "Afterglow" },
  { id: "theset", label: "The Set" },
];

/** Per-browser choice of look, for listener and owner alike. Native radios give arrow-key and screen-reader behaviour. */
export function LookSwitch({ look, onChange }: { look: Look; onChange: (next: Look) => void }) {
  const choose = (next: Look) => {
    onChange(next);
    applyLook(next);
  };
  return (
    <fieldset className="look-switch">
      <legend>Look</legend>
      {LOOKS.map((l) => (
        <label key={l.id} className={look === l.id ? "on" : undefined}>
          <input type="radio" name="look" value={l.id} checked={look === l.id} onChange={() => choose(l.id)} />
          <span>{l.label}</span>
        </label>
      ))}
    </fieldset>
  );
}
