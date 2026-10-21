'use strict';

const express = require('express');

const { db } = require('../db');
const { requireRole } = require('../auth');
const { audit } = require('../helpers');
const { buatUnggahan, hapusBerkas } = require('../services/unggah');
const csrf = require('../services/csrf');

const router = express.Router();

// Profil desa adalah data operasional pengelola, bukan wewenang superadmin.
router.use(requireRole('admin_desa'));

const unggahLogo = buatUnggahan({
  folder: 'logo',
  prefix: 'usaha',
  tipe: ['image/png', 'image/jpeg', 'image/webp'],
  pesan: 'Logo harus berupa gambar PNG, JPG, atau WebP (maks. 2 MB).',
});

function unggahLogoAman(req, res, next) {
  unggahLogo.single('logo')(req, res, (err) => {
    if (err) {
      req.flash('error', err.message || 'Gagal mengunggah logo.');
      return res.redirect('/profil-desa');
    }
    return unggahLogo.validasi(req, res, (err2) => {
      if (err2) {
        req.flash('error', err2.message || 'Isi berkas logo tidak valid.');
        return res.redirect('/profil-desa');
      }
      return next();
    });
  });
}

function hapusBerkasLogo(logoPath) {
  hapusBerkas(logoPath);
}

function dataDesa(user) {
  return db.prepare('SELECT * FROM desa WHERE id = ?').get(user.desa_id);
}

router.get('/profil-desa', (req, res) => {
  res.render('profil-desa', { title: 'Profil Desa', desa: dataDesa(req.user) });
});

router.post('/profil-desa', unggahLogoAman, csrf.setelahUnggah, (req, res) => {
  const desa = dataDesa(req.user);
  if (!desa) {
    if (req.file) hapusBerkasLogo(`/uploads/logo/${req.file.filename}`);
    req.flash('error', 'Data desa belum tersedia.');
    return res.redirect('/profil-desa');
  }
  const nama = String(req.body.nama || '').trim();
  if (!nama) {
    if (req.file) hapusBerkasLogo(`/uploads/logo/${req.file.filename}`);
    req.flash('error', 'Nama desa/usaha wajib diisi.');
    return res.redirect('/profil-desa');
  }

  let logoPath = desa.logo_path;
  if (req.file) {
    logoPath = `/uploads/logo/${req.file.filename}`;
    hapusBerkasLogo(desa.logo_path);
  } else if (req.body.hapus_logo === '1') {
    hapusBerkasLogo(desa.logo_path);
    logoPath = null;
  }

  db.prepare(`UPDATE desa SET nama = ?, pelaku_usaha = ?, kecamatan = ?, kabupaten = ?,
    alamat = ?, telepon = ?, logo_path = ? WHERE id = ?`).run(
    nama,
    String(req.body.pelaku_usaha || '').trim() || null,
    String(req.body.kecamatan || '').trim() || null,
    String(req.body.kabupaten || '').trim() || null,
    String(req.body.alamat || '').trim() || null,
    String(req.body.telepon || '').trim() || null,
    logoPath,
    desa.id
  );
  audit(req, 'update', 'desa', desa.id, nama);
  req.flash('success', 'Profil desa/usaha diperbarui.');
  res.redirect('/profil-desa');
});

router.post('/profil-desa/logo/hapus', (req, res) => {
  const desa = dataDesa(req.user);
  if (desa) {
    hapusBerkasLogo(desa.logo_path);
    db.prepare('UPDATE desa SET logo_path = NULL WHERE id = ?').run(desa.id);
    audit(req, 'delete', 'desa', desa.id, 'Hapus logo usaha');
  }
  req.flash('success', 'Logo dihapus.');
  res.redirect('/profil-desa');
});

module.exports = router;
