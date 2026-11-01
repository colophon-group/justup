import { policyDocument } from "../i18n/policies.ts";
import { useAccountLocale } from "../i18n/useAccountLocale.ts";
import { localeName } from "../i18n/locales.ts";
import { useInterfaceLocale } from "../i18n/LocaleProvider.tsx";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiClient, errorText, isAbortError } from "../api/client.ts";
import type { CompanyRequestPrefill, Session } from "../api/types.ts";
import { AccountControls } from "../features/account/AccountControls.tsx";
import type { AccountDialog } from "../features/account/AccountControls.tsx";
import { CompaniesPage } from "../features/companies/CompaniesPage.tsx";
import { CompanyPage } from "../features/companies/CompanyPage.tsx";
import { CompanyRequestPage } from "../features/companies/CompanyRequestPage.tsx";
import { SearchWorkspace } from "../features/search/SearchWorkspace.tsx";
import { useRoute } from "./useRoute.ts";
import { coverageDescription } from "../shared/coverage.ts";

export function App() {
  const { t, locale, explicitRequestLocale, notice: localizeNotice } = useInterfaceLocale();
  const expiryHandler = useRef<() => void>(() => {});
  const [client] = useState(
    () => new ApiClient({ onSessionExpired: () => expiryHandler.current() }),
  );
  useLayoutEffect(() => {
    client.setExplicitRequestLocale(explicitRequestLocale);
  }, [client, explicitRequestLocale]);
  const [session, setSession] = useState<Session | null>(null),
    [notice, setNotice] = useState("Connecting to the edition…"),
    [connecting, setConnecting] = useState(true),
    [epoch, setEpoch] = useState(0);
  const [companyPrefill, setCompanyPrefill] =
    useState<CompanyRequestPrefill | null>(null);
  const consumePrefill = useCallback(() => setCompanyPrefill(null), []);
  const requestCompany = useCallback((prefill: CompanyRequestPrefill) => {
    setCompanyPrefill(prefill);
    location.hash = "request";
  }, []);
  const [dialog, setDialog] = useState<AccountDialog>(null),
    [signInReason, setSignInReason] = useState("Sign in to save your edition.");
  const [reducedMotion, setReducedMotion] = useState(
      () => matchMedia("(prefers-reduced-motion: reduce)").matches,
    ),
    [backToTop, setBackToTop] = useState(false);
  const sessionRef = useRef<Session | null>(null),
    sessionRequest = useRef<AbortController | null>(null),
    requestGeneration = useRef(0);
  const route = useRoute();
  const topLink = useRef<HTMLAnchorElement>(null),
    mainRef = useRef<HTMLElement>(null);
  const openSignIn = useCallback((reason = "Sign in to save your edition.") => {
    setSignInReason(reason);
    setDialog("sign-in");
  }, []);
  const clearPrivate = useCallback(() => {
    client.setSession(null);
    sessionRef.current = null;
    setSession(null);
    setCompanyPrefill(null);
    setEpoch((value) => value + 1);
    setDialog(null);
  }, [client]);
  expiryHandler.current = () => {
    requestGeneration.current++;
    sessionRequest.current?.abort();
    clearPrivate();
    setConnecting(false);
    setNotice("Your session expired. Reconnect before signing in again.");
    setSignInReason("Your session expired. Reconnect before signing in again.");
    setDialog("sign-in");
  };
  const refreshSession = useCallback(async () => {
    const generation = ++requestGeneration.current;
    sessionRequest.current?.abort();
    const controller = new AbortController();
    sessionRequest.current = controller;
    setConnecting(true);
    setNotice("Connecting to the edition…");
    try {
      const next = await client.getSession(controller.signal);
      if (generation !== requestGeneration.current || controller.signal.aborted)
        return;
      if (
        sessionRef.current?.user &&
        sessionRef.current.user.id !== next.user?.id
      ) {
        setEpoch((value) => value + 1);
        setCompanyPrefill(null);
      }
      sessionRef.current = next;
      client.setSession(next);
      setSession(next);
      setNotice("");
    } catch (error) {
      if (generation === requestGeneration.current && !isAbortError(error))
        setNotice(errorText(error));
    } finally {
      if (generation === requestGeneration.current) setConnecting(false);
    }
  }, [client]);
  const signedOut = useCallback(async () => {
    clearPrivate();
    location.hash = "jobs";
    await refreshSession();
  }, [clearPrivate, refreshSession]);
  useEffect(() => {
    void refreshSession();
    return () => {
      requestGeneration.current++;
      sessionRequest.current?.abort();
    };
  }, [refreshSession]);
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    document.body.classList.toggle("reduce-motion", reducedMotion);
    return () => document.body.classList.remove("reduce-motion");
  }, [reducedMotion]);
  useEffect(() => {
    const update = () => setBackToTop(scrollY > 500);
    window.addEventListener("scroll", update, { passive: true });
    update();
    return () => window.removeEventListener("scroll", update);
  }, []);
  useEffect(() => {
    document.title = `Justup — ${route.page === "companies" ? t("Company catalogue") : route.page === "company" ? t("Hiring report") : route.page === "request" ? t("Request a company") : t("Fresh work. Clear sources.")}`;
  }, [route.page, t]);
  const interfaceLanguage = useAccountLocale(client, session);
  const previousLocale = useRef({ locale, explicitRequestLocale });
  useEffect(() => {
    if (previousLocale.current.locale === locale && previousLocale.current.explicitRequestLocale === explicitRequestLocale) return;
    previousLocale.current = { locale, explicitRequestLocale };
    void refreshSession();
  }, [locale, explicitRequestLocale, refreshSession]);
  const coverage = session?.coverage;
  return (
    <>
      <a
        className="skip"
        href="#main"
        onClick={(event) => {
          event.preventDefault();
          mainRef.current?.focus();
        }}
      >{t("Skip to content")}</a>
      <div className="edition-note">
        <span>{t("Interface: {language}", { language: localeName[locale] })}</span>
        <span>{t("Fresh work. Clear sources.")}</span>
      </div>
      <div className="paper">
        <header className="topbar">
          <nav aria-label={t("Main navigation")}>
            <a
              ref={topLink}
              href="#jobs"
              aria-current={route.page === "jobs" ? "page" : undefined}
            >{t("Positions")}</a>
            <a
              href="#companies"
              aria-current={route.page === "companies" ? "page" : undefined}
            >{t("Companies")}</a>
          </nav>
          <span id="edition-date">
            {new Date().toLocaleDateString(locale, {
              weekday: "short",
              day: "numeric",
              month: "long",
            })}
          </span>
          {session?.user ? null : (
            <button
              className="header-sign-in"
              id="header-sign-in"
              onClick={() => openSignIn()}
            >{t("Sign in")}</button>
          )}
          <button
            className="account"
            id="account-open"
            aria-label={t("Settings")}
            aria-haspopup="dialog"
            onClick={() => setDialog("settings")}
          >
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="m9 3-.8 2.5-2.4 1L3.5 6 2 8.6l1.7 1.9v3L2 15.4 3.5 18l2.3-.5 2.4 1L9 21h6l.8-2.5 2.4-1 2.3.5 1.5-2.6-1.7-1.9v-3L22 8.6 20.5 6l-2.3.5-2.4-1L15 3Z" />
            </svg>
            <span>{t("Settings")}</span>
          </button>
        </header>
        <div className="masthead">
          <a className="brand" href="#jobs" aria-label={t("Justup home")}>
            JUST<span>UP.</span>
          </a>
          <p className="motto">{t("Fresh work.")}<br />{t("Clear sources.")}</p>
          <span className="live">
            <i />
            <span id="live-label">
              {connecting
                ? t("CONNECTING")
                : session
                  ? t("LIVE EDITION")
                  : t("SERVICE UNAVAILABLE")}
            </span>
          </span>
        </div>
        <main ref={mainRef} id="main" tabIndex={-1}>
          <div
            id="service-notice"
            className="service-notice"
            role="status"
            hidden={!notice}
          >
            <p>{localizeNotice(notice)}</p>
            {!connecting ? (
              <button
                id="retry-session"
                className="button outline"
                onClick={() => void refreshSession()}
              >{t("Reconnect")}</button>
            ) : null}
          </div>
          <SearchWorkspace
            key={`search-${epoch}`}
            client={client}
            session={session}
            active={route.page === "jobs"}
            reducedMotion={reducedMotion}
            onSignIn={openSignIn}
            dialogOpen={dialog !== null}
            onCompanyRequest={requestCompany}
            onAccount={() => setDialog("settings")}
          />
          <CompaniesPage
            key={`companies-${epoch}`}
            client={client}
            active={route.page === "companies"}
            connected={!!session}
          />
          {route.page === "company" ? (
            <CompanyPage
              key={`${epoch}:${route.id}`}
              client={client}
              id={route.id}
            />
          ) : null}
          <CompanyRequestPage
            key={`request-${epoch}`}
            client={client}
            session={session}
            active={route.page === "request"}
            onSignIn={openSignIn}
            accountEpoch={epoch}
            prefill={companyPrefill}
            onPrefillConsumed={consumePrefill}
          />
          {route.page === "invalid" ? (
            <section>
              <h1>{t("Page not found.")}</h1>
              <a className="button dark" href="#jobs">{t("Back to search ↗")}</a>
            </section>
          ) : null}
        </main>
        <footer className="policy-footer">
          <p id="coverage-disclosure">
            {coverageDescription(coverage, locale)}
          </p>
          <nav aria-label={t("Legal")}>
            <a href={policyDocument(locale, "privacy")}>{t("Privacy")}</a>
            <a href={policyDocument(locale, "usage")}>{t("Usage")}</a>
          </nav>
        </footer>
      </div>
      <AccountControls
        key={`account-${epoch}`}
        client={client}
        session={session}
        interfaceLanguage={interfaceLanguage}
        dialog={dialog}
        onDialogChange={setDialog}
        onSessionRefresh={refreshSession}
        onSignedOut={signedOut}
        reducedMotion={reducedMotion}
        onReducedMotionChange={setReducedMotion}
        signInReason={signInReason}
      />
      <button
        className="back-to-top"
        id="back-to-top"
        aria-label={t("Back to top")}
        title={t("Back to top")}
        hidden={!backToTop}
        onClick={() => {
          window.scrollTo({
            top: 0,
            behavior: reducedMotion ? "instant" : "smooth",
          });
          topLink.current?.focus({ preventScroll: true });
        }}
      >
        <span aria-hidden="true">↑</span>
      </button>
    </>
  );
}
