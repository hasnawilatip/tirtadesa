'use strict';

/**
 * Klien HTTP kecil untuk skrip uji: menyimpan cookie sesi dan token CSRF.
 * Token diambil dari <meta name="csrf-token"> dan dikirim lewat header
 * `x-csrf-token`, sehingga uji tetap bisa memakai form multipart.
 */

const BASE = process.env.BASE_URL || 'http://localhost:3000';

function simpanCookie(res, cookie) {
  let daftar = [];
  if (typeof res.headers.getSetCookie === 'function') daftar = res.headers.getSetCookie();
  if (!daftar.length) {
    const satu = res.headers.get('set-cookie');
    if (satu) daftar = [satu];
  }
  return daftar.length ? daftar.map((c) => c.split(';')[0]).join('; ') : cookie;
}

function buatKlien() {
  let cookie = '';
  let token = '';
  let jalurToken = '/login';

  async function segarkanToken() {
    const headers = cookie ? { cookie } : {};
    const res = await fetch(`${BASE}${jalurToken}`, { headers, redirect: 'manual' });
    cookie = simpanCookie(res, cookie);
    const html = await res.text();
    const cocok = html.match(/<meta name="csrf-token" content="([^"]*)"/);
    token = cocok ? cocok[1] : '';
  }

  return {
    reset() {
      cookie = '';
      token = '';
      jalurToken = '/login';
    },

    async ambil(path, opsi = {}) {
      const metode = String(opsi.method || 'GET').toUpperCase();
      if (metode !== 'GET' && !token) await segarkanToken();
      const headers = { ...(opsi.headers || {}) };
      if (cookie) headers.cookie = cookie;
      if (token && metode !== 'GET') headers['x-csrf-token'] = token;
      const res = await fetch(`${BASE}${path}`, { ...opsi, headers, redirect: 'manual' });
      cookie = simpanCookie(res, cookie);
      if (metode !== 'GET' && path === '/login' && res.status === 302) {
        token = '';
        jalurToken = '/';
      }
      if (metode !== 'GET' && path === '/logout' && res.status === 302) {
        token = '';
        jalurToken = '/login';
      }
      return res;
    },

    async login(username, password) {
      const res = await this.ambil('/login', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username, password }).toString(),
      });
      return res.status === 302;
    },
  };
}

module.exports = { buatKlien, BASE };
