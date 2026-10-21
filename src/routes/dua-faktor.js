'use strict';

/**
 * Autentikasi dua faktor (TOTP) untuk superadmin.
 *
 * Alur login: kata sandi benar → sesi sementara `pending2fa` → verifikasi kode
 * → sesi penuh dengan `userId` dan `totpVerified`.
 */

const express = require('express');
const { db } = require('../db');
const config = require('../config');
const { requireRole } = require('../auth');
const { audit } = require('../helpers');
const rateLimit = require('../services/rate-limit');
const totp = require('../services/totp');
const { cocokSandi } = require('../services/sandi');

const router = express.Router();
const UMUR_INGAT_MS = 30 * 24 * 60 * 60 * 1000;

function ambilUser(id) {
  return db.prepare("SELECT * FROM users WHERE id = ? AND role = 'superadmin' AND is_active = 1").get(Number(id)) || null;
}

function hashPemulihanTersimpan(user) {
  try {
    const data = JSON.parse(user.totp_recovery || '[]');
    return Array.isArray(data) ? data : [];
  } catch (err) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// LANGKAH LOGIN
// ---------------------------------------------------------------------------

router.get('/2fa/verifikasi', (req, res) => {
  if (req.user) return res.redirect('/');
  if (!req.session.pending2fa) return res.redirect('/login');
  return res.render('2fa-verifikasi', { layout: false, error: null });
});

router.post('/2fa/verifikasi', (req, res) => {
  if (req.user) return res.redirect('/');
  const userId = Number(req.session.pending2fa);
  if (!userId) return res.redirect('/login');

  const batas = rateLimit.tambah(`2fa:${req.ip}:${userId}`, 10, 15 * 60 * 1000);
  if (batas.diblokir) {
    return res.status(429).render('2fa-verifikasi', {
      layout: false,
      error: 'Terlalu banyak percobaan kode. Tunggu 15 menit lalu coba lagi.',
    });
  }

  const user = ambilUser(userId);
  if (!user || Number(user.totp_enabled) !== 1 || !user.totp_secret) {
    return req.session.destroy(() => res.redirect('/login'));
  }

  const kode = String(req.body.kode || '');
  let sah = totp.verifikasi(user.totp_secret, kode);

  if (!sah) {
    const daftar = hashPemulihanTersimpan(user);
    const indeks = totp.cocokKodePemulihan(daftar, kode);
    if (indeks >= 0) {
      daftar.splice(indeks, 1);
      db.prepare('UPDATE users SET totp_recovery = ? WHERE id = ?').run(JSON.stringify(daftar), user.id);
      audit(req, 'update', 'users', user.id, 'Kode pemulihan 2FA dipakai');
      sah = true;
    }
  }

  if (!sah) {
    return res.status(401).render('2fa-verifikasi', {
      layout: false,
      error: `Kode tidak valid. Sisa ${batas.sisa} percobaan.`,
    });
  }

  const ingat = Boolean(req.session.pending2faIngat);
  rateLimit.kosongkan(`2fa:${req.ip}:${userId}`);
  return req.session.regenerate((err) => {
    if (err) {
      console.error('Gagal membuat sesi setelah 2FA:', err.message);
      return res.status(500).render('2fa-verifikasi', {
        layout: false,
        error: 'Gagal memulai sesi. Silakan masuk lagi.',
      });
    }
    req.session.userId = user.id;
    req.session.totpVerified = true;
    req.session.cookie.maxAge = ingat ? UMUR_INGAT_MS : null;
    const lengkap = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    req.user = lengkap;
    audit(req, 'login', 'users', user.id, 'Login sebagai superadmin (2FA)');
    return res.redirect('/');
  });
});

// ---------------------------------------------------------------------------
// PENGATURAN 2FA
// ---------------------------------------------------------------------------

router.get('/2fa', requireRole('superadmin'), (req, res) => res.redirect('/2fa/pengaturan'));

router.get('/2fa/pengaturan', requireRole('superadmin'), (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const recoveryBaru = req.session.recoveryBaru || null;
  delete req.session.recoveryBaru;

  let secret = null;
  let otpauth = null;
  if (!Number(user.totp_enabled)) {
    secret = req.session.totpSetupSecret;
    if (!secret) {
      secret = totp.buatSecret();
      req.session.totpSetupSecret = secret;
    }
    const penerbit = 'TirtaDesa';
    otpauth = totp.urlOtentikator(secret, user.username, penerbit);
  }

  return res.render('2fa-pengaturan', {
    title: 'Autentikasi Dua Faktor',
    aktif: Number(user.totp_enabled) === 1,
    secret,
    otpauth,
    recoveryBaru,
    sisaPemulihan: hashPemulihanTersimpan(user).length,
    wajib: config.WAJIB_2FA,
    error: null,
  });
});

router.post('/2fa/pengaturan', requireRole('superadmin'), (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (Number(user.totp_enabled)) {
    req.flash('error', '2FA sudah aktif.');
    return res.redirect('/2fa/pengaturan');
  }
  const secret = req.session.totpSetupSecret;
  if (!secret) {
    req.flash('error', 'Sesi pengaturan 2FA berakhir. Muat ulang halaman ini.');
    return res.redirect('/2fa/pengaturan');
  }
  if (!totp.verifikasi(secret, req.body.kode)) {
    return res.status(400).render('2fa-pengaturan', {
      title: 'Autentikasi Dua Faktor',
      aktif: false,
      secret,
      otpauth: totp.urlOtentikator(secret, user.username, 'TirtaDesa'),
      recoveryBaru: null,
      sisaPemulihan: 0,
      wajib: config.WAJIB_2FA,
      error: 'Kode salah. Pastikan waktu ponsel tepat, lalu coba kode terbaru.',
    });
  }

  const kodePemulihan = totp.buatKodePemulihan(8);
  db.prepare(`UPDATE users SET totp_secret = ?, totp_enabled = 1, totp_recovery = ? WHERE id = ?`)
    .run(secret, JSON.stringify(kodePemulihan.map(totp.hashKodePemulihan)), user.id);
  delete req.session.totpSetupSecret;
  req.session.recoveryBaru = kodePemulihan;
  req.session.totpVerified = true;
  audit(req, 'update', 'users', user.id, 'Mengaktifkan 2FA');
  req.flash('success', '2FA aktif. Simpan kode pemulihan di tempat aman.');
  return res.redirect('/2fa/pengaturan');
});

router.post('/2fa/nonaktif', requireRole('superadmin'), (req, res) => {
  if (config.WAJIB_2FA) {
    req.flash('error', '2FA wajib aktif di lingkungan ini sehingga tidak dapat dimatikan.');
    return res.redirect('/2fa/pengaturan');
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user || !Number(user.totp_enabled)) {
    req.flash('error', '2FA belum aktif.');
    return res.redirect('/2fa/pengaturan');
  }
  if (!cocokSandi(req.body.sandi, user.password_hash) || !totp.verifikasi(user.totp_secret, req.body.kode)) {
    req.flash('error', 'Kata sandi atau kode 2FA tidak valid.');
    return res.redirect('/2fa/pengaturan');
  }
  db.prepare('UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_recovery = NULL WHERE id = ?')
    .run(user.id);
  audit(req, 'update', 'users', user.id, 'Menonaktifkan 2FA');
  req.flash('success', '2FA dinonaktifkan.');
  return res.redirect('/2fa/pengaturan');
});

module.exports = router;
