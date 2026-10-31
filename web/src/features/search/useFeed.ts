// Result pagination is independent of visible-row pacing and accepted search revisions.
import { useCallback, useEffect, useRef, useState } from "react";
import { errorText, isAbortError } from "../../api/client.ts";
import type { ApiClient } from "../../api/client.ts";
import type { Job, ResultPage, Search } from "../../api/types.ts";
interface Feed {
  key: string;
  jobs: Job[];
  continuation: ResultPage["continuation"];
  ai: ResultPage["ai"];
  hidden?: ResultPage["hidden"];
  loading: boolean;
  error: string | null;
}
const emptyFeed = (key: string): Feed => ({
  key,
  jobs: [],
  continuation: { state: "open", cursor: null, retryAfterMs: null },
  ai: { status: "not_required" },
  loading: false,
  error: null,
});
export function useFeed(
  client: ApiClient,
  search: Search | undefined,
  active: boolean,
) {
  const key =
    search?.status === "ready" ? `${search.id}:${search.revision}` : "";
  const [feed, setFeed] = useState(() => emptyFeed(key));
  const generation = useRef(0),
    inFlight = useRef(false),
    initialized = useRef(false),
    controller = useRef<AbortController | null>(null);
  const seenIds = useRef(new Set<string>()),
    seenCursors = useRef(new Set<string>());
  const feedRef = useRef(feed);
  feedRef.current = feed;
  const load = useCallback(
    async (cursor: string | null) => {
      if (!search || !key || inFlight.current) return;
      const epoch = generation.current,
        request = new AbortController();
      controller.current = request;
      inFlight.current = true;
      initialized.current = true;
      setFeed((current) =>
        current.key === key
          ? { ...current, loading: true, error: null }
          : { ...emptyFeed(key), loading: true },
      );
      try {
        const page = await client.getResults(
          search.id,
          search.revision,
          cursor,
          request.signal,
        );
        if (epoch !== generation.current || request.signal.aborted) return;
        if (page.searchId !== search.id || page.revision !== search.revision)
          throw new Error(
            "The service returned results for an unexpected search revision. Refresh to continue.",
          );
        const next = page.continuation.cursor;
        if (
          next &&
          page.continuation.state !== "pending" &&
          (next === cursor || seenCursors.current.has(next))
        )
          throw new Error(
            "The service repeated a result cursor. Refresh this search.",
          );
        if (next && next !== cursor) seenCursors.current.add(next);
        const fresh = page.items.filter((job) => {
          if (seenIds.current.has(job.id)) return false;
          seenIds.current.add(job.id);
          return true;
        });
        setFeed((current) =>
          current.key === key
            ? {
                ...current,
                jobs: [...current.jobs, ...fresh],
                continuation: page.continuation,
                ai: page.ai,
                ...(page.hidden ? { hidden: page.hidden } : {}),
                loading: false,
                error: null,
              }
            : current,
        );
      } catch (error) {
        if (epoch === generation.current && !isAbortError(error))
          setFeed((current) =>
            current.key === key
              ? { ...current, loading: false, error: errorText(error) }
              : current,
          );
      } finally {
        if (epoch === generation.current) {
          inFlight.current = false;
          controller.current = null;
        }
      }
    },
    [client, key, search?.id, search?.revision],
  );
  useEffect(() => {
    generation.current++;
    controller.current?.abort();
    inFlight.current = false;
    initialized.current = false;
    seenIds.current.clear();
    seenCursors.current.clear();
    setFeed(emptyFeed(key));
    if (active && key) void load(null);
    return () => {
      generation.current++;
      controller.current?.abort();
      inFlight.current = false;
    };
  }, [key, load]);
  useEffect(() => {
    if (active && key && !initialized.current) void load(null);
  }, [active, key, load]);
  const next = useCallback(() => {
    const value = feedRef.current;
    if (
      value.key !== key ||
      value.error ||
      ["exhausted", "paused", "failed"].includes(value.continuation.state)
    )
      return;
    void load(value.continuation.cursor);
  }, [key, load]);
  const retry = () => {
    const value = feedRef.current;
    if (value.key === key) void load(value.continuation.cursor);
  };
  return {
    feed: feed.key === key ? feed : emptyFeed(key),
    next,
    retry,
    refresh: () => {
      generation.current++;
      controller.current?.abort();
      inFlight.current = false;
      seenIds.current.clear();
      seenCursors.current.clear();
      setFeed(emptyFeed(key));
      void load(null);
    },
  };
}
