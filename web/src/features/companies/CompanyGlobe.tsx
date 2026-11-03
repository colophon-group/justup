// Neutral geography is interactive even before a reviewed hiring-country report exists.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { useInterfaceLocale } from '../../i18n/LocaleProvider';
import { globePaths, home, rotate, wheelRotation } from './globe';

export function CompanyGlobe() {
  const { t } = useInterfaceLocale();
  const id = useId();
  const sphere = useRef<HTMLDivElement>(null);
  const orientation = useRef(home);
  const frame = useRef<number | null>(null);
  const drag = useRef<{ id: number; x: number; y: number; touch: boolean; locked: boolean } | null>(null);
  const touchObserver = useRef<{ document: Document; listener: (event: globalThis.PointerEvent) => void } | null>(null);
  const [view, setView] = useState(home);
  const paths = useMemo(() => globePaths(view), [view]);
  function update(longitude: number, latitude = 0, reset = false) {
    if (!reset && longitude === 0 && latitude === 0) return;
    orientation.current = reset ? home : rotate(orientation.current, longitude, latitude);
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => { frame.current = null; setView(orientation.current); });
  }
  function onSphere(x: number, y: number) {
    const bounds = sphere.current?.getBoundingClientRect();
    return bounds && Math.hypot(x - bounds.left - bounds.width / 2, y - bounds.top - bounds.height / 2) <= bounds.width * 100 / 220;
  }
  function cancelDrag() {
    const active = drag.current; drag.current = null;
    const observer = touchObserver.current; touchObserver.current = null;
    observer?.document.removeEventListener('pointerdown', observer.listener, true);
    if (active && sphere.current?.hasPointerCapture(active.id)) sphere.current.releasePointerCapture(active.id);
  }
  useEffect(() => {
    const target = sphere.current!;
    const wheel = (event: WheelEvent) => { if (onSphere(event.clientX, event.clientY)) update(wheelRotation(event)); };
    // Native scrolling and Ctrl/pinch browser zoom remain available over the sphere.
    target.addEventListener('wheel', wheel, { passive: true });
    return () => { target.removeEventListener('wheel', wheel); cancelDrag(); if (frame.current !== null) cancelAnimationFrame(frame.current); };
  }, []);
  function start(event: PointerEvent<HTMLDivElement>) {
    if (!event.isPrimary || event.button !== 0 || !onSphere(event.clientX, event.clientY)) return;
    if (drag.current) return;
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, touch: event.pointerType === 'touch', locked: false };
    event.currentTarget.setPointerCapture(event.pointerId);
    if (event.pointerType === 'touch') {
      // A second contact can start outside the globe, before native pinch cancellation.
      const document = event.currentTarget.ownerDocument;
      const listener = (event: globalThis.PointerEvent) => { if (event.pointerType === 'touch' && !event.isPrimary) cancelDrag(); };
      touchObserver.current = { document, listener };
      document.addEventListener('pointerdown', listener, { passive: true, capture: true });
    }
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    const previous = drag.current;
    if (!previous || previous.id !== event.pointerId) return;
    if (previous.touch && !previous.locked) {
      const dx = Math.abs(event.clientX - previous.x), dy = Math.abs(event.clientY - previous.y);
      if (Math.max(dx, dy) < 6) return;
      if (dy > dx) { end(event); return; }
    }
    const width = event.currentTarget.getBoundingClientRect().width;
    update((previous.x - event.clientX) * 180 / width, previous.touch ? 0 : (event.clientY - previous.y) * 180 / width);
    drag.current = { ...previous, x: event.clientX, y: event.clientY, locked: true };
  }
  function end(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.id !== event.pointerId) return;
    cancelDrag();
  }
  function key(event: KeyboardEvent<HTMLDivElement>) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const directions: Record<string, readonly [number, number]> = { ArrowLeft: [-15, 0], ArrowRight: [15, 0], ArrowUp: [0, 15], ArrowDown: [0, -15], Home: [0, 0] };
    const direction = directions[event.key];
    if (!direction) return;
    event.preventDefault(); update(...direction, event.key === 'Home');
  }
  return <section className="company-footprint" aria-labelledby={`${id}-title`}>
    <div className="footprint-copy">
      <h2 id={`${id}-title`}>{t('Worldwide footprint.')}</h2>
      <span className="eyebrow">{t('UNKNOWN')}</span>
      <p id={`${id}-unknown`}>{t('Hiring countries are unknown.')}</p>
      <p className="globe-hint">{t('Drag or scroll to rotate.')}</p>
      <p className="sr-only" id={`${id}-instructions`}>{t('Use arrow keys to rotate and Home to reset. On touch screens, drag horizontally to rotate or vertically to scroll the page. Scrolling over the globe also scrolls the page. Browser zoom stays available.')}</p>
      <button type="button" className="button outline globe-reset" onClick={() => update(0, 0, true)}>{t('Reset view')}</button>
    </div>
    <div ref={sphere} className="company-globe" role="group" tabIndex={0} aria-label={t('Neutral world globe')} aria-describedby={`${id}-unknown ${id}-instructions`} aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Home"
      onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end} onKeyDown={key}>
      <svg viewBox="-110 -110 220 220" aria-hidden="true" focusable="false">
        <circle className="globe-ocean" r="100" />
        <path className="globe-grid" d={paths.grid} />
        <path className="globe-land" d={paths.land} />
      </svg>
    </div>
  </section>;
}
