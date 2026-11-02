import type { Terminal } from "@xterm/xterm";

// xterm 5 ignores touch scrolling when the program enables mouse reporting.
// Translate one-finger swipes into its existing wheel path, preserving input focus.
export function touchScrolling(term: Terminal, scroller: HTMLElement, canControl: () => boolean, canType: () => boolean, wheel: (node: HTMLElement, event: WheelEvent) => void) {
  const host = term.element!;
  let gesture: { x: number; y: number; startX: number; startY: number; rest: number; moved: boolean; horizontal?: boolean } | undefined;
  const stop = (event: TouchEvent) => { if (event.cancelable) event.preventDefault(); event.stopImmediatePropagation(); };
  host.addEventListener("touchstart", event => {
    if (event.touches.length !== 1) { gesture = undefined; return; }
    const t = event.touches[0];
    gesture = { x: t.clientX, y: t.clientY, startX: t.clientX, startY: t.clientY, rest: 0, moved: false };
    stop(event);
  }, { capture: true, passive: false });
  host.addEventListener("touchmove", event => {
    if (!gesture || event.touches.length !== 1) { gesture = undefined; return; }
    stop(event);
    const t = event.touches[0], dx = gesture.x - t.clientX, dy = gesture.y - t.clientY;
    if (!gesture.moved && Math.hypot(t.clientX - gesture.startX, t.clientY - gesture.startY) < 5) return;
    if (!gesture.moved) gesture.horizontal = Math.abs(t.clientX - gesture.startX) > Math.abs(t.clientY - gesture.startY);
    gesture.moved = true; gesture.x = t.clientX; gesture.y = t.clientY;
    if (gesture.horizontal) { scroller.scrollLeft += dx; return; }
    const screen = host.querySelector<HTMLElement>(".xterm-screen")!;
    const lineHeight = Math.max(8, screen.clientHeight / term.rows);
    gesture.rest += dy;
    const lines = Math.max(-24, Math.min(24, Math.trunc(gesture.rest / lineHeight)));
    if (!lines) return;
    gesture.rest -= lines * lineHeight;
    if (term.modes.mouseTrackingMode !== "none" || term.buffer.active.type === "alternate") {
      if (!canControl()) return; // Watch never sends input, including mouse input.
      const rect = screen.getBoundingClientRect();
      for (let i = 0; i < Math.abs(lines); i++) wheel(screen, new WheelEvent("wheel", {
        deltaY: Math.sign(lines) * lineHeight, bubbles: true, cancelable: true,
        clientX: Math.max(rect.left + 1, Math.min(rect.right - 1, t.clientX)),
        clientY: Math.max(rect.top + 1, Math.min(rect.bottom - 1, t.clientY)),
      }));
    } else term.scrollLines(lines);
  }, { capture: true, passive: false });
  host.addEventListener("touchend", event => {
    if (!gesture) return;
    stop(event);
    const tap = !gesture.moved, t = event.changedTouches[0];
    gesture = undefined;
    if (tap && canType()) {
      term.focus();
      if (t) {
        const screen = host.querySelector<HTMLElement>(".xterm-screen")!;
        for (const type of ["mousedown", "mouseup"]) screen.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: t.clientX, clientY: t.clientY }));
      }
    }
  }, { capture: true, passive: false });
  host.addEventListener("touchcancel", () => { gesture = undefined; }, { capture: true });
}
