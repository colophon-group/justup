import { pageHref } from '../../app/useRoute.ts';
import { useInterfaceLocale } from "../../i18n/LocaleProvider.tsx";
import { useEffect, useRef } from "react";
import type { Job } from "../../api/types.ts";
import { CompanyMark } from "../../shared/CompanyMark.tsx";
import { ageText, salaryText, metadataText } from "./format.ts";
export function JobRow({
  job,
  animated,
  reducedMotion,
}: {
  job: Job;
  animated: boolean;
  reducedMotion: boolean;
}) {
  const { t, locale } = useInterfaceLocale();
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
    pay = salaryText(job.salary, locale);
  const locations = job.locations.map((location) => location.name).join(", "),
    workplace = [
      ...new Set(
        job.locations.map((location) => location.workplace ? metadataText(location.workplace, locale) : null).filter(Boolean),
      ),
    ].join(", ");
  return (
    <div className="job-slot">
      <article
        ref={row}
        className={`job list-row clickable-row${job.viewed ? " viewed" : ""}${job.isNew ? " is-new" : ""}`}
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
          {job.isNew ? <span className="new-badge">{t("New")}</span> : null}
          <time
            dateTime={job.firstObserved}
            title={t("First observed {date}", { date: new Date(job.firstObserved).toLocaleDateString(locale) })}
          >
            {ageText(job.firstObserved, locale)}
          </time>
        </div>
        <div className="job-story">
          <h2 className="job-title">
            <a
              ref={posting}
              className="posting-link row-link"
              href={job.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
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
                  .map((value) => metadataText(value, locale))
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
            href={pageHref("company", locale, job.company.id)}
          >
            <CompanyMark company={job.company} />
            <span>{job.company.name}</span>
          </a>
          <p className="job-source">{t("Direct from employer")}</p>
        </div>
        <span className="open-posting" aria-hidden="true">
          ↗
        </span>
      </article>
    </div>
  );
}
