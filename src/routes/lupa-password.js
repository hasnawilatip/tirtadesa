'use strict';

const express = require('express');
const { db } = require('../db');
const { audit } = require('../helpers');
const rateLimit = require('../services/rate-limit');

const router = express.Router();

function bersihkanWa(nilai) {
  let digit = String(nilai || '').replace(/[^\d]/g, '');
  if (digit.startsWith('0')) digit = `62${digit.slice(1)}`;
  return digit;
}

router.get('/lupa-password', (req, res) => {
  if (req.user) return res.redirect('/');
  return res.render('lupa-password', {
    layout: false,
    sukses: req.query.sukses === '1',
    error: null,
    form: {},
  });
});

router.post('/lupa-password', rateLimit.middleware({
  kunci: (req) => `lupa-sandi:${req.ip}`,
  batas: 10,
  jendelaMs: 60 * 60 * 1000,
  pesan: 'Terlalu banyak permintaan dari jaringan ini. Coba lagi dalam satu jam.',
}), (req, res) => {
  if (req.user) return res.redirect('/');

  const form = {
    username: String(req.body.username || '').trim().toLowerCase(),
    nama: String(req.body.nama || '').trim(),
    whatsapp: bersihkanWa(req.body.whatsapp),
    pesan: String(req.body.pesan || '').trim(),
  };

  let error = null;
  if (form.username.length < 3) error = 'Username minimal 3 karakter.';
  else if (form.whatsapp.length < 9 || form.whatsapp.length > 15) {
    error = 'Nomor WhatsApp tidak valid. Contoh: 081234567890.';
  }

  if (error) {
    return res.status(400).render('lupa-password', { layout: false, sukses: false, error, form });
  }

  const info = db.prepare(`INSERT INTO permintaan_reset (username, nama, whatsapp, pesan)
    VALUES (?,?,?,?)`).run(form.username, form.nama || null, form.whatsapp, form.pesan || null);
  audit(req, 'create', 'permintaan_reset', info.lastInsertRowid, `Reset password: ${form.username}`);

  return res.redirect('/lupa-password?sukses=1');
});

module.exports = router;
