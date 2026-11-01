import { pageHref } from '../../app/useRoute.ts';
import { useInterfaceLocale } from "../../i18n/LocaleProvider.tsx";
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
export function LandingOverview() {
  const { t, locale } = useInterfaceLocale();
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
        {features.map(([title, description], index) => (
          <article className="landing-feature" key={title}>
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
          </article>
        ))}
      </div>
    </section>
  );
}
