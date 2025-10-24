const TOKEN_KEY = 'warehouse_token';

function getToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
}
function setToken(token) {
  try { localStorage.setItem(TOKEN_KEY, token); } catch (e) {}
}
function logout() {
  try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
  window.location.href = '/login.html';
}

function resolveUrl(url) {
  try {
    if (!url && url !== '') return url;
    if (typeof Request !== 'undefined' && url instanceof Request) return url.url;
    const s = typeof url === 'string' ? url : String(url);
    if (s.startsWith('http://') || s.startsWith('https://')) return s;
    if (s.startsWith('/')) return window.location.origin + s;
    return window.location.origin + '/' + s;
  } catch (e) {
    console.error('resolveUrl error', e, url);
    return url;
  }
}

async function login(username, password) {
  const resp = await fetch(resolveUrl('/api/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  if (resp.ok) {
    const j = await resp.json().catch(() => ({}));
    if (j.token) setToken(j.token);
    return resp.ok;
  }
  return false;
}

async function authFetch(url, options = {}) {
  try {
    const token = getToken();
    if (!token) {
      return Promise.reject(new Error('no token'));
    }

    const fullUrl = resolveUrl(url);

    let headersObj = {};
    try {
      if (typeof Headers !== 'undefined' && options.headers instanceof Headers) {
        options.headers.forEach((v, k) => headersObj[k] = v);
      } else if (options.headers && typeof options.headers === 'object') {
        headersObj = { ...options.headers };
      }
    } catch (hdrErr) {
      headersObj = {};
    }

    headersObj['Authorization'] = `Bearer ${token}`;

    const init = { ...options, headers: headersObj };
    const response = await fetch(fullUrl, init);

    if (response.status === 401 || response.status === 403) {
      logout();
      return Promise.reject(new Error('unauthorized'));
    }

    return response;
  } catch (err) {
    console.error('Network / authFetch error:', err);
    return Promise.reject(err);
  }
}

window.authFetch = authFetch;
window.logout = logout;
window.login = login;
window.getToken = getToken;

