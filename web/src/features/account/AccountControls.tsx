// Account dialogs use only authoritative session state and explicit server mutations.
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { type ApiClient, errorText, isAbortError } from '../../api/client';
import type { Session } from '../../api/types';
import { Dialog } from '../../shared/Dialog';

export type AccountDialog = 'settings' | 'sign-in' | 'delete-account' | null;
export interface AccountControlsProps {
  client: ApiClient;
  session: Session | null;
  dialog: AccountDialog;
  onDialogChange: (dialog: AccountDialog) => void;
  onSessionRefresh: () => Promise<void>;
  onSignedOut: () => Promise<void>;
  reducedMotion: boolean;
  onReducedMotionChange: (reduced: boolean) => void;
  signInReason?: string;
}
function localPolicy(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value, window.location.origin);
    return url.origin === window.location.origin && !url.username && !url.password && ['http:', 'https:'].includes(url.protocol);
  } catch { return false; }
}

export function AccountControls({ client, session, dialog, onDialogChange, onSessionRefresh, onSignedOut, reducedMotion, onReducedMotionChange, signInReason }: AccountControlsProps) {
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
  const reviewed = session?.policies.reviewed === true && Boolean(session.policies.version)
    && localPolicy(session.policies.privacyUrl) && localPolicy(session.policies.usageUrl);
  const loginEnabled = reviewed && session?.authentication.method === 'username_password' && session.authentication.loginEnabled;
  const registrationEnabled = loginEnabled && session?.authentication.registrationEnabled === true;
  const requiresInvitation = session?.authentication.requiresInvitation !== false;

  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; operation.current++; controller.current?.abort(); }; }, []);
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
    try {
      if (registration && registrationEnabled) await client.register({ ...credentials, ...(requiresInvitation ? { inviteCode } : {}) }, action.abort.signal);
      else await client.login(credentials, action.abort.signal);
      if (!action.valid()) return;
      onDialogChange(null);
      await onSessionRefresh();
    } catch (error) {
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
      <div className="dialog-heading"><span className="eyebrow">Your edition</span><button className="icon-close" aria-label="Close settings" onClick={() => onDialogChange(null)}>×</button></div>
      <div id="settings-content">
        <h2 id="settings-title">Your edition.</h2>
        <p>{session?.user ? `Signed in as ${session.user.username}.` : 'You are browsing as a visitor.'}</p>
        <p id="account-access">{session?.access.description || (session?.access.fullAccess ? 'Access to the newest matches is enabled.' : session?.user ? 'Access to the newest matches is limited for this account.' : 'Sign in to access the newest matches and save searches.')}</p>
        <p className="small-print">Interface language: English.</p>
        <label className="check-label settings-motion"><input id="settings-reduced" type="checkbox" checked={reducedMotion} onChange={event => onReducedMotionChange(event.target.checked)} /> Reduce motion</label>
        {session && !session.access.billingEnabled ? <p className="small-print">Payments are not enabled.</p> : null}
        {session?.user ? <div className="account-actions"><button id="logout" className="button outline" disabled={busy} onClick={() => void logout()}>Sign out</button><button id="delete-account" className="text-link" disabled={busy} onClick={() => onDialogChange('delete-account')}>Delete account</button></div> : <button className="button dark" data-sign-in onClick={() => onDialogChange('sign-in')}>Sign in</button>}
        <p id="account-status" role="status">{accountError}</p>
      </div>
    </Dialog>
    <Dialog id="sign-in-dialog" open={dialog === 'sign-in'} onClose={() => onDialogChange(null)} labelledBy="sign-in-title">
      <div className="dialog-heading"><span className="eyebrow">Your Justup edition</span><button className="icon-close" aria-label="Close sign in" onClick={() => onDialogChange(null)}>×</button></div>
      <h2 id="sign-in-title">Your edition awaits.</h2>
      <p id="sign-in-reason">{signInReason || 'Sign in to save your edition.'}</p>
      <form id="sign-in-form" hidden={!loginEnabled} onSubmit={event => void authenticate(event)}>
        <label htmlFor="auth-username">Username</label><input id="auth-username" name="username" autoComplete="username" required disabled={busy} maxLength={32} value={username} onChange={event => setUsername(event.target.value)} />
        <label htmlFor="auth-password">Password</label><input id="auth-password" name="password" type="password" autoComplete={registration ? 'new-password' : 'current-password'} required disabled={busy} value={password} onChange={event => setPassword(event.target.value)} />
        <label className="check-label" id="auth-register-choice" hidden={!registrationEnabled}><input id="auth-register" type="checkbox" disabled={!registrationEnabled || busy} checked={registration} onChange={event => setRegistration(event.target.checked)} /> Create an account</label>
        <div id="auth-invite-field" hidden={!registration || !requiresInvitation}><label htmlFor="auth-invite">Invitation code</label><input id="auth-invite" type="password" autoComplete="off" required={registration && requiresInvitation} disabled={busy || !requiresInvitation} value={invitation} onChange={event => setInvitation(event.target.value)} /></div>
        <button id="auth-submit" className="button dark" disabled={busy}>Continue ↗</button>
        <p id="auth-status" role="status">{authError}</p>
      </form>
      <p id="sign-in-unavailable" role="status" hidden={loginEnabled}>{reviewed ? 'Account access is unavailable right now. Please try again later.' : 'Account access is unavailable while the privacy and usage notices are being reviewed.'}</p>
      <p className="small-print">Before signing in, read our <a href="/privacy.html">Privacy notice</a> and <a href="/usage.html">Usage terms</a>.</p>
    </Dialog>
    <Dialog id="delete-account-dialog" open={dialog === 'delete-account'} onClose={() => onDialogChange(null)} labelledBy="delete-account-title">
      <div className="dialog-heading"><span className="eyebrow">Your account</span><button className="icon-close" aria-label="Keep account" onClick={() => onDialogChange(null)}>×</button></div>
      <h2 id="delete-account-title">Delete your account?</h2>
      <p>This requests deletion of your account and saved data. Read the <a href="/privacy.html">Privacy notice</a> for retention details.</p>
      <form id="delete-account-form" onSubmit={event => void removeAccount(event)}>
        <label htmlFor="delete-password">Confirm your password</label><input id="delete-password" type="password" autoComplete="current-password" required disabled={busy} value={deletePassword} onChange={event => setDeletePassword(event.target.value)} />
        <div className="dialog-actions"><button type="button" className="button outline" disabled={busy} onClick={() => onDialogChange(null)}>Keep account</button><button className="button dark" id="confirm-delete-account" type="submit" disabled={busy}>Delete account</button></div>
      </form>
      <p id="delete-account-status" role="status">{deleteError}</p>
    </Dialog>
  </>;
}
