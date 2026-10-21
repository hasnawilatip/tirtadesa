'use strict';

/**
 * Halaman langganan milik pengelola (admin desa / admin dusun).
 * Menampilkan paket yang dipakai, pemakaian kuota, masa aktif, dan
 * paket lain yang tersedia bila ingin menambah kapasitas.
 */

const express = require('express');
const { db } = require('../db');
const { requireRole } = require('../auth');
const { audit } = require('../helpers');
const { infoLangganan, daftarPaket } = require('../services/langganan');
const tagihanLgn = require('../services/tagihan-langganan');
const bayar = require('../services/bayar-online');
const { buatUnggahan, hapusBerkas } = require('../services/unggah');
const csrf = require('../services/csrf');

const router = express.Router();

const unggahBukti = buatUnggahan({
  folder: 'bayar',
  prefix: 'lgn',
  tipe: ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'],
  pesan: 'Bukti pembayaran harus berupa gambar (PNG/JPG/WebP) atau PDF maks. 2 MB.',
});

function unggahBuktiAman(req, res, next) {
  unggahBukti.single('bukti')(req, res, (err) => {
    if (err) {
      req.flash('error', err.message || 'Gagal mengunggah bukti pembayaran.');
      return res.redirect(`/langganan/tagihan/${Number(req.params.id) || ''}`);
    }
    return unggahBukti.validasi(req, res, (err2) => {
      if (err2) {
        req.flash('error', err2.message || 'Isi berkas bukti tidak valid.');
        return res.redirect(`/langganan/tagihan/${Number(req.params.id) || ''}`);
      }
      return next();
    });
  });
}

const LABEL_STATUS = {
  aktif: 'Aktif',
  trial: 'Masa percobaan',
  ditangguhkan: 'Ditangguhkan',
};

function tagihanMilik(req) {
  const tag = tagihanLgn.byId(req.params.id);
  if (!tag || Number(tag.desa_id) !== Number(req.user.desa_id)) return null;
  return tag;
}

router.get('/langganan', requireRole('admin_desa', 'admin_dusun'), (req, res) => {
  const desaId = req.user.desa_id;
  const info = infoLangganan(desaId);
  if (!info) {
    req.flash('error', 'Data langganan tidak ditemukan.');
    return res.redirect('/');
  }

  // Tagihan siklus berikutnya disiapkan otomatis bila belum ada.
  tagihanLgn.pastikan(desaId);

  const paketLain = daftarPaket({ hanyaAktif: true })
    .filter((p) => !info.paket || p.id !== info.paket.id);

  res.render('langganan', {
    title: 'Langganan Saya',
    info,
    paketLain,
    statusLabel: LABEL_STATUS,
    peranDesa: req.user.role === 'admin_desa',
    tagihanTerbuka: tagihanLgn.terbukaUntuk(desaId),
    riwayatTagihan: tagihanLgn.daftarUntuk(desaId, 6),
    labelStatusTagihan: tagihanLgn.LABEL_STATUS,
    bayarInfo: bayar.infoBayar(),
    saluranTersedia: bayar.daftarSaluran().length,
  });
});

router.get('/langganan/tagihan/:id', requireRole('admin_desa', 'admin_dusun'), (req, res) => {
  const tag = tagihanMilik(req);
  if (!tag) {
    req.flash('error', 'Tagihan langganan tidak ditemukan.');
    return res.redirect('/langganan');
  }

  const info = bayar.infoBayar();
  const saluran = info.aktif ? bayar.daftarSaluran() : [];
  const dipilihId = Number(req.query.saluran) || Number(tag.saluran_id) || (saluran[0] ? saluran[0].id : null);
  const terpilih = saluran.find((s) => Number(s.id) === Number(dipilihId)) || saluran[0] || null;

  res.render('langganan-tagihan', {
    title: `Tagihan ${tag.nomor}`,
    tag,
    saluran,
    terpilih,
    bayarInfo: info,
    jenisLabel: bayar.JENIS_SALURAN,
    labelStatus: tagihanLgn.LABEL_STATUS,
    peranDesa: req.user.role === 'admin_desa',
    tujuan: bayar.urlPembayaran(terpilih, {
      kode: tag.nomor,
      total: tag.jumlah,
      tagihan: tag.nomor,
      pelanggan: req.user.nama,
    }),
  });
});

router.post('/langganan/tagihan/:id/bayar', requireRole('admin_desa'), (req, res) => {
  const tag = tagihanMilik(req);
  if (!tag) {
    req.flash('error', 'Tagihan langganan tidak ditemukan.');
    return res.redirect('/langganan');
  }
  if (tag.status === 'lunas') {
    req.flash('error', 'Tagihan ini sudah lunas.');
    return res.redirect(`/langganan/tagihan/${tag.id}`);
  }
  if (tag.status === 'batal') {
    req.flash('error', 'Tagihan ini sudah dibatalkan.');
    return res.redirect('/langganan');
  }

  const saluran = bayar.saluranById(req.body.saluran_id);
  if (!saluran || !saluran.is_active) {
    req.flash('error', 'Pilih metode pembayaran yang tersedia.');
    return res.redirect(`/langganan/tagihan/${tag.id}`);
  }

  db.prepare(`UPDATE tagihan_langganan SET status = 'menunggu', saluran_id = ?, catatan = ?
    WHERE id = ?`).run(
    saluran.id, String(req.body.catatan || '').trim() || null, tag.id
  );
  audit(req, 'update', 'tagihan_langganan', tag.id, `Ajukan bayar ${tag.nomor} via ${saluran.nama}`);

  const tujuan = bayar.urlPembayaran(saluran, {
    kode: tag.nomor,
    total: tag.jumlah,
    tagihan: tag.nomor,
    pelanggan: req.user.nama,
  });
  if (tujuan) {
    req.flash('success', `Lanjutkan pembayaran di halaman ${saluran.penyedia || saluran.nama}. Nomor tagihan ${tag.nomor}.`);
    return res.redirect(tujuan);
  }

  req.flash('success', `Pembayaran ${tag.nomor} diajukan. Unggah bukti transfer agar dapat diverifikasi.`);
  return res.redirect(`/langganan/tagihan/${tag.id}`);
});

router.post('/langganan/tagihan/:id/bukti', requireRole('admin_desa'), unggahBuktiAman, csrf.setelahUnggah, (req, res) => {
  const tag = tagihanMilik(req);
  if (!tag) {
    if (req.file) hapusBerkas(`/uploads/bayar/${req.file.filename}`);
    req.flash('error', 'Tagihan langganan tidak ditemukan.');
    return res.redirect('/langganan');
  }
  if (!['belum_bayar', 'menunggu'].includes(tag.status)) {
    if (req.file) hapusBerkas(`/uploads/bayar/${req.file.filename}`);
    req.flash('error', 'Tagihan ini sudah diproses, bukti tidak dapat diubah.');
    return res.redirect(`/langganan/tagihan/${tag.id}`);
  }

  const buktiBaru = req.file ? `/uploads/bayar/${req.file.filename}` : tag.bukti_path;
  if (req.file && tag.bukti_path) hapusBerkas(tag.bukti_path);

  db.prepare(`UPDATE tagihan_langganan SET bukti_path = ?, catatan = ?, status = 'menunggu'
    WHERE id = ?`).run(
    buktiBaru || null,
    String(req.body.catatan || '').trim() || tag.catatan || null,
    tag.id
  );
  audit(req, 'update', 'tagihan_langganan', tag.id, `Bukti bayar ${tag.nomor}`);
  req.flash('success', 'Bukti pembayaran terkirim. Menunggu verifikasi penyedia layanan.');
  res.redirect(`/langganan/tagihan/${tag.id}`);
});

module.exports = router;
