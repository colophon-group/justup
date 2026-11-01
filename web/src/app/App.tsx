import { policyDocument } from "../i18n/policies.ts";
import { useAccountLocale } from "../i18n/useAccountLocale.ts";
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
import { useRoute, pageHref, navigate } from "./useRoute.ts";
import type { PublicBootstrap } from "../public/bootstrap.ts";
import { coverageDescription } from "../shared/coverage.ts";
import { HiringWire } from "../features/news/HiringWire.tsx";
import { sessionOwner } from '../api/sessionOwner.ts';
import { expiredSessionSnapshot, nextSessionDeadline, openSessionSignals, sessionDeadlineRemaining } from './sessionCoherence.ts';

export function App({ initialPublicPage }: { initialPublicPage?: PublicBootstrap | undefined }) {
  const { t, locale, explicitRequestLocale, notice: localizeNotice } = useInterfaceLocale();
  const [interactive, setInteractive] = useState(!initialPublicPage);
  useEffect(() => setInteractive(true), []);
  const expiryHandler = useRef<() => void>(() => {});
  const visitorExpiryHandler = useRef<() => void>(() => {});
  const authenticationChanged = useRef<() => void>(() => {});
  const ownAuthentication = useRef(false);
  const signalBus = useRef<ReturnType<typeof openSessionSignals> | null>(null);
  const [client] = useState(
    () => new ApiClient({ onSessionExpired: () => expiryHandler.current(), onVisitorExpired: () => visitorExpiryHandler.current(), onAuthenticationChanged: () => authenticationChanged.current() }),
  );
  useLayoutEffect(() => {
    client.setExplicitRequestLocale(explicitRequestLocale);
  }, [client, explicitRequestLocale]);
  const workspaceBridge = useRef<{ flush: (signal?: AbortSignal) => Promise<void> } | null>(null);
  const persistenceReady = useCallback((bridge: typeof workspaceBridge.current) => { workspaceBridge.current = bridge; }, []);
  const beforeAuthenticate = useCallback(async (signal: AbortSignal) => { await workspaceBridge.current?.flush(signal); }, []);
  const [session, setSession] = useState<Session | null>(null),
    [notice, setNotice] = useState("Connecting to the edition…"),
    [connecting, setConnecting] = useState(true),
    [epoch, setEpoch] = useState(0),
    [searchGeneration, setSearchGeneration] = useState(0);
  const [quarantined, setQuarantined] = useState(false);
  const [sessionStartedAt, setSessionStartedAt] = useState(0);
  const heldFocus = useRef<{ element: HTMLElement | null; x: number; y: number; selection: [number | null, number | null] | null } | null>(null);
  const consumedDeadline = useRef<string | null>(null);
  const [companyPrefill, setCompanyPrefill] =
    useState<CompanyRequestPrefill | null>(null);
  const consumePrefill = useCallback(() => setCompanyPrefill(null), []);

  const [dialog, setDialog] = useState<AccountDialog>(null),
    [signInReason, setSignInReason] = useState("Sign in to save your edition.");
  const [reducedMotion, setReducedMotion] = useState(
      () => false,
    ),
    [backToTop, setBackToTop] = useState(false);
  const sessionRef = useRef<Session | null>(null),
    sessionRequest = useRef<AbortController | null>(null),
    requestGeneration = useRef(0);
  const route = useRoute(initialPublicPage?.route);
  const requestCompany = useCallback((prefill: CompanyRequestPrefill) => { setCompanyPrefill(prefill); navigate(pageHref("request", locale)); }, [locale]);
  const publicPage = initialPublicPage?.route.locale === route.locale && initialPublicPage.route.page === route.page && (route.page !== "company" || (initialPublicPage.route.page === "company" && initialPublicPage.route.id === route.id)) ? initialPublicPage : undefined;
  const [editionDate] = useState(() => initialPublicPage?.renderedAt ?? new Date().toISOString());
  const topLink = useRef<HTMLAnchorElement>(null),
    mainRef = useRef<HTMLElement>(null);
  const focusMain = useCallback(() => mainRef.current?.focus({ preventScroll: true }), []);
  const openSignIn = useCallback((reason = "Sign in to save your edition.") => {
    setSignInReason(reason);
    setDialog("sign-in");
  }, []);
  const clearPrivate = useCallback(() => {
    heldFocus.current = null;
    setQuarantined(false);
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
  visitorExpiryHandler.current = () => {
    requestGeneration.current++;
    sessionRequest.current?.abort();
    clearPrivate();
    setConnecting(false);
    setNotice("Your visitor search session expired. Reconnect to start a new search.");
  };
  const refreshSession = useCallback(async (expectedReclamation = false) => {
    const generation = ++requestGeneration.current;
    sessionRequest.current?.abort();
    const previous = sessionRef.current;
    const localAuthentication = ownAuthentication.current;
    ownAuthentication.current = false;
    if (previous && !heldFocus.current) {
      const element = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      heldFocus.current = { element, x: scrollX, y: scrollY,
        selection: element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement ? [element.selectionStart, element.selectionEnd] : null };
    }
    if (previous) for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog[open]')) dialog.close();
    client.suspendSession();
    setQuarantined(Boolean(previous));
    const controller = new AbortController();
    sessionRequest.current = controller;
    const startedAt = Date.now();
    setConnecting(true);
    if (!previous) setNotice("Connecting to the edition…");
    try {
      const next = await client.getSession(controller.signal);
      if (generation !== requestGeneration.current || controller.signal.aborted)
        return;
      if (expiredSessionSnapshot(next, startedAt)) throw new Error("Your session expired. Reconnect before signing in again.");
      const changedOwner = sessionOwner(previous) !== sessionOwner(next);
      const reclaimedVisitor = expectedReclamation && previous && !previous.user && !next.user && previous.visitor && next.visitor === null;
      const sameGuestBootstrap = previous && !previous.user && !next.user && !previous.visitor && next.visitor && previous.csrfToken === next.csrfToken;
      if (previous && !previous.user && next.user && localAuthentication) {
        heldFocus.current = null;
        // Search handoff must reload the merged server workspace, while a
        // company lead prepared by this visitor remains in its own editor.
        setSearchGeneration((value) => value + 1);
        setDialog(null);
      } else if (previous && changedOwner && !reclaimedVisitor && !sameGuestBootstrap) {
        heldFocus.current = null;
        setEpoch((value) => value + 1);
        setCompanyPrefill(null);
        setDialog(null);
      }
      sessionRef.current = next;
      client.setSession(next, Boolean(reclaimedVisitor || sameGuestBootstrap));
      setSession(next);
      setSessionStartedAt(startedAt);
      setQuarantined(false);
      setNotice("");
    } catch (error) {
      if (generation === requestGeneration.current && !isAbortError(error))
        setNotice(errorText(error));
    } finally {
      if (generation === requestGeneration.current) { setConnecting(false); sessionRequest.current = null; }
    }
  }, [client]);
  authenticationChanged.current = () => { ownAuthentication.current = true; signalBus.current?.notify(); };
  useLayoutEffect(() => {
    if (quarantined || !heldFocus.current) return;
    const held = heldFocus.current, generation = requestGeneration.current;
    heldFocus.current = null;
    if (generation !== requestGeneration.current) return;
    if (held.element?.isConnected) {
      held.element.focus({ preventScroll: true });
      if (held.selection && (held.element instanceof HTMLTextAreaElement || held.element instanceof HTMLInputElement)
        && held.selection[0] !== null && held.selection[1] !== null) held.element.setSelectionRange(...held.selection as [number, number]);
    }
    window.scrollTo({ left: held.x, top: held.y, behavior: 'instant' });
  }, [quarantined, session]);
  useEffect(() => {
    let queued = false;
    const resume = () => {
      if (document.visibilityState === 'hidden' || queued || sessionRequest.current) return;
      queued = true;
      queueMicrotask(() => { queued = false; if (!sessionRequest.current && document.visibilityState !== 'hidden') void refreshSession(); });
    };
    const bus = openSessionSignals(() => { void refreshSession(); });
    signalBus.current = bus;
    window.addEventListener('pageshow', resume);
    document.addEventListener('visibilitychange', resume);
    return () => { bus.close(); signalBus.current = null; window.removeEventListener('pageshow', resume); document.removeEventListener('visibilitychange', resume); };
  }, [refreshSession]);
  useEffect(() => {
    if (!session || quarantined) return;
    const delay = nextSessionDeadline(session, sessionStartedAt, Date.now());
    if (delay === null) return;
    const key = JSON.stringify([sessionOwner(session), session.user ? session.expiresAt : session.visitor?.expiresAt, session.access.fullAccess ? session.access.until : null]);
    if (consumedDeadline.current === key) return;
    const timer = setTimeout(() => {
      if ((sessionDeadlineRemaining(session, sessionStartedAt, Date.now()) ?? Infinity) <= 0) consumedDeadline.current = key;
      void refreshSession();
    }, delay);
    return () => clearTimeout(timer);
  }, [session, sessionStartedAt, quarantined, refreshSession]);
  const rebootstrapVisitor = useCallback(async () => {
    const previous = sessionRef.current;
    await refreshSession(true);
    const next = sessionRef.current;
    if (!next || next === previous || next.user || !next.capabilities.visitorSearch
      || previous?.visitor && next.visitor && previous.visitor.expiresAt !== next.visitor.expiresAt)
      throw new Error("Reconnect the saved workspace before continuing.");
  }, [refreshSession]);
  const signedOut = useCallback(async () => {
    clearPrivate();
    navigate(pageHref("jobs", route.locale));
    await refreshSession();
  }, [clearPrivate, refreshSession, route.locale]);
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
    update();
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
    let canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!canonical) { canonical = document.createElement('link'); canonical.rel = 'canonical'; document.head.append(canonical); }
    canonical.href = new URL(route.page === 'invalid' ? location.pathname : route.page === 'company' ? pageHref('company', route.locale, route.id) : route.page === 'companies' ? pageHref('companies', route.locale) : pageHref('jobs', route.locale).split('#')[0]!, location.origin).href;
    if (route.page === 'invalid' || publicPage?.outcome === 'not-found') { document.title = `${t('Page not found')} — Justup`; return; }
    if (publicPage?.outcome === 'unavailable') { document.title = `${t('Coverage temporarily unavailable')} — Justup`; return; }
    if (route.page === "company") return;
    document.title = `Justup — ${route.page === "companies" ? t("Company catalogue") : route.page === "request" ? t("Request a company") : t("Fresh work. Clear sources.")}`;
  }, [route, publicPage, t]);
  const interfaceLanguage = useAccountLocale(client, session);
  const previousLocale = useRef({ locale, explicitRequestLocale });
  useEffect(() => {
    if (previousLocale.current.locale === locale && previousLocale.current.explicitRequestLocale === explicitRequestLocale) return;
    previousLocale.current = { locale, explicitRequestLocale };
    void refreshSession();
  }, [locale, explicitRequestLocale, refreshSession]);
  const coverage = session?.coverage ?? publicPage?.coverage;
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
      <div className="paper">
        <header className="topbar">
          <nav aria-label={t("Main navigation")}>
            <a
              ref={topLink}
              href={pageHref("jobs", locale)}
              aria-current={route.page === "jobs" ? "page" : undefined}
            >{t("Positions")}</a>
            <a
              href={pageHref("companies", locale)}
              aria-current={route.page === "companies" ? "page" : undefined}
            >{t("Companies")}</a>
          </nav>
          <span id="edition-date">
            {new Date(editionDate).toLocaleDateString(locale, {
              weekday: "short",
              day: "numeric",
              month: "long",
              timeZone: "UTC",
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
          <a className="brand" href={pageHref("jobs", locale)} aria-label={t("Justup home")}>
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
        <HiringWire client={client} connected={!!session} generation={epoch} reducedMotion={reducedMotion} dialogOpen={dialog !== null} onFocusExit={focusMain} />
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
          <div id="session-private-surfaces" style={{ visibility: quarantined ? 'hidden' : undefined }} inert={quarantined || undefined} aria-busy={quarantined}>
          {interactive || route.page === "jobs" ? <SearchWorkspace
            key={`search-${epoch}-${searchGeneration}`}
            client={client}
            session={session}
            active={route.page === "jobs"}
            reducedMotion={reducedMotion}
            onSignIn={openSignIn}
            dialogOpen={dialog !== null}
            onCompanyRequest={requestCompany}
            onAccount={() => setDialog("settings")}
            onPersistenceReady={persistenceReady}
            onVisitorRebootstrap={rebootstrapVisitor}
          /> : null}
          {interactive || route.page === "companies" ? <CompaniesPage
            key={`companies-${epoch}`}
            client={client}
            active={route.page === "companies" && publicPage?.outcome !== "unavailable"}
            initialCompanies={publicPage?.companies}
            initialCatalogue={publicPage?.catalogue}
          /> : null}
          {route.page === "company" && publicPage?.outcome !== "unavailable" && publicPage?.outcome !== "not-found" ? (
            <CompanyPage
              key={`${epoch}:${route.id}`}
              client={client}
              id={route.id}
              initialCompany={initialPublicPage?.company?.id === route.id ? initialPublicPage.company : undefined}
            />
          ) : null}
          {interactive ? <CompanyRequestPage
            key={`request-${epoch}`}
            client={client}
            session={session}
            active={route.page === "request"}
            onSignIn={openSignIn}
            accountEpoch={epoch}
            prefill={companyPrefill}
            onPrefillConsumed={consumePrefill}
          /> : null}
          {publicPage?.outcome === "unavailable" ? <section className="page"><h1>{t('Coverage temporarily unavailable')}</h1><p>{t('The company directory could not be verified. Please try again shortly.')}</p><a className="button outline" href={pageHref(route.page === "company" ? "company" : "companies", locale, route.page === "company" ? route.id : undefined)}>{t('Try again')}</a><a href={pageHref("jobs", locale)}>{t("← Back to search")}</a></section> : null}
          {route.page === "invalid" || publicPage?.outcome === "not-found" ? (
            <section>
              <h1>{t("Page not found.")}</h1>
              <a className="button dark" href={pageHref("jobs", locale)}>{t("Back to search ↗")}</a>
            </section>
          ) : null}
          </div>
        </main>
        <footer className="policy-footer">
          {coverage ? <p id="coverage-disclosure">
            {coverageDescription(coverage, locale)}
          </p> : null}
          <nav aria-label={t("Legal")}>
            <a href={policyDocument(locale, "privacy")}>{t("Privacy")}</a>
            <a href={policyDocument(locale, "usage")}>{t("Usage")}</a>
          </nav>
        </footer>
      </div>
      {interactive && !quarantined ? <AccountControls
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
        onBeforeAuthenticate={beforeAuthenticate}
      /> : null}
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
