import { applyLayout, type Layout } from "./layout.ts";

const LAYOUTS: { id: Layout; label: string }[] = [
  { id: "side", label: "Side" },
  { id: "stacked", label: "Stacked" },
];

/** Per-browser choice of layout, same radio pattern as the Look switch. App owns the state because the page's markup depends on it. */
export function LayoutSwitch({ layout, onChange }: { layout: Layout; onChange: (next: Layout) => void }) {
  const choose = (next: Layout) => {
    onChange(next);
    applyLayout(next);
  };
  return (
    <fieldset className="look-switch layout-switch">
      <legend>Layout</legend>
      {LAYOUTS.map((l) => (
        <label key={l.id} className={layout === l.id ? "on" : undefined}>
          <input type="radio" name="layout" value={l.id} checked={layout === l.id} onChange={() => choose(l.id)} />
          <span>{l.label}</span>
        </label>
      ))}
    </fieldset>
  );
}
