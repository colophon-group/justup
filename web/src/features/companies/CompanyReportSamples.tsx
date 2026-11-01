// Sample sections share the validated public report in HTML and browser navigation.
import type { CompanyReport } from '../../api/types';
import { useInterfaceLocale } from '../../i18n/LocaleProvider';
import { metadataText, salaryText } from '../search/format';
import { reportDate } from './presentation';

export function CompanyReportSamples({ report }: { report: CompanyReport }) {
  const { t, locale } = useInterfaceLocale();
  if (report.freshness?.listings !== 'fresh') return null;
  const roles = report.hiringRoles?.state === 'available' && report.hiringRoles.items.length ? report.hiringRoles : null;
  const salaries = report.reportedSalaries?.state === 'available' && report.reportedSalaries.groups.length ? report.reportedSalaries : null;
  if (!roles && !salaries) return null;
  const number = (value: number) => value.toLocaleString(locale);
  const size = roles?.sampleSize ?? salaries!.sampleSize;
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
        <p className="sample-coverage">{t('{labelled} labelled · {unknown} unlabelled', { labelled: number(roles.labelledSampleSize), unknown: number(roles.unknownSampleSize) })}</p>
        <ul className="sample-roles">{roles.items.map(role => <li key={role.id}>
          <div className="sample-role-label"><span>{role.name}</span><b>{number(role.count)}</b></div>
          <span className="sample-role-track" aria-hidden="true"><span style={{ width: `${role.count / roles.sampleSize * 100}%` }} /></span>
        </li>)}</ul>
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
    </div>
  </div>;
}
