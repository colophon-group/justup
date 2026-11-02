// Result pagination is independent of visible-row pacing and accepted search revisions.
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, errorText, isAbortError } from "../../api/client.ts";
import type { ApiClient } from "../../api/client.ts";
import { jobOrder, reconcileLive, type LiveBaseline } from "./liveFeed.ts";
import type { LiveSnapshot } from "../../api/liveResults.ts";
import type { Job, ResultPage, Search, SearchScope } from "../../api/types.ts";
interface Feed {
  key: string;
  jobs: Job[];
  continuation: ResultPage["continuation"];
  ai: ResultPage["ai"];
  hiddenMatches: ResultPage["hiddenMatches"];
  coverage: ResultPage["coverage"];
  bufferVersion: number;
  immediateIds: ReadonlySet<string>;
  loading: boolean;
  error: string | null;
}
const emptyFeed = (key: string): Feed => ({
  key,
  jobs: [],
  continuation: { state: "open", cursor: null, retryAfterMs: null },
  ai: { status: "not_required" },
  hiddenMatches: { status: "unavailable", count: null },
  coverage: undefined,
  bufferVersion: 0,
  immediateIds: new Set(),
  loading: false,
  error: null,
});
export function useFeed(
  client: ApiClient,
  search: Search | undefined,
  active: boolean,
  scope: SearchScope = "account",
  ownerKey = "",
  beforeUpdate: () => void = () => {},
) {
  const key =
    search?.status === "ready" ? `${ownerKey}:${scope}:${search.id}:${search.revision}` : "";
  const [feed, setFeed] = useState(() => emptyFeed(key));
  const generation = useRef(0),
    inFlight = useRef(false),
    initialized = useRef(false),
    controller = useRef<AbortController | null>(null);
  const baseline = useRef<LiveBaseline | null>(null);
  const before = useRef(beforeUpdate); before.current = beforeUpdate;
  const seenIds = useRef(new Set<string>()),
    seenCursors = useRef(new Set<string>());
  const interrupted = useRef<{ cursor: string | null } | null>(null);
  const feedRef = useRef(feed);
  feedRef.current = feed;
  const load = useCallback(
    async (cursor: string | null, replace = false) => {
      if (!search || !key || inFlight.current) return;
      let recoverCursor = false;
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
          scope,
        );
        if (epoch !== generation.current || request.signal.aborted) return;
        if (page.searchId !== search.id || page.revision !== search.revision)
          throw new Error(
            "The service returned results for an unexpected search revision. Refresh to continue.",
          );
        const unavailable =
          page.coverage?.stale === true ||
          page.coverage?.state === "import_unavailable";
        if (unavailable) {
          seenIds.current.clear();
          seenCursors.current.clear();
          setFeed((current) =>
            current.key === key
              ? {
                  ...current,
                  jobs: [],
                  hiddenMatches: { status: "unavailable", count: null },
                  coverage: page.coverage,
                  bufferVersion: current.bufferVersion + 1,
                  continuation: {
                    ...page.continuation,
                    state: "paused",
                    cursor: null,
                  },
                  ai: page.ai,
                  loading: false,
                  error: null,
                }
              : current,
          );
          return;
        }
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
          if (baseline.current?.complete && !baseline.current.accepted.has(job.id)) return false;
          if (!replace && seenIds.current.has(job.id)) return false;
          seenIds.current.add(job.id);
          return true;
        });
        if (replace) seenIds.current = new Set(fresh.map(job => job.id));
        before.current();
        setFeed((current) =>
          current.key === key
            ? {
                ...current,
                jobs: [...(replace ? [] : current.jobs), ...fresh.map(job => ({ ...job, isNew: current.jobs.find(existing => existing.id === job.id)?.isNew ?? false }))].sort(jobOrder),
                continuation: page.continuation,
                ai: page.ai,
                hiddenMatches: page.hiddenMatches,
                coverage: page.coverage,
                loading: false,
                error: null,
              }
            : current,
        );
      } catch (error) {
        if (epoch === generation.current && cursor && error instanceof ApiError && error.code === 'stale_cursor') {
          seenCursors.current.clear(); recoverCursor = true; return;
        }
        if (isAbortError(error) && epoch === generation.current && !request.signal.aborted) interrupted.current = { cursor };
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
          if (recoverCursor) void load(null);
        }
      }
    },
    [client, key, scope, search?.id, search?.revision],
  );
  useEffect(() => {
    generation.current++;
    controller.current?.abort();
    inFlight.current = false;
    initialized.current = false;
    interrupted.current = null;
    seenIds.current.clear();
    seenCursors.current.clear();
    baseline.current = null;
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
  useEffect(() => client.onSessionResumed(() => {
    if (!active || !interrupted.current) return;
    const pending = interrupted.current; interrupted.current = null;
    void load(pending.cursor);
  }), [client, active, load]);
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
    receive: (event: LiveSnapshot) => {
      const current = feedRef.current;
      if (current.key !== key) return;
      const reconciled = reconcileLive(current.jobs, event, baseline.current);
      before.current();
      generation.current++; controller.current?.abort(); inFlight.current = false;
      baseline.current = reconciled.baseline;
      seenIds.current = new Set(reconciled.jobs.map(job => job.id));
      const unavailable = event.page.coverage?.stale === true || event.page.coverage?.state === 'import_unavailable';
      const currentIds = new Set(reconciled.jobs.map(job => job.id));
      const immediateIds = new Set([...current.immediateIds, ...reconciled.arrivals].filter(id => currentIds.has(id)));
      const updated = { ...current, loading: false, jobs: unavailable ? [] : reconciled.jobs, immediateIds,
        continuation: { ...event.page.continuation, cursor: current.continuation.cursor }, ai: event.page.ai, coverage: event.page.coverage,
        hiddenMatches: unavailable ? { status: 'unavailable' as const, count: null } : event.page.hiddenMatches, error: null };
      feedRef.current = updated; setFeed(updated);
    },
    invalidate: () => {
      generation.current++; controller.current?.abort(); inFlight.current = false;
      setFeed({ ...emptyFeed(key), continuation: { state: 'paused', cursor: null, retryAfterMs: null } });
    },
    refresh: (replace = false) => {
      generation.current++;
      controller.current?.abort();
      inFlight.current = false;
      seenCursors.current.clear();
      void load(null, replace);
    },
  };
}
