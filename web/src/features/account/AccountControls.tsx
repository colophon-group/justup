import { policyDocument, reviewedPolicyLinks } from "../../i18n/policies.ts";
import { localeName, parseInterfaceLocale } from "../../i18n/locales.ts";
import type { AccountLocaleControl } from "../../i18n/useAccountLocale.ts";
import { useInterfaceLocale } from "../../i18n/LocaleProvider.tsx";
// Account dialogs use only authoritative session state and explicit server mutations.
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { type ApiClient, ApiError, errorText, isAbortError } from '../../api/client';
import type { Session } from '../../api/types';
import { Dialog, useDialogSuspended } from '../../shared/Dialog';

export type AccountDialog = 'settings' | 'sign-in' | 'delete-account' | null;
export interface AccountControlsProps {
  client: ApiClient;
  interfaceLanguage: AccountLocaleControl;
  session: Session | null;
  dialog: AccountDialog;
  onDialogChange: (dialog: AccountDialog) => void;
  onSessionRefresh: () => Promise<void>;
  onAuthenticationRecovery: (username: string) => Promise<void>;
  onSignedOut: () => Promise<void>;
  reducedMotion: boolean;
  onReducedMotionChange: (reduced: boolean) => void;
  signInReason?: string;
  onBeforeAuthenticate?: (signal: AbortSignal) => Promise<void>;
}
export function AccountControls({ client, interfaceLanguage, session, dialog, onDialogChange, onSessionRefresh, onAuthenticationRecovery, onSignedOut, reducedMotion, onReducedMotionChange, signInReason, onBeforeAuthenticate }: AccountControlsProps) {
  const { t, notice, override, locale } = useInterfaceLocale();
  const suspended = useDialogSuspended();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [invitation, setInvitation] = useState('');
  const [registration, setRegistration] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [authError, setAuthError] = useState('');
  const [accountError, setAccountError] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const operation = useRef(0);
  const mounted = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const deleteKey = useRef(crypto.randomUUID());
  const policyLinks = reviewedPolicyLinks(session?.policies, locale, window.location.origin);
  const reviewed = policyLinks !== null;
  const loginEnabled = reviewed && session?.authentication.method === 'username_password' && session.authentication.loginEnabled;
  const registrationEnabled = loginEnabled && session?.authentication.registrationEnabled === true;
  const requiresInvitation = session?.authentication.requiresInvitation !== false;

  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; operation.current++; controller.current?.abort(); }; }, []);
  useLayoutEffect(() => {
    if (!suspended) return;
    operation.current++; controller.current?.abort(); setBusy(false);
    setPassword(''); setInvitation(''); setDeletePassword('');
  }, [suspended]);
  useLayoutEffect(() => {
    operation.current++; controller.current?.abort(); setBusy(false);
    setPassword(''); setInvitation(''); setDeletePassword('');
    setAuthError(''); setAccountError(''); setDeleteError('');
    if (dialog !== 'sign-in') setRegistration(false);
  }, [dialog]);
  useEffect(() => {
    if (!registrationEnabled) setRegistration(false);
    if (!registrationEnabled || !requiresInvitation) setInvitation('');
  }, [registrationEnabled, requiresInvitation]);
  useLayoutEffect(() => {
    operation.current++; controller.current?.abort(); setBusy(false);
    setUsername(''); setPassword(''); setInvitation(''); setDeletePassword('');
    deleteKey.current = crypto.randomUUID();
  }, [session?.user?.id]);
  function begin() {
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    const id = ++operation.current;
    return { abort, valid: () => mounted.current && id === operation.current && !abort.signal.aborted };
  }

  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !loginEnabled) return;
    const action = begin();
    const credentials = { username, password };
    const inviteCode = invitation;
    setPassword(''); setInvitation(''); setBusy(true); setAuthError('Checking account access…');
    let credentialsSent = false;
    try {
      await onBeforeAuthenticate?.(action.abort.signal);
      if (!action.valid()) return;
      credentialsSent = true;
      if (registration && registrationEnabled) await client.register({ ...credentials, ...(requiresInvitation ? { inviteCode } : {}) }, action.abort.signal);
      else await client.login(credentials, action.abort.signal);
      if (!action.valid()) return;
      onDialogChange(null);
      await onSessionRefresh();
    } catch (error) {
      if (credentialsSent && action.valid() && error instanceof ApiError && (error.status === 0 || error.status >= 500 || error.code === 'invalid_response')) {
        // A lost reply can follow a committed login and visitor handoff. Read the
        // authoritative session rather than submitting credentials a second time.
        await onAuthenticationRecovery(credentials.username);
      }
      if (action.valid() && !isAbortError(error)) setAuthError(errorText(error));
    } finally { if (action.valid()) setBusy(false); }
  }
  async function logout() {
    if (busy) return;
    const action = begin();
    setBusy(true); setAccountError('Signing out…');
    try {
      await client.logout(action.abort.signal);
      if (!action.valid()) return;
      onDialogChange(null);
      await onSignedOut();
    } catch (error) { if (action.valid() && !isAbortError(error)) setAccountError(errorText(error)); }
    finally { if (action.valid()) setBusy(false); }
  }
  async function removeAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !session?.user) return;
    const action = begin();
    const confirmation = deletePassword;
    setDeletePassword(''); setBusy(true); setDeleteError('Deleting your account…');
    try {
      await client.deleteAccount(confirmation, deleteKey.current, action.abort.signal);
      if (!action.valid()) return;
      onDialogChange(null);
      await onSignedOut();
    } catch (error) { if (action.valid() && !isAbortError(error)) setDeleteError(errorText(error)); }
    finally { if (action.valid()) setBusy(false); }
  }

  return <>
    <Dialog id="settings-dialog" open={dialog === 'settings'} onClose={() => onDialogChange(null)} labelledBy="settings-title">
      <div className="dialog-heading"><span className="eyebrow">{t("Your edition")}</span><button className="icon-close" aria-label={t("Close settings")} onClick={() => onDialogChange(null)}>×</button></div>
      <div id="settings-content">
        <h2 id="settings-title">{t("Your edition.")}</h2>
        <p>{session?.user ? t("Signed in as {username}.", { username: session.user.username }) : t("You are browsing as a visitor.")}</p>
        <p id="account-access">{(session?.access.description ? notice(session.access.description) : "") || (session?.access.fullAccess ? t("Access to the newest matches is enabled.") : session?.user ? t("Access to the newest matches is limited for this account.") : t("Sign in to access the newest matches and save searches."))}</p>
        <label className="settings-language" htmlFor="interface-language">{t("Interface language")}
          <select id="interface-language" value={override ?? ''} disabled={interfaceLanguage.disabled} aria-disabled={interfaceLanguage.busy} aria-busy={interfaceLanguage.busy}
            onChange={event => { if (!interfaceLanguage.busy) void interfaceLanguage.choose(parseInterfaceLocale(event.target.value)); }}>
            <option value="">{t("Browser default")}</option>
            {interfaceLanguage.supported.map(value => <option key={value} value={value}>{localeName[value]}</option>)}
          </select>
        </label>
        {interfaceLanguage.error ? <p role="status">{notice(interfaceLanguage.error)} <button className="text-link" onClick={interfaceLanguage.retry}>{t("Retry")}</button></p> : null}
        <label className="check-label settings-motion"><input id="settings-reduced" type="checkbox" checked={reducedMotion} onChange={event => onReducedMotionChange(event.target.checked)} />{" "}{t("Reduce motion")}</label>
        {session && !session.access.billingEnabled ? <p className="small-print">{t("Payments are not enabled.")}</p> : null}
        {session?.user ? <div className="account-actions"><button id="logout" className="button outline" disabled={busy} onClick={() => void logout()}>{t("Sign out")}</button><button id="delete-account" className="text-link" disabled={busy} onClick={() => onDialogChange('delete-account')}>{t("Delete account")}</button></div> : <button className="button dark" data-sign-in onClick={() => onDialogChange('sign-in')}>{t("Sign in")}</button>}
        <p id="account-status" role="status">{notice(accountError)}</p>
      </div>
    </Dialog>
    <Dialog id="sign-in-dialog" open={dialog === 'sign-in'} onClose={() => onDialogChange(null)} labelledBy="sign-in-title">
      <div className="dialog-heading"><span className="eyebrow">{t("Your Justup edition")}</span><button className="icon-close" aria-label={t("Close sign in")} onClick={() => onDialogChange(null)}>×</button></div>
      <h2 id="sign-in-title">{t("Your edition awaits.")}</h2>
      <p id="sign-in-reason">{notice(signInReason || 'Sign in to save your edition.')}</p>
      <form id="sign-in-form" hidden={!loginEnabled} onSubmit={event => void authenticate(event)}>
        <label htmlFor="auth-username">{t("Username")}</label><input id="auth-username" name="username" autoComplete="username" required disabled={busy} maxLength={32} value={username} onChange={event => setUsername(event.target.value)} />
        <label htmlFor="auth-password">{t("Password")}</label><input id="auth-password" name="password" type="password" autoComplete={registration ? 'new-password' : 'current-password'} required disabled={busy} value={password} onChange={event => setPassword(event.target.value)} />
        <label className="check-label" id="auth-register-choice" hidden={!registrationEnabled}><input id="auth-register" type="checkbox" disabled={!registrationEnabled || busy} checked={registration} onChange={event => setRegistration(event.target.checked)} />{" "}{t("Create an account")}</label>
        <div id="auth-invite-field" hidden={!registration || !requiresInvitation}><label htmlFor="auth-invite">{t("Invitation code")}</label><input id="auth-invite" type="password" autoComplete="off" required={registration && requiresInvitation} disabled={busy || !requiresInvitation} value={invitation} onChange={event => setInvitation(event.target.value)} /></div>
        <p id="registration-age-notice" className="small-print" hidden={!registration || !registrationEnabled}>{t("By creating an account, you confirm you are at least 18 and legally able to agree to the Usage terms.")}</p>
        <button id="auth-submit" className="button dark" disabled={busy}>{t("Continue ↗")}</button>
        <p id="auth-status" role="status">{notice(authError)}</p>
      </form>
      <p id="sign-in-unavailable" role="status" hidden={loginEnabled}>{!session || reviewed ? t("Account access is unavailable right now. Please try again later.") : t("Account access is unavailable until the published notices and data protections are verified for this service.")}</p>
      {policyLinks?.fallbackLocale ? <p className="small-print" id="policy-language-fallback">{t("For account access, the reviewed notices are in {language}.", {language: localeName[policyLinks.fallbackLocale]})}</p> : null}
      <p className="small-print">{t("Before signing in, read our")}{" "}<a href={policyLinks?.privacy ?? policyDocument(locale, "privacy")}>{t("Privacy notice")}</a>{" "}{t("and")}{" "}<a href={policyLinks?.usage ?? policyDocument(locale, "usage")}>{t("Usage terms")}</a>.</p>
    </Dialog>
    <Dialog id="delete-account-dialog" open={dialog === 'delete-account'} onClose={() => onDialogChange(null)} labelledBy="delete-account-title">
      <div className="dialog-heading"><span className="eyebrow">{t("Your account")}</span><button className="icon-close" aria-label={t("Keep account")} onClick={() => onDialogChange(null)}>×</button></div>
      <h2 id="delete-account-title">{t("Delete your account?")}</h2>
      <p>{t("This requests deletion of your account and saved data. Read the")}{" "}<a href={policyLinks?.privacy ?? policyDocument(locale, "privacy")}>{t("Privacy notice")}</a>{" "}{t("for retention details.")}</p>
      <form id="delete-account-form" onSubmit={event => void removeAccount(event)}>
        <label htmlFor="delete-password">{t("Confirm your password")}</label><input id="delete-password" type="password" autoComplete="current-password" required disabled={busy} value={deletePassword} onChange={event => setDeletePassword(event.target.value)} />
        <div className="dialog-actions"><button type="button" className="button outline" disabled={busy} onClick={() => onDialogChange(null)}>{t("Keep account")}</button><button className="button dark" id="confirm-delete-account" type="submit" disabled={busy}>{t("Delete account")}</button></div>
      </form>
      <p id="delete-account-status" role="status">{notice(deleteError)}</p>
    </Dialog>
  </>;
}
