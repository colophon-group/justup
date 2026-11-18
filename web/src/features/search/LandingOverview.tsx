import { pageHref } from '../../app/useRoute.ts';
import { useInterfaceLocale } from "../../i18n/LocaleProvider.tsx";
import { useEffect, useState } from 'react';
import type { PostingOriginDeadline } from '../../app/sessionCoherence.ts';
const features = [
  [
    "No sponsored listings.",
    "Employers can’t pay to move a job up. Matching results are always ordered newest first.",
  ],
  [
    "Last 14 days. Always.",
    "Each job shows when we first found it. Only jobs first observed in the last 14 days appear.",
  ],
  [
    "See what’s included.",
    "Browse the included companies and their original career-page links. Send us a lead for a company that’s missing.",
  ],
  [
    "The original source.",
    "Each result links to its reported employer source. Read the full description and apply there.",
  ],
] as const;
const verifiedSource = [
  "No agencies. No reposts.",
  "This verified edition lists jobs directly from employers. Open the original posting to read more and apply.",
] as const;

export function LandingOverview({ verifiedSourceUntil }: { verifiedSourceUntil: PostingOriginDeadline | null }) {
  const { t, locale } = useInterfaceLocale();
  const [confirmedUntil, setConfirmedUntil] = useState<PostingOriginDeadline | null>(null);
  const wall = verifiedSourceUntil?.wall ?? null, monotonic = verifiedSourceUntil?.monotonic ?? null;
  useEffect(() => {
    if (wall === null || monotonic === null) { setConfirmedUntil(null); return; }
    // Use both clocks so background sleep or a backwards wall-clock change
    // cannot extend an earlier source verification window.
    const remaining = Math.min(wall - Date.now(), monotonic - performance.now());
    if (remaining <= 0) { setConfirmedUntil(null); return; }
    setConfirmedUntil({ wall, monotonic });
    const timer = window.setTimeout(() => setConfirmedUntil(null), remaining);
    return () => window.clearTimeout(timer);
  }, [wall, monotonic]);
  const verified = confirmedUntil !== null && confirmedUntil.wall === wall && confirmedUntil.monotonic === monotonic;
  return (
    <section
      className="landing-overview"
      id="landing-overview"
      aria-labelledby="landing-overview-title"
    >
      <div className="landing-overview-lead">
        <span className="eyebrow">{t("THE JUSTUP WAY")}</span>
        <h2 id="landing-overview-title">{t("Beat the")}<br />{" "}{t("endless scroll.")}</h2>
      </div>
      <div className="landing-features">
        {features.map((feature, index) => {
          const source = index === features.length - 1;
          const [title, description] = source && verified ? verifiedSource : feature;
          return <article className="landing-feature" key={feature[0]} id={source ? 'landing-posting-origin' : undefined}>
            <span className="feature-number" aria-hidden="true">
              0{index + 1}
            </span>
            <div>
              <h3>{t(title)}</h3>
              <p>{t(description)}</p>
              {index === 2 ? (
                <a className="coverage-proof" href={pageHref("companies", locale)}>
                  <span className="coverage-label">{t("Browse included companies")}</span>
                  <span aria-hidden="true">↗</span>
                </a>
              ) : null}
            </div>
          </article>;
        })}
      </div>
    </section>
  );
}
