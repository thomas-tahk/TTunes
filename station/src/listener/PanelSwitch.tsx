import { applyPanel, type Panel, PANELS } from "./panel.ts";

/** Per-browser choice of the Afterglow panel colour; same radio pattern as the Look and Layout switches. */
export function PanelSwitch({ panel, onChange }: { panel: Panel; onChange: (next: Panel) => void }) {
  const choose = (next: Panel) => {
    onChange(next);
    applyPanel(next);
  };
  return (
    <fieldset className="look-switch panel-switch">
      <legend>Panel</legend>
      {PANELS.map((p) => (
        <label key={p.id} className={panel === p.id ? "on" : undefined}>
          <input type="radio" name="panel" value={p.id} checked={panel === p.id} onChange={() => choose(p.id)} />
          <span>{p.label}</span>
        </label>
      ))}
    </fieldset>
  );
}
