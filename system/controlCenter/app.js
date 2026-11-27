// JARVIS Control Center page. The session cookie is HttpOnly; the CSRF token
// lives only in this page's memory and goes with every POST.
let csrf = '';
const $ = (id) => document.getElementById(id);

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function refresh() {
  const res = await fetch('/api/status', { credentials: 'same-origin' });
  if (res.status === 401) { show(false); return; }
  const s = await res.json();
  $('permissions').textContent = s.permissions ?? '';
  $('goals').textContent = s.goals ?? '';
  $('agents').textContent = s.agents ?? '';
  $('model').textContent = s.model ? JSON.stringify(s.model, null, 2) : '';
}

function show(loggedIn) {
  $('login').hidden = loggedIn;
  $('panel').hidden = !loggedIn;
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  const r = await post('/api/login', { token: $('token').value });
  $('token').value = '';
  if (r.status !== 200) { $('login-error').textContent = r.body.error ?? 'Login failed.'; return; }
  csrf = r.body.csrf;
  show(true);
  refresh();
});

$('refresh').addEventListener('click', refresh);
$('logout').addEventListener('click', async () => { await post('/api/logout'); csrf = ''; show(false); });
$('actions').addEventListener('click', async (e) => {
  const action = e.target?.dataset?.action;
  if (!action) return;
  $('result').textContent = 'Working…';
  const r = await post('/api/action', { action });
  $('result').textContent = r.body.output || r.body.error || `Status ${r.status}`;
  refresh();
});
