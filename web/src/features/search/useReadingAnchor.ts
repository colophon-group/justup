// Capture before feed reconciliation and compensate before paint, without replacing nodes.
import { useCallback, useLayoutEffect, useRef } from 'react';
export function useReadingAnchor() {
  const held = useRef<{ element: HTMLElement; top: number } | null>(null);
  const capture = useCallback(() => {
    // Header and editor contexts retain their document position.
    if (document.activeElement?.closest('.search-workspace') || document.querySelector('dialog[open]')) return;
    const rows = [...document.querySelectorAll<HTMLElement>('#feed [data-job]')];
    const row = rows.find(element => { const box = element.getBoundingClientRect(); return box.top <= 0 && box.bottom > 0; })
      ?? rows.find(element => { const box = element.getBoundingClientRect(); return box.top < innerHeight && box.bottom > 0; });
    if (row) held.current = { element: row, top: row.getBoundingClientRect().top };
  }, []);
  useLayoutEffect(() => {
    const previous = held.current; held.current = null;
    if (previous?.element.isConnected) {
      const difference = previous.element.getBoundingClientRect().top - previous.top;
      if (difference) window.scrollBy({ top: difference, behavior: 'instant' });
    }
  });
  return capture;
}
