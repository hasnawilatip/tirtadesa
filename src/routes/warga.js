'use strict';

/**
 * Portal warga (pelanggan): hanya melihat data miliknya sendiri.
 * Akun warga ditautkan ke satu pelanggan melalui users.pelanggan_id.
 */

const express = require('express');
const { db } = require('../db');
const { audit } = require('../helpers');
const { buatUnggahan, hapusBerkas } = require('../services/unggah');
const csrf = require('../services/csrf');
const bayar = require('../services/bayar-online');

const router = express.Router();
router.use((req, res, next) => {
  if (!req.user) return res.redirect('/login');
  // Staf yang membuka portal warga diarahkan kembali ke dashboard operator.
  if (req.user.role !== 'warga') return res.redirect('/');
  return next();
});

const unggahBukti = buatUnggahan({
  folder: 'bayar',
  prefix: 'bukti',
  tipe: ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'],
  pesan: 'Bukti pembayaran harus berupa gambar (PNG/JPG/WebP) atau PDF maks. 2 MB.',
});

function unggahBuktiAman(req, res, next) {
  unggahBukti.single('bukti')(req, res, (err) => {
    if (err) {
      req.flash('error', err.message || 'Gagal mengunggah bukti pembayaran.');
      const kode = String(req.params.kode || '');
      return res.redirect(kode ? `/warga/bayar/${kode}` : '/warga/tagihan');
    }
    return unggahBukti.validasi(req, res, (err2) => {
      if (err2) {
        req.flash('error', err2.message || 'Isi berkas bukti tidak valid.');
        const kode = String(req.params.kode || '');
        return res.redirect(kode ? `/warga/bayar/${kode}` : '/warga/tagihan');
      }
      return next();
    });
  });
}

function pelangganSaya(user) {
  if (!user.pelanggan_id) return null;
  return db.prepare(`
    SELECT p.*, d.nama AS dusun
    FROM pelanggan p LEFT JOIN dusun d ON d.id = p.dusun_id
    WHERE p.id = ? AND p.desa_id = ?
  `).get(user.pelanggan_id, user.desa_id);
}

function tagihanSaya(pelangganId) {
  return db.prepare(`
    SELECT t.*, per.tahun, per.bulan
    FROM tagihan t JOIN periode_tagihan per ON per.id = t.periode_id
    WHERE t.pelanggan_id = ?
    ORDER BY per.tahun DESC, per.bulan DESC, t.id DESC
  `).all(pelangganId);
}

function pemakaianSaya(pelangganId, batas = 24) {
  return db.prepare(`
    SELECT b.*, per.tahun, per.bulan
    FROM pembacaan_meter b JOIN periode_tagihan per ON per.id = b.periode_id
    WHERE b.pelanggan_id = ?
    ORDER BY per.tahun DESC, per.bulan DESC
    LIMIT ?
  `).all(pelangganId, batas);
}

function keluhanSaya(pelangganId) {
  return db.prepare(`
    SELECT * FROM keluhan WHERE pelanggan_id = ? ORDER BY tanggal_lapor DESC, id DESC
  `).all(pelangganId);
}

// ---------------------------------------------------------------------------
// RINGKASAN
// ---------------------------------------------------------------------------

router.get('/', (req, res) => {
  const pelanggan = pelangganSaya(req.user);
  const tagihan = pelanggan ? tagihanSaya(pelanggan.id) : [];
  const belumLunas = tagihan.filter((t) => t.status !== 'lunas' && t.status !== 'batal');
  const sisa = belumLunas.reduce((a, t) => a + (t.total - t.terbayar), 0);
  const pemakaian = pelanggan ? pemakaianSaya(pelanggan.id, 6) : [];
  const keluhan = pelanggan ? keluhanSaya(pelanggan.id) : [];

  res.render('warga/dashboard', {
    title: 'Ringkasan',
    pelanggan,
    tagihan: tagihan.slice(0, 5),
    belumLunas,
    sisa,
    pemakaian,
    keluhan: keluhan.slice(0, 3),
    bayarInfo: bayar.infoBayar(),
    menunggu: pelanggan ? bayar.petaMenunggu(pelanggan.id) : {},
  });
});

// ---------------------------------------------------------------------------
// TAGIHAN
// ---------------------------------------------------------------------------

router.get('/tagihan', (req, res) => {
  const pelanggan = pelangganSaya(req.user);
  const rows = pelanggan ? tagihanSaya(pelanggan.id) : [];
  res.render('warga/tagihan', {
    title: 'Tagihan Saya',
    pelanggan,
    rows,
    bayarInfo: bayar.infoBayar(),
    saluranAktif: bayar.daftarSaluran().length,
    menunggu: pelanggan ? bayar.petaMenunggu(pelanggan.id) : {},
  });
});

router.get('/tagihan/:id/cetak', (req, res) => {
  const pelanggan = pelangganSaya(req.user);
  if (!pelanggan) return res.redirect('/warga');

  const tagihan = db.prepare(`
    SELECT t.*, p.nama, p.nomor_pelanggan, p.alamat, d.nama AS dusun,
           per.tahun, per.bulan, m.nomor_meter
    FROM tagihan t
    JOIN pelanggan p ON p.id = t.pelanggan_id
    JOIN dusun d ON d.id = t.dusun_id
    JOIN periode_tagihan per ON per.id = t.periode_id
    LEFT JOIN sambungan m ON m.id = t.sambungan_id
    WHERE t.id = ? AND t.pelanggan_id = ?
  `).get(Number(req.params.id), pelanggan.id);

  if (!tagihan) {
    req.flash('error', 'Tagihan tidak ditemukan.');
    return res.redirect('/warga/tagihan');
  }

  const items = db.prepare('SELECT * FROM tagihan_item WHERE tagihan_id = ? ORDER BY urutan, id').all(tagihan.id);
  const pembayaran = db.prepare(`
    SELECT nomor_kwitansi, tanggal_bayar, jumlah, metode, status
    FROM pembayaran WHERE tagihan_id = ? ORDER BY id
  `).all(tagihan.id);
  const totalDibayar = pembayaran
    .filter((b) => b.status === 'valid')
    .reduce((a, b) => a + b.jumlah, 0);
  const desa = db.prepare('SELECT * FROM desa WHERE id = ?').get(req.user.desa_id);

  return res.render('tagihan/cetak', {
    title: `Struk ${tagihan.nomor_tagihan}`,
    tagihan,
    items,
    pembayaran,
    totalDibayar,
    desa,
    kembali: '/warga/tagihan',
  });
});

// ---------------------------------------------------------------------------
// BAYAR ONLINE
// ---------------------------------------------------------------------------

function tagihanWarga(pelangganId, tagihanId) {
  return db.prepare(`
    SELECT t.*, per.tahun, per.bulan, per.tanggal_jatuh_tempo
    FROM tagihan t JOIN periode_tagihan per ON per.id = t.periode_id
    WHERE t.id = ? AND t.pelanggan_id = ?
  `).get(Number(tagihanId), Number(pelangganId)) || null;
}

function sisaTagihan(t) {
  return Math.max(0, Math.round((t.total - t.terbayar) * 100) / 100);
}

function alasanTidakBisaBayar(t) {
  if (t.status === 'batal') return 'Tagihan ini dibatalkan, tidak perlu dibayar.';
  if (sisaTagihan(t) <= 0) return 'Tagihan ini sudah lunas.';
  if (!bayar.infoBayar().aktif) return 'Pembayaran online sedang dinonaktifkan pengelola. Hubungi kasir desa.';
  return null;
}

router.get('/tagihan/:id/bayar', (req, res) => {
  const pelanggan = pelangganSaya(req.user);
  if (!pelanggan) return res.redirect('/warga');

  const tagihan = tagihanWarga(pelanggan.id, req.params.id);
  if (!tagihan) {
    req.flash('error', 'Tagihan tidak ditemukan pada akun Anda.');
    return res.redirect('/warga/tagihan');
  }

  const info = bayar.infoBayar();
  const saluran = info.aktif ? bayar.daftarSaluran() : [];
  const dipilihId = Number(req.query.saluran) || (saluran[0] ? saluran[0].id : null);
  const terpilih = saluran.find((s) => Number(s.id) === Number(dipilihId)) || saluran[0] || null;
  const menunggu = bayar.menungguUntuk(tagihan.id);

  res.render('warga/bayar', {
    title: 'Bayar Tagihan',
    pelanggan,
    tagihan,
    sisa: sisaTagihan(tagihan),
    saluran,
    terpilih,
    menunggu,
    bayarInfo: info,
    jenisLabel: bayar.JENIS_SALURAN,
    alasanBlokir: alasanTidakBisaBayar(tagihan),
  });
});

router.post('/tagihan/:id/bayar', (req, res) => {
  const pelanggan = pelangganSaya(req.user);
  if (!pelanggan) return res.redirect('/warga');

  const tagihan = tagihanWarga(pelanggan.id, req.params.id);
  if (!tagihan) {
    req.flash('error', 'Tagihan tidak ditemukan pada akun Anda.');
    return res.redirect('/warga/tagihan');
  }

  const blokir = alasanTidakBisaBayar(tagihan);
  if (blokir) {
    req.flash('error', blokir);
    return res.redirect('/warga/tagihan');
  }

  const saluran = bayar.saluranById(req.body.saluran_id);
  if (!saluran || !saluran.is_active) {
    req.flash('error', 'Pilih metode pembayaran yang tersedia.');
    return res.redirect(`/warga/tagihan/${tagihan.id}/bayar`);
  }

  const jumlah = sisaTagihan(tagihan);
  const { row } = bayar.buatPermintaan({
    tagihan,
    pelanggan,
    saluran,
    jumlah,
    catatan: req.body.catatan_warga,
  });

  audit(req, 'create', 'pembayaran_online', row.id, `${row.kode} · tagihan ${tagihan.nomor_tagihan}`);

  // Saluran berupa link (gateway/landing page pembayaran) → arahkan langsung.
  const tujuan = bayar.urlPembayaran(saluran, {
    kode: row.kode,
    total: jumlah,
    tagihan: tagihan.nomor_tagihan,
    pelanggan: pelanggan.nomor_pelanggan,
  });
  if (tujuan) {
    req.flash('success', `Lanjutkan pembayaran di halaman ${saluran.penyedia || saluran.nama}. Kode referensi ${row.kode}.`);
    return res.redirect(tujuan);
  }

  req.flash('success', `Permintaan pembayaran ${row.kode} dibuat. Ikuti instruksi lalu unggah bukti bayar.`);
  return res.redirect(`/warga/bayar/${encodeURIComponent(row.kode)}`);
});

function ambilMilikSaya(req) {
  const pelanggan = pelangganSaya(req.user);
  if (!pelanggan) return { pelanggan: null, row: null };
  const row = bayar.ambilByKode(String(req.params.kode || ''));
  if (!row || Number(row.pelanggan_id) !== Number(pelanggan.id)) return { pelanggan, row: null };
  return { pelanggan, row };
}

router.get('/bayar/:kode', (req, res) => {
  const { pelanggan, row } = ambilMilikSaya(req);
  if (!pelanggan) return res.redirect('/warga');
  if (!row) {
    req.flash('error', 'Kode pembayaran tidak ditemukan.');
    return res.redirect('/warga/tagihan');
  }

  const tagihan = tagihanWarga(pelanggan.id, row.tagihan_id);
  const saluran = bayar.saluranById(row.saluran_id);

  res.render('warga/bayar-status', {
    title: `Pembayaran ${row.kode}`,
    pelanggan,
    row,
    tagihan,
    saluran,
    jenisLabel: bayar.JENIS_SALURAN,
    statusLabel: bayar.STATUS_ONLINE,
    tujuan: bayar.urlPembayaran(saluran, {
      kode: row.kode,
      total: row.jumlah,
      tagihan: tagihan ? tagihan.nomor_tagihan : '',
      pelanggan: pelanggan.nomor_pelanggan,
    }),
  });
});

router.post('/bayar/:kode/bukti', unggahBuktiAman, csrf.setelahUnggah, (req, res) => {
  const { pelanggan, row } = ambilMilikSaya(req);
  if (!pelanggan) return res.redirect('/warga');
  if (!row) {
    if (req.file) hapusBerkas(`/uploads/bayar/${req.file.filename}`);
    req.flash('error', 'Kode pembayaran tidak ditemukan.');
    return res.redirect('/warga/tagihan');
  }
  if (row.status !== 'menunggu') {
    if (req.file) hapusBerkas(`/uploads/bayar/${req.file.filename}`);
    req.flash('error', 'Permintaan ini sudah diproses, bukti tidak dapat diubah.');
    return res.redirect(`/warga/bayar/${row.kode}`);
  }

  const buktiBaru = req.file ? `/uploads/bayar/${req.file.filename}` : row.bukti_path;
  if (req.file && row.bukti_path) hapusBerkas(row.bukti_path);

  db.prepare(`UPDATE pembayaran_online
    SET bukti_path = ?, catatan_warga = ?, updated_at = datetime('now','localtime')
    WHERE id = ?`).run(
    buktiBaru || null,
    String(req.body.catatan_warga || '').trim() || row.catatan_warga || null,
    row.id
  );

  audit(req, 'update', 'pembayaran_online', row.id, `Bukti bayar ${row.kode}`);
  req.flash('success', 'Terima kasih. Bukti pembayaran dikirim, menunggu verifikasi kasir.');
  res.redirect(`/warga/bayar/${row.kode}`);
});

// ---------------------------------------------------------------------------
// PEMAKAIAN
// ---------------------------------------------------------------------------

router.get('/pemakaian', (req, res) => {
  const pelanggan = pelangganSaya(req.user);
  res.render('warga/pemakaian', {
    title: 'Pemakaian Air',
    pelanggan,
    rows: pelanggan ? pemakaianSaya(pelanggan.id, 24) : [],
  });
});

// ---------------------------------------------------------------------------
// KELUHAN
// ---------------------------------------------------------------------------

const KATEGORI_KELUHAN = ['Kebocoran', 'Air tidak mengalir', 'Meter rusak', 'Kualitas air', 'Tagihan', 'Lainnya'];

router.get('/keluhan', (req, res) => {
  const pelanggan = pelangganSaya(req.user);
  res.render('warga/keluhan', {
    title: 'Keluhan',
    pelanggan,
    kategoriList: KATEGORI_KELUHAN,
    rows: pelanggan ? keluhanSaya(pelanggan.id) : [],
  });
});

router.post('/keluhan', (req, res) => {
  const pelanggan = pelangganSaya(req.user);
  if (!pelanggan) return res.redirect('/warga');

  const kategori = KATEGORI_KELUHAN.includes(req.body.kategori) ? req.body.kategori : 'Lainnya';
  const deskripsi = String(req.body.deskripsi || '').trim();
  const telepon = String(req.body.telepon || '').trim() || pelanggan.telepon || null;

  if (deskripsi.length < 5) {
    req.flash('error', 'Tuliskan keluhan minimal 5 karakter.');
    return res.redirect('/warga/keluhan');
  }

  const info = db.prepare(`INSERT INTO keluhan
    (dusun_id, pelanggan_id, kategori, deskripsi, prioritas, status, dilaporkan_oleh, telepon)
    VALUES (?,?,?,?, 'sedang', 'baru', ?, ?)`).run(
    pelanggan.dusun_id, pelanggan.id, kategori, deskripsi, req.user.nama, telepon
  );
  audit(req, 'create', 'keluhan', info.lastInsertRowid, `Keluhan warga: ${kategori}`);
  req.flash('success', 'Keluhan terkirim. Petugas akan menindaklanjuti.');
  res.redirect('/warga/keluhan');
});

module.exports = router;
