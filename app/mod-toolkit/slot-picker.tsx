import { tr } from "../i18n";
import { useMemo, useState } from "react";
import { classLabel } from "../../src/slot-reference";
import type { RetargetLevel, RetargetNote } from "../../src/slot-retarget";

/**
 * Slot Retarget pieces shared by Tools 11 and ISO Install.
 *
 * SlotPicker: a filter box and a select of slots grouped by class. Typing narrows the list — spaces,
 * underscores and the vp_ prefix don't matter ("is 300" finds vp_is300_04), and the class counts too
 * ("tuner"). Enter picks the first slot left that can be chosen.
 *
 * RetargetNotes: a conversion report, grouped by level, most serious first.
 */

const LEVELS: { level: RetargetLevel; title: string }[] = [
  { level: "block", title: "Blocked" },
  { level: "warn", title: "Warnings" },
  { level: "fix", title: "Converted for the original MC3" },
  { level: "ok", title: "Checks passed" },
  { level: "info", title: "Notes" },
];
const levelTag: Record<RetargetLevel, string> = { block: "BLOCK", warn: "WARN", fix: "FIX", ok: "OK", info: "INFO" };

/** `fixTitle`: the heading of the conversions ("Converted for the original MC3", "Converted for this ISO"). */
export function RetargetNotes({ notes, fixTitle }: { notes: RetargetNote[]; fixTitle?: string }) {
  return <>{LEVELS.map(({ level, title }) => {
    const items = notes.filter((note) => note.level === level);
    if (!items.length) return null;
    return <div key={level} className={`retarget-group ${level}`}>
      <h4>{tr(level === "fix" && fixTitle ? fixTitle : title)}</h4>
      {items.map((note, index) => <p key={index}><em>{levelTag[level]}</em><span>{tr(note.text)}</span></p>)}
    </div>;
  })}</>;
}

export type SlotOption = {
  name: string;
  className: string;
  disabled?: boolean;
  /** Short marks after the name ("bike", "ELF", "no menus"). */
  tags?: string[];
  /** Replaces the name in the list, e.g. to mark the mod's own slot. */
  label?: string;
};

const squash = (text: string) => text.toLowerCase().replace(/^vp_/, "").replace(/[^a-z0-9]/g, "");

export function SlotPicker({ slots, value, onChange, disabled, placeholder, compact }: {
  slots: SlotOption[];
  value: string;
  onChange: (name: string) => void;
  disabled?: boolean;
  placeholder: string;
  /** Filter and select side by side, for a car card. */
  compact?: boolean;
}) {
  const [filter, setFilter] = useState("");
  const byClass = useMemo(() => {
    const query = squash(filter);
    const groups = new Map<string, SlotOption[]>();
    for (const slot of [...slots].sort((a, b) => a.name.localeCompare(b.name))) {
      const label = classLabel(slot.className);
      // The chosen slot stays listed, so the select never shows a value it doesn't have.
      if (query && slot.name !== value && !squash(slot.name).includes(query) && !squash(label).includes(query)) continue;
      groups.set(label, [...(groups.get(label) ?? []), slot]);
    }
    return [...groups].sort(([a], [b]) => a.localeCompare(b));
  }, [slots, filter, value]);

  return <div className={compact ? "slot-picker compact" : "slot-picker"}>
    <input className="retarget-filter" type="search" value={filter} disabled={disabled} placeholder={tr("Type to filter: is 300, charger, tuner…")} aria-label={tr("Filter slots")}
      onChange={(event) => setFilter(event.target.value)}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        const first = byClass.flatMap(([, group]) => group).find((slot) => !slot.disabled && slot.name !== value);
        if (first) { event.preventDefault(); onChange(first.name); }
      }} />
    <select className="retarget-select" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} aria-label={tr("Target slot")}>
      <option value="">{placeholder}</option>
      {byClass.map(([label, group]) => <optgroup key={label} label={label}>
        {group.map((slot) => <option key={slot.name} value={slot.name} disabled={slot.disabled}>
          {slot.label ?? slot.name}{slot.tags?.map((tag) => ` · ${tr(tag)}`).join("") ?? ""}
        </option>)}
      </optgroup>)}
    </select>
  </div>;
}
