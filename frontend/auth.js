(function () {
  const STORAGE_KEY = 'wk_token'
  let currentUser = null

  function setToken(token) {
    if (token) localStorage.setItem(STORAGE_KEY, token)
    else localStorage.removeItem(STORAGE_KEY)
  }

  function getToken() {
    return localStorage.getItem(STORAGE_KEY) || null
  }

  async function authFetch(input, init = {}) {
    const token = getToken()
    const headers = new Headers(init.headers || {})
    if (token) headers.set('Authorization', 'Bearer ' + token)
    const opts = Object.assign({}, init, { headers })

    const res = await fetch(input, opts)

    if (res.status === 401 || res.status === 403) {
      removeLocalAuth()
      try {
        if (!window.location.pathname.endsWith('/login.html')) {
          window.location.href = '/login.html'
        }
      } catch (e) { }
      throw new Error('Unauthorized')
    }

    return res
  }

  async function login(username, password) {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    })
    if (!res.ok) {
      const j = await res.json().catch(()=>({}))
      throw new Error(j.error || 'login failed')
    }
    const data = await res.json()
    if (!data || !data.token) throw new Error('no token returned')
    setToken(data.token)
    currentUser = null
    return data.token
  }

  async function getCurrentUser(force = false) {
    if (!force && currentUser) return currentUser
    const token = getToken()
    if (!token) return null
    try {
      const res = await authFetch('/api/me')
      if (!res.ok) return null
      currentUser = await res.json()
      return currentUser
    } catch (e) {
      return null
    }
  }

  function removeLocalAuth() {
    setToken(null)
    currentUser = null
  }

  function logout(redirect = true) {
    removeLocalAuth()
    if (redirect) {
      try { window.location.href = '/' } catch (e) {}
    }
  }

  // expose to global scope used by pages
  window.authFetch = authFetch
  window.login = login
  window.logout = logout
  window.getCurrentUser = getCurrentUser
  window.getToken = getToken
  window._wk_setToken = setToken
})()

