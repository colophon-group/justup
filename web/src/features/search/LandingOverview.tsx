const features = [
  [
    "No sponsored listings.",
    "Employers can’t pay to move a job up. Matching results are always ordered newest first.",
  ],
  [
    "Last 14 days. Always.",
    "Each job shows when we first found it. Only jobs first observed in the last 14 days appear. Source coverage and verification are shown below.",
  ],
  [
    "See what’s included.",
    "Browse the included companies and their original career-page links. Send us a lead for a company that’s missing.",
  ],
  [
    "The original source.",
    "Each result links to its reported employer source. Read the full description and apply there.",
  ],
];
export function LandingOverview() {
  return (
    <section
      className="landing-overview"
      id="landing-overview"
      aria-labelledby="landing-overview-title"
    >
      <div className="landing-overview-lead">
        <span className="eyebrow">THE JUSTUP WAY</span>
        <h2 id="landing-overview-title">
          Beat the
          <br /> endless scroll.
        </h2>
      </div>
      <div className="landing-features">
        {features.map(([title, description], index) => (
          <article className="landing-feature" key={title}>
            <span className="feature-number" aria-hidden="true">
              0{index + 1}
            </span>
            <div>
              <h3>{title}</h3>
              <p>{description}</p>
              {index === 2 ? (
                <a className="coverage-proof" href="#companies">
                  <span className="coverage-label">
                    Browse included companies
                  </span>
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
