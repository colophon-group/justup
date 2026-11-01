import { useEffect, useRef } from "react";
import type { Job } from "../../api/types.ts";
import { CompanyMark } from "../../shared/CompanyMark.tsx";
import { ageText, salaryText } from "./format.ts";
export function JobRow({
  job,
  animated,
  reducedMotion,
  viewed,
  onViewed,
}: {
  job: Job;
  animated: boolean;
  reducedMotion: boolean;
  viewed: boolean;
  onViewed?: ((jobId: string) => void) | undefined;
}) {
  const row = useRef<HTMLElement>(null),
    animate = useRef(animated && !reducedMotion);
  useEffect(() => {
    if (!animate.current) return;
    const motion = row.current?.animate(
      [
        { opacity: 0.2, clipPath: "inset(0 0 85% 0)" },
        { opacity: 1, clipPath: "inset(0)" },
      ],
      { duration: 450, easing: "cubic-bezier(.2,.7,.25,1)" },
    );
    return () => motion?.cancel();
  }, []);
  const posting = useRef<HTMLAnchorElement>(null),
    pay = salaryText(job.salary);
  const locations = job.locations.map((location) => location.name).join(", "),
    workplace = [
      ...new Set(
        job.locations.map((location) => location.workplace).filter(Boolean),
      ),
    ].join(", ");
  return (
    <div className="job-slot">
      <article
        ref={row}
        className={`job list-row clickable-row${viewed ? " viewed" : ""}${job.isNew && !viewed ? " is-new" : ""}`}
        data-job={job.id}
        onClick={(event) => {
          if (
            !(event.target instanceof Element) ||
            event.target.closest("a,button")
          )
            return;
          posting.current?.click();
        }}
      >
        <div className="job-age">
          {job.isNew ? <span className="new-badge" aria-hidden={viewed} style={{ visibility: viewed ? "hidden" : "visible" }}>New</span> : null}
          <time
            dateTime={job.firstObserved}
            title={`First observed ${new Date(job.firstObserved).toLocaleDateString("en")}`}
          >
            {ageText(job.firstObserved)}
          </time>
          <svg viewBox="0 0 20 14" width="14" height="12" fill="none" stroke="currentColor" strokeWidth="1.5"
            role={viewed ? "img" : undefined} aria-label={viewed ? "Viewed" : undefined} aria-hidden={!viewed}
            style={{ marginLeft: 6, verticalAlign: "middle", visibility: viewed ? "visible" : "hidden" }}>
            <path d="M1 7c3-7 15-7 18 0-3 7-15 7-18 0Z" /><circle cx="10" cy="7" r="2.5" />
          </svg>
        </div>
        <div className="job-story">
          <h2 className="job-title">
            <a
              ref={posting}
              className="posting-link row-link"
              href={job.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => onViewed?.(job.id)}
              onAuxClick={event => { if (event.button === 1) onViewed?.(job.id); }}
            >
              {job.title}
            </a>
          </h2>
          <div className="job-facts">
            {locations ? (
              <span>
                <span aria-hidden="true">⌖ </span>
                {locations}
              </span>
            ) : null}
            {workplace ? <span>{workplace}</span> : null}
            {job.employmentTypes.length ? (
              <span>
                {job.employmentTypes
                  .map((value) => value.replaceAll("_", " "))
                  .join(", ")}
              </span>
            ) : null}
          </div>
          {pay ? (
            <span className="job-salary">
              <span aria-hidden="true">¤ </span>
              {pay}
            </span>
          ) : null}
        </div>
        <div className="job-employer">
          <a
            className="job-company"
            href={`#company/${encodeURIComponent(job.company.id)}`}
          >
            <CompanyMark company={job.company} />
            <span>{job.company.name}</span>
          </a>
          <p className="job-source">Direct from employer</p>
        </div>
        <span className="open-posting" aria-hidden="true">
          ↗
        </span>
      </article>
    </div>
  );
}
