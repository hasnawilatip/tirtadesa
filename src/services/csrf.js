'use strict';

/**
 * Perlindungan CSRF (synchronizer token) tanpa dependensi tambahan.
 *
 * - Token disimpan di sesi dan dikirim ke setiap form POST lewat:
 *   · input hidden `_csrf` (ditambahkan otomatis oleh `/js/app.js`), atau
 *   · header `x-csrf-token` untuk permintaan fetch/XHR.
 * - Berkas multipart (unggahan) divalidasi SESUDAH multer membaca body:
 *   pasang `csrf.setelahUnggah` tepat setelah middleware unggah di rute terkait.
 * - Header `Origin` juga diperiksa bila dikirim browser (pertahanan tambahan).
 */

const crypto = require('crypto');
const fs = require('fs');

const KUNCI = 'csrfToken';

function tolak(req, res) {
  const pesan = 'Sesi formulir kedaluwarsa atau tidak valid. Muat ulang halaman lalu coba lagi.';
  if (!req.user) return res.status(403).type('text/plain').send(pesan);
  if (typeof req.flash === 'function') req.flash('error', pesan);
  return res.status(403).render('error', { title: 'Akses ditolak', message: pesan });
}

function token(req) {
  if (!req.session) return '';
  if (!req.session[KUNCI]) {
    req.session[KUNCI] = crypto.randomBytes(32).toString('base64url');
  }
  return req.session[KUNCI];
}

function samaAman(a, b) {
  const kiri = Buffer.from(String(a || ''));
  const kanan = Buffer.from(String(b || ''));
  if (!kiri.length || kiri.length !== kanan.length) return false;
  return crypto.timingSafeEqual(kiri, kanan);
}

function asalSah(req) {
  const asal = req.get('origin');
  if (!asal) return true;
  try {
    return new URL(asal).host === req.get('host');
  } catch (err) {
    return false;
  }
}

function tokenDikirim(req) {
  const dariBody = req.body && req.body._csrf ? req.body._csrf : '';
  const dariHeader = req.get('x-csrf-token') || '';
  return dariBody || dariHeader;
}

function tokenSah(req) {
  return samaAman(req.session && req.session[KUNCI], tokenDikirim(req));
}

function hapusBerkasSementara(req) {
  const daftar = [];
  if (req.file) daftar.push(req.file);
  if (Array.isArray(req.files)) daftar.push(...req.files);
  else if (req.files && typeof req.files === 'object') {
    Object.values(req.files).forEach((nilai) => {
      if (Array.isArray(nilai)) daftar.push(...nilai);
    });
  }
  daftar.forEach((berkas) => {
    if (berkas && berkas.path) fs.promises.unlink(berkas.path).catch(() => {});
  });
}

function middleware(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  if (!asalSah(req)) return tolak(req, res);

  // Body multipart belum dibaca di sini → validasi setelah multer.
  if (req.is('multipart/form-data')) {
    req.csrfDitunda = true;
    return next();
  }

  if (!tokenSah(req)) return tolak(req, res);
  req.csrfTerverifikasi = true;
  return next();
}

/** Dipasang setelah middleware unggah (multer) pada rute multipart. */
function setelahUnggah(req, res, next) {
  if (req.csrfTerverifikasi) return next();
  if (!asalSah(req) || !tokenSah(req)) {
    hapusBerkasSementara(req);
    return tolak(req, res);
  }
  req.csrfTerverifikasi = true;
  return next();
}

module.exports = { token, middleware, setelahUnggah, tokenSah };
