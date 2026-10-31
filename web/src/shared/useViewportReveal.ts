// Reveal from a ready buffer only when the real next slot is visible.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
interface Options<T> {
  items: readonly T[];
  resetKey: string;
  tailRef: RefObject<HTMLElement | null>;
  active: boolean;
  loading?: boolean;
  hasMore?: boolean;
  onNeedMore?: () => void;
  delayMs?: number;
}
export function useViewportReveal<T>({
  items,
  resetKey,
  tailRef,
  active,
  loading = false,
  hasMore = false,
  onNeedMore,
  delayMs = 450,
}: Options<T>): { visible: T[]; revealing: boolean; initialCount: number } {
  const [count, setCount] = useState(0),
    [revealing, setRevealing] = useState(false);
  const [initialCount, setInitialCount] = useState(Number.POSITIVE_INFINITY);
  const initial = useRef(true),
    key = useRef(resetKey);
  const isVisible = () => {
    const box = tailRef.current?.getBoundingClientRect();
    return (
      active &&
      !document.hidden &&
      !document.querySelector("dialog[open]") &&
      !!box &&
      box.top < window.innerHeight &&
      box.bottom > 0
    );
  };
  useLayoutEffect(() => {
    if (key.current !== resetKey) {
      key.current = resetKey;
      initial.current = true;
      setCount(0);
      setRevealing(false);
      setInitialCount(Number.POSITIVE_INFINITY);
    }
  }, [resetKey]);
  useLayoutEffect(() => {
    if (!active || loading || key.current !== resetKey) return;
    if (initial.current && count < items.length && isVisible()) {
      setCount((value) => Math.min(value + 1, items.length));
      return;
    }
    if (items.length && initial.current) {
      initial.current = false;
      setInitialCount(count);
    }
  });
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (
        timer ||
        loading ||
        !isVisible() ||
        (count >= items.length && !hasMore)
      )
        return;
      setRevealing(true);
      timer = setTimeout(
        () => {
          timer = undefined;
          setRevealing(false);
          if (!isVisible()) return;
          if (count < items.length)
            setCount((value) => Math.min(value + 1, items.length));
          else onNeedMore?.();
        },
        Math.max(450, delayMs),
      );
    };
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    document.addEventListener("visibilitychange", schedule);
    document.addEventListener("toggle", schedule, true);
    schedule();
    return () => {
      if (timer) {
        clearTimeout(timer);
        setRevealing(false);
      }
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("visibilitychange", schedule);
      document.removeEventListener("toggle", schedule, true);
    };
  }, [
    active,
    count,
    items.length,
    loading,
    hasMore,
    onNeedMore,
    delayMs,
    resetKey,
  ]);
  return {
    visible: items.slice(0, key.current === resetKey ? count : 0),
    revealing,
    initialCount,
  };
}
