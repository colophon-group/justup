import { useRef } from "react";
import type { ApiClient } from "../../api/client.ts";
import type { Search } from "../../api/types.ts";
import { useViewportReveal } from "../../shared/useViewportReveal.ts";
import { JobRow } from "./JobRow.tsx";
import { useFeed } from "./useFeed.ts";
interface Props {
  client: ApiClient;
  search: Search;
  active: boolean;
  paused: boolean;
  reducedMotion: boolean;
}
export function ResultFeed({
  client,
  search,
  active,
  paused,
  reducedMotion,
}: Props) {
  const { feed, next, retry } = useFeed(client, search, active && !paused),
    tailRef = useRef<HTMLDivElement>(null);
  const canContinue =
    !feed.error &&
    !!feed.continuation.cursor &&
    ["open", "pending"].includes(feed.continuation.state);
  const { visible, initialCount } = useViewportReveal({
    items: feed.jobs,
    resetKey: feed.key,
    tailRef,
    active: active && !paused,
    loading: feed.loading,
    hasMore: canContinue,
    onNeedMore: next,
    delayMs:
      feed.continuation.retryAfterMs ??
      (feed.continuation.state === "pending" ? 2000 : 450),
  });
  const buffered = feed.jobs.length > visible.length;
  let status;
  if (feed.error)
    status = (
      <>
        {feed.error}{" "}
        <button className="text-link" id="retry-results" onClick={retry}>
          Retry
        </button>
      </>
    );
  else if (feed.loading || buffered || feed.continuation.state === "pending")
    status = (
      <span className="looking">
        <span className="looking-mark" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        Still checking for matching positions…
      </span>
    );
  else if (
    feed.continuation.state === "paused" ||
    feed.continuation.state === "failed"
  )
    status = (
      <>
        {feed.continuation.state === "failed"
          ? "Requirement checks failed. These positions are not included."
          : "Search paused. There may be more matches."}{" "}
        <button className="text-link" id="resume-results" onClick={retry}>
          Check again
        </button>
      </>
    );
  else if (feed.continuation.state === "exhausted")
    status = feed.jobs.length
      ? "You’re through the available matches."
      : "No matching positions found in the completed search.";
  else
    status = (
      <>
        More results are not available yet.{" "}
        <button className="text-link" id="resume-results" onClick={retry}>
          Check again
        </button>
      </>
    );
  return (
    <>
      <p id="live-status" className="small-print" role="status">
        Live updates unavailable · refresh your search to check
      </p>
      <div id="search-results">
        <div className="section-heading feed-heading">
          <h1>Just in.</h1>
          <span className="eyebrow">Last 14 days</span>
          <span className="feed-order">Newest first</span>
        </div>
        <div className="column-labels" aria-hidden="true">
          <span>First seen</span>
          <span>Position</span>
          <span>Employer / source</span>
          <span>Open</span>
        </div>
        <div id="feed">
          {visible.map((job, index) => (
            <JobRow
              key={job.id}
              job={job}
              animated={index >= initialCount}
              reducedMotion={reducedMotion}
            />
          ))}
        </div>
        <div id="feed-tail" ref={tailRef}>
          <div id="feed-status" role="status" aria-live="polite">
            {status}
            {feed.ai.pending ? (
              <span className="end-note">
                {feed.ai.pending} positions still awaiting requirement checks.
              </span>
            ) : null}
            {feed.ai.failed ? (
              <span className="end-note">
                {feed.ai.failed} checks failed. These positions are not
                included.
              </span>
            ) : null}
            {feed.ai.insufficientEvidence ? (
              <span className="end-note">
                {feed.ai.insufficientEvidence} positions lack enough evidence to
                confirm a match.
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}
