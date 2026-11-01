// Published public editions move independently of a user's search; no sample stories or inferred facts.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, FocusEvent } from "react";
import type { ApiClient } from "../../api/client.ts";
import type { HiringWireEdition, HiringWireItem } from "../../api/types.ts";

interface Props {
  client: ApiClient;
  connected: boolean;
  generation: number;
  reducedMotion: boolean;
  dialogOpen: boolean;
  onFocusExit: () => void;
}
const number = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });
function comparison(item: HiringWireItem): string {
  const { previous, current, percentageChange } = item.activity;
  return percentageChange === null
    ? `${number.format(previous)} → ${number.format(current)}`
    : `${percentageChange > 0 ? "+" : ""}${number.format(percentageChange)}%`;
}
function Story({ item, duplicate }: { item: HiringWireItem; duplicate: boolean }) {
  const { previous, current } = item.activity;
  const maximum = Math.max(previous, current, 1);
  const y = (count: number) => 18 - count / maximum * 14;
  const prefix = `${item.company.name}: `;
  const headline = item.headline.startsWith(prefix) ? item.headline.slice(prefix.length) : item.headline;
  return <li>
    <a className="wire-item" href={`#company/${encodeURIComponent(item.company.id)}`} tabIndex={duplicate ? -1 : undefined}
      onMouseDown={event => { if (duplicate) event.preventDefault(); }}>
      <span className="wire-company">{item.company.name}</span>
      <span className="wire-headline">{headline}</span>
      <svg className="wire-comparison" viewBox="0 0 36 22" width="36" height="22" aria-hidden="true">
        <path d={`M3 ${y(previous)} L33 ${y(current)}`} />
        <circle cx="3" cy={y(previous)} r="2" /><circle cx="33" cy={y(current)} r="2" />
      </svg>
      <span className="wire-change" aria-label={item.activity.percentageChange === null
        ? `Newly observed listings: ${previous} previous week, ${current} current week`
        : `Newly observed listings changed ${comparison(item)}; ${previous} previous week, ${current} current week`}>{comparison(item)}</span>
    </a>
  </li>;
}
function PublishedWire({ edition, reducedMotion, dialogOpen, onFocusExit }: {
  edition: HiringWireEdition; reducedMotion: boolean; dialogOpen: boolean; onFocusExit: () => void;
}) {
  const viewport = useRef<HTMLElement>(null), items = useRef<HTMLUListElement>(null);
  const [measurements, setMeasurements] = useState({ width: 0, repeats: 1 }), [keyboardReading, setKeyboardReading] = useState(false);
  const [away, setAway] = useState(() => document.hidden);
  const staticReading = reducedMotion || keyboardReading;
  useLayoutEffect(() => () => {
    // Recover only a focus target that is about to disappear, before host-node removal.
    if (viewport.current?.contains(document.activeElement)) onFocusExit();
  }, [onFocusExit]);
  useLayoutEffect(() => {
    const node = items.current, frame = viewport.current;
    if (!node || !frame) return;
    const measure = () => {
      const itemWidth = node.getBoundingClientRect().width;
      const repeats = itemWidth > 0 ? Math.max(1, Math.ceil(frame.clientWidth / itemWidth)) : 1;
      const width = itemWidth * repeats;
      setMeasurements(previous => previous.width === width && previous.repeats === repeats ? previous : { width, repeats });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node); observer.observe(frame); measure();
    return () => observer.disconnect();
  }, [edition.id]);
  useEffect(() => {
    const update = () => setAway(document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  useLayoutEffect(() => {
    if (!staticReading) { if (viewport.current) viewport.current.scrollLeft = 0; return; }
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && viewport.current?.contains(focused))
      focused.scrollIntoView({ block: "nearest", inline: "start", behavior: "instant" });
  }, [staticReading]);
  const onFocus = (event: FocusEvent<HTMLElement>) => {
    if (event.target instanceof HTMLElement && event.target.matches(":focus-visible")) {
      setKeyboardReading(true);
      event.target.scrollIntoView({ block: "nearest", inline: "start", behavior: "instant" });
    }
  };
  const style = { "--wire-distance": `${measurements.width}px`, "--wire-duration": `${measurements.width / 27}s` } as CSSProperties;
  const periodEnd = new Intl.DateTimeFormat("en", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(edition.period.end));
  return <section id="hiring-wire" ref={viewport} className={`hiring-wire${staticReading ? " wire-reading" : ""}`}
    aria-label={`Company listing activity, week ending ${periodEnd}`} data-paused={dialogOpen || away || !measurements.width}
    onFocusCapture={onFocus}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setKeyboardReading(false); }}
    onPointerDownCapture={() => setKeyboardReading(false)}>
    <div className="wire-track" style={style}>
      <div className="wire-group">
        <ul ref={items} className="wire-items">{edition.items.map(item => <Story key={item.company.id} item={item} duplicate={false} />)}</ul>
        {Array.from({ length: measurements.repeats - 1 }, (_, index) => <ul key={index} className="wire-items wire-visual-copy" aria-hidden="true">{edition.items.map(item => <Story key={item.company.id} item={item} duplicate />)}</ul>)}
      </div>
      <div className="wire-group wire-duplicate" aria-hidden="true">{Array.from({ length: measurements.repeats }, (_, index) => <ul key={index} className="wire-items">{edition.items.map(item => <Story key={item.company.id} item={item} duplicate />)}</ul>)}</div>
    </div>
  </section>;
}
export function HiringWire({ client, connected, generation, reducedMotion, dialogOpen, onFocusExit }: Props) {
  const [published, setPublished] = useState<{ generation: number; edition: HiringWireEdition } | null>(null);
  useEffect(() => {
    setPublished(null);
    if (!connected) return;
    const controller = new AbortController();
    let current: HiringWireEdition | null = null, inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hide = () => { current = null; clearTimeout(timer); setPublished(null); };
    const expire = () => {
      if (!current || controller.signal.aborted) return;
      if (Date.now() < Date.parse(current.expiresAt)) { schedule(); return; }
      hide();
      // One request at a reported deadline; stale responses never schedule another request.
      if (!document.hidden) void load();
    };
    const schedule = () => {
      clearTimeout(timer);
      if (current) timer = setTimeout(expire, Math.min(2_147_483_647, Math.max(0, Date.parse(current.expiresAt) - Date.now())));
    };
    const load = async () => {
      if (inFlight || controller.signal.aborted) return;
      inFlight = true;
      try {
        const result = await client.getHiringWire(controller.signal);
        if (controller.signal.aborted) return;
        if (result.state !== "published" || Date.parse(result.edition.expiresAt) <= Date.now()
          || Date.parse(result.edition.publishedAt) > Date.now()) { hide(); return; }
        current = result.edition;
        setPublished({ generation, edition: current });
        schedule();
      } catch {
        // An unavailable edition never blocks search or schedules a polling loop.
        if (!controller.signal.aborted) hide();
      } finally { inFlight = false; }
    };
    const resume = () => {
      if (document.hidden) return;
      if (!current || Date.parse(current.expiresAt) <= Date.now()) {
        hide(); void load();
      }
    };
    document.addEventListener("visibilitychange", resume);
    void load();
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", resume); };
  }, [client, connected, generation]);
  return <div className="wire-slot">{connected && published?.generation === generation && Date.parse(published.edition.expiresAt) > Date.now()
    ? <PublishedWire key={published.edition.id} edition={published.edition} reducedMotion={reducedMotion} dialogOpen={dialogOpen} onFocusExit={onFocusExit} />
    : null}</div>;
}
