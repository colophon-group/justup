// Capture before feed reconciliation and compensate before paint, without replacing nodes.
import { useCallback, useLayoutEffect, useRef } from 'react';
export function useReadingAnchor() {
  const held = useRef<{ element: HTMLElement; top: number }[]>([]);
  const capture = useCallback(() => {
    // Header and editor contexts retain their document position.
    if (document.activeElement?.closest('.search-workspace') || document.querySelector('dialog[open]')) return;
    const rows = [...document.querySelectorAll<HTMLElement>('#feed [data-job]')];
    held.current = rows.filter(element => { const box = element.getBoundingClientRect(); return box.top < innerHeight && box.bottom > 0; })
      .map(element => ({ element, top: element.getBoundingClientRect().top }));
  }, []);
  useLayoutEffect(() => {
    const previous = held.current.find(anchor => anchor.element.isConnected); held.current = [];
    if (previous) {
      const difference = previous.element.getBoundingClientRect().top - previous.top;
      if (difference) window.scrollBy({ top: difference, behavior: 'instant' });
    }
  });
  return capture;
}
