import { tr, Tx } from "./i18n";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type ContextMenuItem = { label: string; disabled?: boolean; title?: string; onSelect(): void };
export type ContextMenuState = { x: number; y: number; heading?: string; items: ContextMenuItem[] };

/** A right-click menu pinned at the cursor, kept inside the window, closed by an outside click,
 *  Escape, scrolling, a resize or the window losing focus. */
export function ContextMenu({ menu, onClose }: { menu: ContextMenuState; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: menu.x, top: menu.y });
  useLayoutEffect(() => {
    const element = ref.current; if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    setPosition({ left: Math.max(4, Math.min(menu.x, window.innerWidth - width - 4)), top: Math.max(4, Math.min(menu.y, window.innerHeight - height - 4)) });
  }, [menu.x, menu.y]);
  useEffect(() => {
    const closeOutside = (event: Event) => { if (!ref.current?.contains(event.target as Node)) onClose(); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("mousedown", closeOutside, true);
    window.addEventListener("wheel", onClose, true);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", closeOutside, true);
      window.removeEventListener("wheel", onClose, true);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose]);
  return <div ref={ref} className="context-menu" style={position} role="menu" onContextMenu={(event) => event.preventDefault()}>
    {menu.heading && <div className="context-menu-heading" title={menu.heading}>{menu.heading}</div>}
    {menu.items.map((item) => <button key={tr(item.label)} className="menu-item" role="menuitem" disabled={item.disabled} title={tr(item.title)} onClick={() => { onClose(); item.onSelect(); }}><span>{tr(item.label)}</span></button>)}
  </div>;
}
