'use strict';
// Invite-only real credentials stay in the form until submission, never in storage.
function openSignIn(reason = 'Sign in to save your edition.') {
  $('#sign-in-reason').textContent = reason;
  const policies = session?.policies;
  const localPolicy = value => { try { const url = new URL(value, location.origin); return !!value && url.origin === location.origin && ['http:', 'https:'].includes(url.protocol); } catch { return false; } };
  const reviewed = policies?.reviewed === true && !!policies.version && localPolicy(policies.privacyUrl) && localPolicy(policies.usageUrl);
  $('#sign-in-form').hidden = !reviewed;
  $('#sign-in-unavailable').hidden = reviewed;
  $('#sign-in-unavailable').textContent = 'Account access is unavailable while the privacy and usage notices are being reviewed.';
  $('#sign-in-dialog').showModal();
}
function renderSettings() {
  const user = session?.user;
  $('#settings-content').innerHTML = `<h2 id="settings-title">Your edition.</h2><p>${user ? `Signed in as ${escapeHTML(user.username)}.` : 'You are browsing as a visitor.'}</p><p>${session?.access?.fullAccess ? 'Preview account access.' : 'The newest matches are reserved for signed-in preview accounts.'}</p><p class="small-print">This demo is in English. Posting-language preferences are unavailable in this demo.</p><label class="check-label settings-motion"><input id="settings-reduced" type="checkbox" ${forcedReduced ? 'checked' : ''}> Reduce motion</label><p class="small-print">Payment collection is not enabled.</p>${user ? '<div class="account-actions"><button class="button outline" id="logout">Sign out</button><button class="text-link" id="delete-account">Delete account</button></div>' : '<button class="button dark" data-sign-in>Sign in</button>'}<p id="account-status" role="status"></p>`;
}
async function logout() {
  await JustupApi.request('/session/logout', { method: 'POST', idempotencyKey: JustupApi.key() });
  sessionGeneration++; clearProtectedState(); $('#settings-dialog').close(); await bootstrap(); announce('Signed out.');
}
async function authenticate(event) {
  event.preventDefault();
  const form = event.target, registration = $('#auth-register').checked;
  const body = { username: $('#auth-username').value, password: $('#auth-password').value };
  if (registration) body.inviteCode = $('#auth-invite').value;
  $('#auth-password').value = ''; $('#auth-invite').value = '';
  $('#auth-submit').disabled = true; $('#auth-status').textContent = 'Checking account access…';
  try {
    await JustupApi.request(registration ? '/auth/register' : '/auth/login', { method: 'POST', body });
    form.reset(); $('#sign-in-dialog').close(); await bootstrap(); announce('Signed in.');
  } catch (error) { $('#auth-status').textContent = errorText(error); }
  finally { $('#auth-submit').disabled = false; }
}
function initSurfaces() {
  $('#sign-in-form').addEventListener('submit', authenticate);
  $('#auth-register').addEventListener('change', () => { $('#auth-invite-field').hidden = !$('#auth-register').checked; $('#auth-invite').required = $('#auth-register').checked; $('#auth-password').autocomplete = $('#auth-register').checked ? 'new-password' : 'current-password'; });
  $('#sign-in-dialog').addEventListener('close', () => { $('#auth-password').value = ''; $('#auth-invite').value = ''; });
  $('#delete-account-dialog').addEventListener('close', () => { $('#delete-password').value = ''; });
  document.addEventListener('click', event => {
    if (event.target.closest('[data-sign-in]')) openSignIn();
    if (event.target.closest('[data-close]')) event.target.closest('dialog').close();
    if (event.target.closest('#account-open')) { renderSettings(); $('#settings-dialog').showModal(); }
    if (event.target.closest('#logout')) runAction(logout, $('#account-status'));
    if (event.target.closest('#delete-account')) { $('#delete-account-status').textContent = ''; $('#delete-account-dialog').showModal(); }
  });
  $('#delete-account-form').addEventListener('submit', event => {
    event.preventDefault(); const password = $('#delete-password').value; $('#delete-password').value = '';
    runAction(async () => {
      await JustupApi.request('/account', { method: 'DELETE', body: { password }, idempotencyKey: accountDeletionKey });
      sessionGeneration++; clearProtectedState(); $$('dialog[open]').forEach(dialog => dialog.close()); await bootstrap(); announce('Your account has been deleted.');
    }, $('#delete-account-status'));
  });
  document.addEventListener('change', event => {
    if (event.target.id === 'settings-reduced') { forcedReduced = event.target.checked; document.body.classList.toggle('reduce-motion', forcedReduced); syncSearchExample(); }
  });
}
