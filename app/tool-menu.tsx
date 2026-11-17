import { useEffect, useRef, useState } from "react";

/** A toolbar button that opens a list under it, closed by an outside click or by picking an item. */
export function ToolMenu({ label, title, active, disabled, wide, children }: { label: React.ReactNode; title?: string; active?: boolean; disabled?: boolean; wide?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, []);
  return <div className="tool-menu" ref={ref}>
    <button className={open || active ? "active" : ""} disabled={disabled} title={title} aria-expanded={open} onClick={() => setOpen((value) => !value)}>{label} ▾</button>
    {open && <div className={`tool-menu-list${wide ? " wide" : ""}`} onClick={(event) => { if (!(event.target as HTMLElement).closest(".tool-menu-keep")) setOpen(false); }}>{children}</div>}
  </div>;
}

/** One line of a ToolMenu. `keepOpen` is for on/off options, where you may set several in a row. */
export function ToolMenuItem({ checked, keepOpen, disabled, title, hint, onClick, children }: { checked?: boolean; keepOpen?: boolean; disabled?: boolean; title?: string; hint?: string; onClick(): void; children: React.ReactNode }) {
  return <button className={`tool-menu-item${keepOpen ? " tool-menu-keep" : ""}`} disabled={disabled} title={title} onClick={onClick}><i>{checked ? "✓" : ""}</i><span>{children}</span>{hint && <kbd>{hint}</kbd>}</button>;
}
