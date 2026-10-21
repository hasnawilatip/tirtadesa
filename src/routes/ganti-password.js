'use strict';

/**
 * Ganti kata sandi sendiri. Dipakai juga sebagai langkah wajib bagi akun
 * yang dibuatkan kata sandi sementara oleh admin.
 */

const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../auth');
const { audit } = require('../helpers');
const { cocokSandi, hashSandi, validasiSandi } = require('../services/sandi');
const { hapusSesiPengguna } = require('../services/sesi');

const router = express.Router();

function tampilkan(req, res, error = null, status = 200) {
  return res.status(status).render('ganti-password', {
    title: 'Ganti Kata Sandi',
    wajib: Boolean(req.user.must_change_password),
    error,
  });
}

router.get('/ganti-password', requireAuth, (req, res) => tampilkan(req, res));

router.post('/ganti-password', requireAuth, (req, res) => {
  const sandiLama = String(req.body.sandi_lama || '');
  const sandiBaru = String(req.body.sandi_baru || '');
  const ulangi = String(req.body.sandi_ulangi || '');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.redirect('/logout');

  if (!cocokSandi(sandiLama, user.password_hash)) {
    return tampilkan(req, res, 'Kata sandi saat ini salah.', 400);
  }
  if (sandiBaru !== ulangi) {
    return tampilkan(req, res, 'Ulangi kata sandi baru dengan tepat.', 400);
  }
  if (cocokSandi(sandiBaru, user.password_hash)) {
    return tampilkan(req, res, 'Kata sandi baru harus berbeda dari yang lama.', 400);
  }
  const salah = validasiSandi(sandiBaru, { username: user.username, nama: user.nama });
  if (salah) return tampilkan(req, res, salah, 400);

  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?')
    .run(hashSandi(sandiBaru), user.id);
  const dihapus = hapusSesiPengguna(user.id, req.sessionID);
  audit(req, 'update', 'users', user.id, `Ganti kata sandi sendiri (sesi lain diakhiri: ${dihapus})`);
  req.flash('success', 'Kata sandi berhasil diganti. Sesi di perangkat lain sudah diakhiri.');
  return res.redirect('/');
});

module.exports = router;
