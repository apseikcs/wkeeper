const TOKEN_KEY = 'warehouse_token';

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

function logout() {
  localStorage.removeItem(TOKEN_KEY);
  window.location.href = 'login.html';
}

async function login(username, password) {
  const response = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });

  if (response.ok) {
    const { token } = await response.json();
    setToken(token);
    return true;
  }
  return false;
}

async function authFetch(url, options = {}) {
  const token = getToken();
  if (!token) {
    logout(); // No token, force logout
    return Promise.reject(new Error('no token'));
  }

  const headers = {
    ...options.headers,
    'Authorization': `Bearer ${token}`,
  };

  const response = await fetch(url, { ...options, headers });

  if (response.status === 401 || response.status === 403) {
    logout(); // Token is invalid or expired, force logout
    return Promise.reject(new Error('unauthorized'));
  }

  return response;
}

function checkAuth() {
  if (!getToken()) {
    // allow access to login page itself
    if (!window.location.pathname.endsWith('login.html')) {
      window.location.href = 'login.html';
    }
  }
}

// Check auth on script load for all pages that include this
checkAuth();
