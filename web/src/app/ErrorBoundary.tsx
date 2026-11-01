import { policyDocument } from "../i18n/policies.ts";
import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { useInterfaceLocale } from "../i18n/LocaleProvider.tsx";
function PageFailure() {
  const { t, locale } = useInterfaceLocale();
  return <main className="paper"><h1>{t('This page could not load.')}</h1>
    <p>{t('Your saved data remains with the service.')}</p>
    <button className="button dark" onClick={() => location.reload()}>{t('Reload Justup')}</button>
    <p><a href={policyDocument(locale, "privacy")}>{t('Privacy')}</a> · <a href={policyDocument(locale, "usage")}>{t('Usage')}</a></p>
  </main>;
}
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(_error: Error, _info: ErrorInfo) { /* Error details remain private. */ }
  render() { return this.state.failed ? <PageFailure /> : this.props.children; }
}
