import type { Company, CompanyReport, Coverage } from '../api/types.ts';
import type { InterfaceLocale } from '../i18n/locales.ts';
import type { Route } from '../app/useRoute.ts';
export interface PublicBootstrap {
  route: Route;
  explicitLocale?: InterfaceLocale;
  renderedAt: string;
  companies?: Company[];
  coverage?: Coverage;
  catalogue?: { query: string; nextCursor: string | null; cursor: string | null };
  company?: Company;
  companyReport?: CompanyReport;
  outcome: 'ready' | 'not-found' | 'unavailable';
}
