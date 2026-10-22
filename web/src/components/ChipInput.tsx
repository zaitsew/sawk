import { useId, useState } from "react";

interface Props {
  label: string;
  hint?: string;
  values: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}

/** Chips with a text box: Enter or comma adds, × removes. */
export function ChipInput({ label, hint, values, onChange, placeholder }: Props) {
  const id = useId();
  const [draft, setDraft] = useState("");

  const add = (raw: string) => {
    const v = raw.trim().replace(/,$/, "").trim();
    if (!v) return;
    if (!values.some((x) => x.toLowerCase() === v.toLowerCase())) onChange([...values, v]);
    setDraft("");
  };

  return (
    <div className="field">
      <label htmlFor={id} className="label">{label}</label>
      {hint && <p className="caption" id={`${id}-hint`}>{hint}</p>}
      {values.length > 0 && (
        <ul className="chips" aria-label={label}>
          {values.map((v) => (
            <li key={v} className="chip chip-edit">
              <span>{v}</span>
              <button type="button" className="chip-x" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}>×</button>
            </li>
          ))}
        </ul>
      )}
      <div className="row">
        <input
          id={id} className="input" value={draft} placeholder={placeholder} enterKeyHint="done"
          aria-describedby={hint ? `${id}-hint` : undefined}
          onChange={(e) => (e.target.value.endsWith(",") ? add(e.target.value) : setDraft(e.target.value))}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(draft); } }}
          onBlur={() => add(draft)}
        />
        <button type="button" className="btn" onClick={() => add(draft)} disabled={!draft.trim()}>Add</button>
      </div>
    </div>
  );
}
