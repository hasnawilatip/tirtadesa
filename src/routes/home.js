'use strict';

const express = require('express');
const { daftarPaket } = require('../services/langganan');

const router = express.Router();

/**
 * Halaman publik (beranda).
 * Pengguna yang sudah masuk dibiarkan lanjut ke router dashboard
 * sehingga "/" tetap menjadi dashboard untuk mereka.
 */
router.get('/', (req, res, next) => {
  if (req.user) return next();
  return res.render('home', { layout: false, paketList: daftarPaket({ hanyaAktif: true }) });
});

module.exports = router;
