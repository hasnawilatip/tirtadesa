'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { audit, auditLoginGagal } = require('../helpers');
const rateLimit = require('../services/rate-limit');

const router = express.Router();

const UMUR_INGAT_MS = 30 * 24 * 60 * 60 * 1000; // 30 hari
const UMUR_2FA_MS = 10 * 60 * 1000; // waktu menyelesaikan langkah 2FA

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  if (req.session.pending2fa) return res.redirect('/2fa/verifikasi');
  return res.render('login', {
    layout: false,
    error: req.query.perlu2fa ? 'Sesi 2FA berakhir. Silakan masuk lagi.' : null,
    username: '',
  });
});

router.post('/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const ingat = req.body.ingat === '1' || req.body.ingat === 'on';
  const ip = req.ip;

  const batas = rateLimit.cekLogin(ip, username);
  if (batas.diblokir) {
    auditLoginGagal(req, username, 'diblokir sementara');
    const menit = Math.max(1, Math.ceil(batas.sisaDetik / 60));
    return res.status(429).render('login', {
      layout: false,
      error: `Terlalu banyak percobaan masuk. Coba lagi dalam ${menit} menit.`,
      username,
    });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    const status = rateLimit.gagalLogin(ip, username);
    auditLoginGagal(req, username, status.diblokir ? 'diblokir setelah batas percobaan' : 'kata sandi salah');
    let pesan = 'Username atau password salah.';
    if (status.diblokir) {
      pesan = 'Terlalu banyak percobaan masuk. Akun dikunci sementara selama 15 menit.';
    } else if (status.sisaPercobaan <= 2) {
      pesan += ` Sisa ${status.sisaPercobaan} percobaan sebelum dikunci sementara.`;
    }
    return res.status(401).render('login', { layout: false, error: pesan, username });
  }

  rateLimit.berhasilLogin(ip, username);

  // Superadmin dengan 2FA aktif: sesi belum sah sampai kode diverifikasi.
  if (user.role === 'superadmin' && Number(user.totp_enabled) === 1) {
    return req.session.regenerate((err) => {
      if (err) {
        console.error('Gagal membuat sesi 2FA:', err.message);
        return res.status(500).render('login', {
          layout: false,
          error: 'Gagal memulai sesi. Silakan coba lagi.',
          username,
        });
      }
      req.session.pending2fa = user.id;
      req.session.pending2faIngat = ingat;
      req.session.cookie.maxAge = UMUR_2FA_MS;
      return res.redirect('/2fa/verifikasi');
    });
  }

  // Buat sesi baru untuk mencegah session fixation.
  return req.session.regenerate((err) => {
    if (err) {
      console.error('Gagal membuat sesi:', err.message);
      return res.status(500).render('login', {
        layout: false,
        error: 'Gagal memulai sesi. Silakan coba lagi.',
        username,
      });
    }
    req.session.userId = user.id;
    req.session.cookie.maxAge = ingat ? UMUR_INGAT_MS : null;
    if (user.role === 'superadmin') req.session.totpVerified = true;
    req.user = user;
    audit(req, 'login', 'users', user.id, `Login sebagai ${user.role}`);
    return res.redirect('/');
  });
});

router.post('/logout', (req, res) => {
  if (req.user) audit(req, 'logout', 'users', req.user.id, null);
  res.clearCookie('tirtadesa.sid');
  req.session.destroy(() => res.redirect('/'));
});

module.exports = router;
