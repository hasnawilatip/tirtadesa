'use strict';

const express = require('express');

const { requireRole } = require('../auth');
const { audit } = require('../helpers');
const { ambilPengaturan, simpanPengaturan, DEFAULT } = require('../services/pengaturan');
const { buatUnggahan, hapusBerkas } = require('../services/unggah');
const csrf = require('../services/csrf');

const router = express.Router();

const unggahLogo = buatUnggahan({
  folder: 'logo',
  prefix: 'logo',
  tipe: ['image/png', 'image/jpeg', 'image/webp'],
  pesan: 'Logo harus berupa gambar PNG, JPG, atau WebP (maks. 2 MB).',
});

function unggahLogoAman(req, res, next) {
  unggahLogo.single('logo')(req, res, (err) => {
    if (err) {
      req.flash('error', err.message || 'Gagal mengunggah logo.');
      return res.redirect('/pengaturan');
    }
    return unggahLogo.validasi(req, res, (err2) => {
      if (err2) {
        req.flash('error', err2.message || 'Isi berkas logo tidak valid.');
        return res.redirect('/pengaturan');
      }
      return next();
    });
  });
}

function hapusBerkasLogo(logoPath) {
  hapusBerkas(logoPath);
}

router.get('/pengaturan', requireRole('superadmin'), (req, res) => {
  res.render('pengaturan', { title: 'Pengaturan', setelan: ambilPengaturan() });
});

router.post('/pengaturan', requireRole('superadmin'), unggahLogoAman, csrf.setelahUnggah, (req, res) => {
  const lama = ambilPengaturan();
  const nama = String(req.body.nama_aplikasi || '').trim();
  const tagline = String(req.body.tagline || '').trim() || DEFAULT.tagline;

  if (!nama) {
    if (req.file) hapusBerkasLogo(`/uploads/logo/${req.file.filename}`);
    req.flash('error', 'Nama aplikasi wajib diisi.');
    return res.redirect('/pengaturan');
  }

  let logoPath = lama.logo_path;
  if (req.file) {
    logoPath = `/uploads/logo/${req.file.filename}`;
    hapusBerkasLogo(lama.logo_path);
  }

  simpanPengaturan({ nama_aplikasi: nama, tagline, logo_path: logoPath });
  audit(req, 'update', 'pengaturan', 1, `${nama} · ${tagline}`);
  req.flash('success', 'Pengaturan branding diperbarui.');
  res.redirect('/pengaturan');
});

router.post('/pengaturan/logo/hapus', requireRole('superadmin'), (req, res) => {
  const lama = ambilPengaturan();
  hapusBerkasLogo(lama.logo_path);
  simpanPengaturan({ ...lama, logo_path: null });
  audit(req, 'delete', 'pengaturan', 1, 'Hapus logo aplikasi');
  req.flash('success', 'Logo dihapus. Inisial nama aplikasi akan digunakan kembali.');
  res.redirect('/pengaturan');
});

module.exports = router;
