'use strict';

/**
 * Penyajian berkas unggahan dengan pemeriksaan akses.
 * Berkas tidak lagi berada di `public/`, sehingga tidak bisa dibuka
 * tanpa login atau tanpa hak atas data terkait.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');

const { db } = require('../db');
const { STORAGE_DIR } = require('../config');

const router = express.Router();
const AKAR = path.join(STORAGE_DIR, 'uploads');
const FOLDER = ['logo', 'meter', 'bayar'];
const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

function bolehLihat(req, folder, nama, rel) {
  const user = req.user;

  if (folder === 'logo') return true;
  if (!user) return false;

  if (folder === 'bayar') {
    // Gambar QRIS dipakai di halaman pembayaran yang sudah butuh login.
    if (nama.startsWith('qr-')) return true;

    // Bukti pembayaran langganan pengelola (diverifikasi superadmin).
    if (nama.startsWith('lgn-')) {
      if (user.role === 'superadmin') return true;
      return Boolean(db.prepare('SELECT 1 FROM tagihan_langganan WHERE bukti_path = ? AND desa_id = ?')
        .get(rel, user.desa_id));
    }

    const row = db.prepare('SELECT pelanggan_id, desa_id, dusun_id FROM pembayaran_online WHERE bukti_path = ?')
      .get(rel);
    if (!row) return false;
    if (user.role === 'warga') return Number(user.pelanggan_id) === Number(row.pelanggan_id);
    if (Number(row.desa_id) !== Number(user.desa_id)) return false;
    if (user.role === 'admin_dusun') return Number(user.dusun_id) === Number(row.dusun_id);
    return ['admin_desa', 'kasir'].includes(user.role);
  }

  if (folder === 'meter') {
    const row = db.prepare(`SELECT p.id AS pelanggan_id, p.desa_id, p.dusun_id
      FROM pembacaan_meter b JOIN pelanggan p ON p.id = b.pelanggan_id
      WHERE b.foto_path = ?`).get(rel);
    if (!row) return false;
    if (user.role === 'warga') return Number(user.pelanggan_id) === Number(row.pelanggan_id);
    if (Number(row.desa_id) !== Number(user.desa_id)) return false;
    if (user.role === 'admin_dusun') return Number(user.dusun_id) === Number(row.dusun_id);
    return ['admin_desa', 'kasir', 'petugas_catat'].includes(user.role);
  }

  return false;
}

function kirim(res, lokasi, mime, nama, publik) {
  const aman = nama.replace(/[^A-Za-z0-9._-]/g, '_');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; sandbox");
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Content-Type', mime);
  res.set('Content-Disposition', `${mime === 'application/pdf' ? 'attachment' : 'inline'}; filename="${aman}"`);
  res.set('Cache-Control', publik ? 'public, max-age=86400' : 'private, max-age=300');
  fs.createReadStream(lokasi).on('error', () => res.status(404).end()).pipe(res);
}

router.get('/uploads/:folder/:nama', (req, res) => {
  const { folder } = req.params;
  const nama = String(req.params.nama || '');
  if (!FOLDER.includes(folder) || !/^[A-Za-z0-9._-]+$/.test(nama) || nama !== path.basename(nama)) {
    return res.status(404).end();
  }

  const ekstensi = path.extname(nama).toLowerCase();
  const mime = MIME[ekstensi];
  if (!mime) return res.status(404).end();

  const rel = `/uploads/${folder}/${nama}`;
  if (!bolehLihat(req, folder, nama, rel)) {
    if (!req.user) return res.redirect('/login');
    return res.status(403).end();
  }

  const lokasi = path.join(AKAR, folder, nama);
  if (!lokasi.startsWith(AKAR) || !fs.existsSync(lokasi)) return res.status(404).end();
  return kirim(res, lokasi, mime, nama, folder === 'logo');
});

module.exports = router;
