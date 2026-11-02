// Capture before feed reconciliation and compensate before paint, without replacing nodes.
import { useCallback, useLayoutEffect, useRef } from 'react';
export function useReadingAnchor() {
  const held = useRef<{ element: HTMLElement; top: number }[]>([]);
  const capture = useCallback(() => {
    held.current = [];
    // Header/editor controls retain their document position. Default body focus
    // becomes a reading context only once the results reach the viewport top.
    const focused = document.activeElement;
    if (document.querySelector('dialog[open]') || focused && focused !== document.body && focused !== document.documentElement && !focused.closest('#feed')) return;
    const selection = document.getSelection()?.anchorNode;
    const interacting = focused?.closest('#feed') || selection && document.querySelector('#feed')?.contains(selection);
    if (!interacting && (document.querySelector('#search-results')?.getBoundingClientRect().top ?? Infinity) > 0) return;
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
