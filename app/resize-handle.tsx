import { useState } from "react";

export function ResizeHandle({ variant, onDrag }: { variant: string; onDrag(deltaX: number): void }) {
  const [active, setActive] = useState(false);
  return <div className={`resize-handle ${variant} ${active ? "active" : ""}`} onPointerDown={(event) => {
    event.preventDefault();
    setActive(true);
    let lastX = event.clientX;
    const move = (moveEvent: PointerEvent) => { const delta = moveEvent.clientX - lastX; lastX = moveEvent.clientX; onDrag(delta); };
    const up = () => { setActive(false); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  }} />;
}
