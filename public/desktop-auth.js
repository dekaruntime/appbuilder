// Desktop-only sign-in bridge for the static Tauri shell. Tokens stay in the
// OS keychain; only safe identity display data crosses the `account_*` IPC.
(function () {
  if (typeof window.__TAURI__ === 'undefined') {
    return;
  }
  window.ZEGA_PLATFORM = { platform: 'desktop', source: 'tauri', isDesktop: true, isMobile: false, isWeb: false, capabilities: ['tauri-ipc'], confidence: 'detected' };

  const STATUS_TEXT = {
    signed_out: 'Sign in',
    pending: 'Signing in…',
    expired: 'Sign in timed out',
    signed_in: 'Signed in',
    unavailable: 'Auth unavailable',
  };

  async function invoke(name, args) {
    return window.__TAURI__.core.invoke(name, args);
  }

  async function refresh() {
    const view = await invoke('account_status');
    updateUI(view);
  }

  function updateUI(view) {
    const signedIn = view.status === 'signed_in';
    const label = STATUS_TEXT[view.status] || 'Sign in';
    // Once signed in, the Sign in button gives way to the account block
    // (avatar + name, then Sign out — AGENTS.md §7b, same as zega.dev).
    for (const el of document.querySelectorAll('.sign-in, [data-auth-state]')) {
      if (el.hasAttribute('data-auth-state')) el.textContent = label;
      el.hidden = signedIn;
    }
    for (const el of document.querySelectorAll('[data-auth-signed-in]')) {
      el.hidden = !signedIn;
    }
    for (const el of document.querySelectorAll('[data-auth-signed-out]')) {
      el.hidden = signedIn;
    }
    const name = view.identity?.name || view.identity?.login || '';
    for (const el of document.querySelectorAll('[data-auth-name], [data-auth-identity]')) {
      el.textContent = name;
    }
    const avatar = view.identity?.avatar;
    for (const el of document.querySelectorAll('[data-auth-avatar]')) {
      if (avatar) el.src = avatar;
      el.hidden = !avatar;
    }
  }

  async function start() {
    try {
      updateUI({ status: 'pending', awaiting_browser: true });
      await invoke('account_start');
    } catch (error) {
      updateUI({ status: 'unavailable', error: String(error) });
    }
  }

  async function signout() {
    await invoke('account_signout');
  }

  window.zegaAuth = {
    start,
    signout,
    status: () => invoke('account_status'),
    refresh,
  };

  document.addEventListener('zega:signin', () => start());

  // Wire any existing sign-in affordance on the page to the desktop flow.
  for (const el of document.querySelectorAll('.sign-in')) {
    el.addEventListener('click', (event) => {
      event.preventDefault();
      start();
    });
  }

  // The header's Sign out button revokes the session and clears the keychain
  // (the Rust `account_signout` command); account-changed updates the UI.
  for (const el of document.querySelectorAll('[data-auth-signout]')) {
    el.addEventListener('click', (event) => {
      event.preventDefault();
      signout().catch(() => {});
    });
  }

  // Listen for backend state changes (successful callback, sign-out, etc.).
  if (typeof window.__TAURI__.event?.listen === 'function') {
    window.__TAURI__.event.listen('account-changed', refresh);
  }

  // Initial snapshot.
  refresh().catch(() => {});
})();
