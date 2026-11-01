import { useRef } from "react";
import type { ApiClient } from "../../api/client.ts";
import type { Search, Session } from "../../api/types.ts";
import { useViewportReveal } from "../../shared/useViewportReveal.ts";
import { JobRow } from "./JobRow.tsx";
import { useFeed } from "./useFeed.ts";
interface Props {
  client: ApiClient;
  search: Search;
  active: boolean;
  paused: boolean;
  reducedMotion: boolean;
  session: Session | null;
  onSignIn: (reason?: string) => void;
  onAccount: () => void;
}
export function ResultFeed({
  client,
  search,
  active,
  paused,
  reducedMotion,
  session,
  onSignIn,
  onAccount,
}: Props) {
  const { feed, next, retry, refresh } = useFeed(client, search, active && !paused),
    tailRef = useRef<HTMLDivElement>(null);
  const canContinue =
    !feed.error &&
    !!feed.continuation.cursor &&
    ["open", "pending"].includes(feed.continuation.state);
  const { visible, initialCount } = useViewportReveal({
    items: feed.jobs,
    resetKey: `${feed.key}:${feed.bufferVersion}`,
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
        {feed.coverage?.stale || feed.coverage?.state === "import_unavailable"
          ? feed.coverage.description || "Imported listings need verification."
          : feed.continuation.state === "failed"
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
        Check the latest results without changing your search.{" "}
        <button className="text-link" id="refresh-results" disabled={feed.loading || paused} onClick={refresh}>
          Check for new positions
        </button>
      </p>
      <div id="search-results">
        <div className="section-heading feed-heading">
          <h1>Just in.</h1>
          <span className="eyebrow">Last 14 days</span>
          <span className="feed-order">Newest first</span>
        </div>
        {feed.hidden && feed.hidden.count > 0 ? (
          <section id="hidden-matches" className="hidden-matches" aria-labelledby="hidden-matches-title">
            <div className="compressed-matches" aria-hidden="true"><i /><i /><i /></div>
            <div className="hidden-matches-prompt">
              <div>
                <span className="eyebrow">More in this edition</span>
                <h2 id="hidden-matches-title">{feed.hidden.exact ? '' : 'At least '}{feed.hidden.count.toLocaleString('en')} recent {feed.hidden.count === 1 ? 'match' : 'matches'} hidden</h2>
                <p>{session?.user ? 'Your current account access does not include these matches.' : 'Sign in to see the newest matches.'}</p>
              </div>
              <button className="button dark" onClick={() => session?.user ? onAccount() : onSignIn('Sign in to see the newest matches.')}>
                {session?.user ? 'Account access ↗' : 'Sign in ↗'}
              </button>
            </div>
          </section>
        ) : null}
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
