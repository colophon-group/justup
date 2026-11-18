// Sample sections share the validated public report in HTML and browser navigation.
import type { CompanyReport } from '../../api/types';
import { useInterfaceLocale } from '../../i18n/LocaleProvider';
import { metadataText, salaryText } from '../search/format';
import { reportDate } from './presentation';

function SampleBars({ items, sampleSize, number }: {
  items: { id: string; label: string; count: number }[];
  sampleSize: number;
  number: (value: number) => string;
}) {
  return <ul className="sample-roles">{items.map(item => <li key={item.id}>
    <div className="sample-role-label"><span>{item.label}</span><b>{number(item.count)}</b></div>
    <span className="sample-role-track" aria-hidden="true"><span style={{ width: `${item.count / sampleSize * 100}%` }} /></span>
  </li>)}</ul>;
}

export function CompanyReportSamples({ report }: { report: CompanyReport }) {
  const { t, locale } = useInterfaceLocale();
  if (report.freshness?.listings !== 'fresh') return null;
  const roles = report.hiringRoles?.state === 'available' && report.hiringRoles.items.length ? report.hiringRoles : null;
  const salaries = report.reportedSalaries?.state === 'available' && report.reportedSalaries.groups.length ? report.reportedSalaries : null;
  const experience = report.experienceMix?.state === 'available' && report.experienceMix.items.length ? report.experienceMix : null;
  const workplace = report.workplaceMix?.state === 'available' && report.workplaceMix.items.length ? report.workplaceMix : null;
  const size = roles?.sampleSize ?? salaries?.sampleSize ?? experience?.sampleSize ?? workplace?.sampleSize;
  if (size === undefined) return null;
  const number = (value: number) => value.toLocaleString(locale);
  const years = new Intl.NumberFormat(locale, { maximumFractionDigits: 20 });
  const experienceLabel = (min: number | null, max: number | null) => {
    if (min === null) return t('Up to {amount}', { amount: years.format(max!) });
    const from = years.format(min);
    if (max === null) return t('From {amount}', { amount: from });
    return min === max ? from : `${from}–${years.format(max)}`;
  };
  const labels = (sample: { labelledSampleSize: number; unknownSampleSize: number }) =>
    t('{labelled} labelled · {unknown} unlabelled', { labelled: number(sample.labelledSampleSize), unknown: number(sample.unknownSampleSize) });
  return <div className="company-samples">
    <div className="sample-heading">
      <span className="eyebrow">{t('Recent listing sample')}</span>
      <span>{t('Sample size: {count}', { count: number(size) })}</span>
      {report.scope ? <p>{t('First seen between {from} and {through}', { from: reportDate(report.scope.firstObservedFrom, locale), through: reportDate(report.scope.firstObservedThrough, locale) })}</p> : null}
      <p>{t('A sample of listings, not all company openings.')}</p>
    </div>
    <div className="sample-columns">
      {roles ? <section className="report-sample" aria-labelledby="company-roles-title">
        <h2 id="company-roles-title">{t('Hiring roles.')}</h2>
        <p className="sample-coverage">{labels(roles)}</p>
        <SampleBars items={roles.items.map(role => ({ ...role, label: role.name }))} sampleSize={size} number={number} />
      </section> : null}
      {salaries ? <section className="report-sample" aria-labelledby="company-salaries-title">
        <h2 id="company-salaries-title">{t('Reported salaries.')}</h2>
        <p className="sample-coverage">{t('{reported} reported · {unknown} not reported', { reported: number(salaries.reportedSampleSize), unknown: number(salaries.unknownSampleSize) })}</p>
        {salaries.incompleteSampleSize ? <p className="sample-excluded">{t('Incomplete values excluded: {count}', { count: number(salaries.incompleteSampleSize) })}</p> : null}
        <ul className="sample-salaries">{salaries.groups.map(group => <li key={JSON.stringify([group.currency, group.period])} data-currency={group.currency} data-period={group.period}>
          {group.min === null && group.max === null ? <><strong>{group.currency} / {metadataText(group.period, locale)}</strong><span>{t('Range unavailable')}</span></> : <strong>{salaryText(group, locale)}</strong>}
          <span>{t('Group sample: {count}', { count: number(group.sampleSize) })}</span>
        </li>)}</ul>
        <p className="sample-method">{t('Lowest reported minimum to highest reported maximum. Currencies and pay periods stay separate.')}</p>
      </section> : null}
      {experience ? <section className="report-sample" aria-labelledby="company-experience-title">
        <h2 id="company-experience-title">{t('Experience in years.')}</h2>
        <p className="sample-coverage">{labels(experience)}</p>
        <SampleBars items={experience.items.map(({ min, max, count }) =>
          ({ id: JSON.stringify([min, max]), label: experienceLabel(min, max), count }))} sampleSize={size} number={number} />
      </section> : null}
      {workplace ? <section className="report-sample" aria-labelledby="company-workplace-title">
        <h2 id="company-workplace-title">{t('Workplace mix.')}</h2>
        <p className="sample-coverage">{labels(workplace)}</p>
        <SampleBars items={workplace.items.map(({ mode, count }) =>
          ({ id: mode, label: metadataText(mode, locale), count }))} sampleSize={size} number={number} />
        <p className="sample-method">{t('A listing can report more than one workplace mode.')}</p>
      </section> : null}
    </div>
  </div>;
}
