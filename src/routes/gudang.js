'use strict';

/**
 * Gudang bahan.
 * Petugas & admin dapat melihat stok; admin desa/dusun mengelola item,
 * mencatat penerimaan barang, dan koreksi stok (stock opname).
 */

const express = require('express');
const { db } = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { audit } = require('../helpers');
const { kodeBahanBaru } = require('../services/penomoran');

const router = express.Router();
router.use(requireAuth);

const KATEGORI = {
  pipa: 'Pipa',
  fitting: 'Fitting',
  meter: 'Meter Air',
  aksesoris: 'Aksesoris',
  alat: 'Alat Kerja',
  lain: 'Lainnya',
};
const SATUAN = ['batang', 'buah', 'meter', 'roll', 'unit', 'kaleng', 'set'];

const SEMUA_PERAN = ['admin_desa', 'admin_dusun', 'petugas_catat', 'kasir'];
const PERAN_KELOLA = ['admin_desa', 'admin_dusun'];

function bolehKelola(user) {
  return PERAN_KELOLA.includes(user.role);
}

function kondisiStok(bahan) {
  if (Number(bahan.stok) <= 0) return 'habis';
  if (Number(bahan.stok) <= Number(bahan.stok_minimum)) return 'menipis';
  return 'aman';
}

function ringkasan(desaId) {
  const rows = db.prepare('SELECT stok, stok_minimum, harga_satuan FROM bahan WHERE desa_id = ? AND is_active = 1')
    .all(desaId);
  let nilai = 0;
  let menipis = 0;
  let habis = 0;
  rows.forEach((b) => {
    nilai += Number(b.stok) * Number(b.harga_satuan);
    const kondisi = kondisiStok(b);
    if (kondisi === 'habis') habis += 1;
    else if (kondisi === 'menipis') menipis += 1;
  });
  return { item: rows.length, nilai, menipis, habis };
}

router.get('/bahan', requireRole(...SEMUA_PERAN), (req, res) => {
  const filters = {
    q: String(req.query.q || '').trim(),
    kategori: String(req.query.kategori || '').trim(),
    kondisi: String(req.query.kondisi || '').trim(),
  };
  const syarat = ['b.desa_id = ?'];
  const nilai = [req.user.desa_id];
  if (filters.q) {
    syarat.push('(b.nama LIKE ? OR b.kode LIKE ?)');
    nilai.push(`%${filters.q}%`, `%${filters.q}%`);
  }
  if (KATEGORI[filters.kategori]) {
    syarat.push('b.kategori = ?');
    nilai.push(filters.kategori);
  }
  const rows = db.prepare(`
    SELECT b.*,
      CASE
        WHEN b.stok <= 0 THEN 'habis'
        WHEN b.stok <= b.stok_minimum THEN 'menipis'
        ELSE 'aman'
      END AS kondisi
    FROM bahan b
    WHERE ${syarat.join(' AND ')}
    ORDER BY CASE b.kategori
      WHEN 'pipa' THEN 1 WHEN 'fitting' THEN 2 WHEN 'meter' THEN 3
      WHEN 'aksesoris' THEN 4 WHEN 'alat' THEN 5 ELSE 6 END, b.nama
  `).all(...nilai);
  const hasil = filters.kondisi ? rows.filter((b) => b.kondisi === filters.kondisi) : rows;
  res.render('master/bahan', {
    title: 'Gudang Bahan',
    rows: hasil,
    filters,
    kategoriLabel: KATEGORI,
    satuanList: SATUAN,
    kodeOtomatis: kodeBahanBaru(req.user.desa_id),
    ringkas: ringkasan(req.user.desa_id),
    bolehKelola: bolehKelola(req.user),
  });
});

router.post('/bahan', requireRole(...PERAN_KELOLA), (req, res) => {
  const nama = String(req.body.nama || '').trim();
  const kategori = KATEGORI[req.body.kategori] ? req.body.kategori : 'pipa';
  const satuan = String(req.body.satuan || '').trim() || 'buah';
  const kode = String(req.body.kode || '').trim().toUpperCase() || kodeBahanBaru(req.user.desa_id);
  if (!nama) {
    req.flash('error', 'Nama bahan wajib diisi.');
    return res.redirect('/bahan');
  }
  try {
    const stok = Math.max(0, Number(req.body.stok) || 0);
    const info = db.prepare(`INSERT INTO bahan
      (desa_id, kode, nama, kategori, satuan, stok, stok_minimum, harga_satuan, lokasi)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      req.user.desa_id, kode, nama, kategori, satuan, stok,
      Math.max(0, Number(req.body.stok_minimum) || 0),
      Math.max(0, Number(req.body.harga_satuan) || 0),
      String(req.body.lokasi || '').trim() || null
    );
    if (stok > 0) {
      db.prepare(`INSERT INTO bahan_mutasi (bahan_id, jenis, jumlah, stok_akhir, referensi, keterangan, user_id)
        VALUES (?,?,?,?,?,?,?)`).run(
        info.lastInsertRowid, 'masuk', stok, stok, 'stok-awal', 'Stok awal saat bahan didaftarkan', req.user.id
      );
    }
    audit(req, 'create', 'bahan', info.lastInsertRowid, `${kode} - ${nama}`);
    req.flash('success', `Bahan ${nama} ditambahkan ke gudang.`);
  } catch (err) {
    req.flash('error', `Gagal menambah bahan: ${err.message}`);
  }
  res.redirect('/bahan');
});

router.post('/bahan/:id', requireRole(...PERAN_KELOLA), (req, res) => {
  const row = db.prepare('SELECT * FROM bahan WHERE id = ? AND desa_id = ?')
    .get(Number(req.params.id), req.user.desa_id);
  if (!row) {
    req.flash('error', 'Bahan tidak ditemukan.');
    return res.redirect('/bahan');
  }
  const nama = String(req.body.nama || '').trim();
  if (!nama) {
    req.flash('error', 'Nama bahan wajib diisi.');
    return res.redirect('/bahan');
  }
  db.prepare(`UPDATE bahan SET nama = ?, kategori = ?, satuan = ?, stok_minimum = ?,
      harga_satuan = ?, lokasi = ?, is_active = ? WHERE id = ?`).run(
    nama,
    KATEGORI[req.body.kategori] ? req.body.kategori : row.kategori,
    String(req.body.satuan || '').trim() || row.satuan,
    Math.max(0, Number(req.body.stok_minimum) || 0),
    Math.max(0, Number(req.body.harga_satuan) || 0),
    String(req.body.lokasi || '').trim() || null,
    req.body.is_active === '0' ? 0 : 1,
    row.id
  );
  audit(req, 'update', 'bahan', row.id, `${row.kode} - ${nama}`);
  req.flash('success', `Bahan ${nama} diperbarui.`);
  res.redirect('/bahan');
});

// Penerimaan barang (masuk) atau koreksi stok hasil hitung fisik.
router.post('/bahan/:id/stok', requireRole(...PERAN_KELOLA), (req, res) => {
  const row = db.prepare('SELECT * FROM bahan WHERE id = ? AND desa_id = ?')
    .get(Number(req.params.id), req.user.desa_id);
  if (!row) {
    req.flash('error', 'Bahan tidak ditemukan.');
    return res.redirect('/bahan');
  }
  const jumlah = Number(req.body.jumlah) || 0;
  const jenis = req.body.jenis === 'koreksi' ? 'koreksi' : 'masuk';
  if (jumlah <= 0 && jenis === 'masuk') {
    req.flash('error', 'Jumlah penerimaan harus lebih dari 0.');
    return res.redirect('/bahan');
  }
  const stokAkhir = jenis === 'koreksi' ? jumlah : Number(row.stok) + jumlah;
  if (stokAkhir < 0) {
    req.flash('error', 'Stok akhir tidak boleh negatif.');
    return res.redirect('/bahan');
  }
  db.transaction(() => {
    db.prepare('UPDATE bahan SET stok = ? WHERE id = ?').run(stokAkhir, row.id);
    db.prepare(`INSERT INTO bahan_mutasi (bahan_id, jenis, jumlah, stok_akhir, referensi, keterangan, user_id)
      VALUES (?,?,?,?,?,?,?)`).run(
      row.id, jenis, jumlah, stokAkhir, jenis === 'koreksi' ? 'opname' : 'penerimaan',
      String(req.body.keterangan || '').trim() || null, req.user.id
    );
  })();
  audit(req, jenis === 'koreksi' ? 'koreksi-stok' : 'stok-masuk', 'bahan', row.id,
    `${row.kode} → ${stokAkhir} ${row.satuan}`);
  req.flash('success', jenis === 'koreksi'
    ? `Stok ${row.nama} disesuaikan menjadi ${stokAkhir} ${row.satuan}.`
    : `${jumlah} ${row.satuan} ${row.nama} diterima. Stok kini ${stokAkhir}.`);
  const kembali = String(req.get('referer') || '');
  res.redirect(kembali.startsWith('http') || kembali.startsWith('/') ? kembali : '/bahan');
});

router.get('/bahan/:id', requireRole(...SEMUA_PERAN), (req, res) => {
  const row = db.prepare('SELECT * FROM bahan WHERE id = ? AND desa_id = ?')
    .get(Number(req.params.id), req.user.desa_id);
  if (!row) {
    req.flash('error', 'Bahan tidak ditemukan.');
    return res.redirect('/bahan');
  }
  const mutasi = db.prepare(`
    SELECT m.*, u.nama AS pengguna
    FROM bahan_mutasi m LEFT JOIN users u ON u.id = m.user_id
    WHERE m.bahan_id = ? ORDER BY m.id DESC LIMIT 100
  `).all(row.id);
  res.render('master/bahan-detail', {
    title: `Bahan ${row.nama}`,
    row: { ...row, kondisi: kondisiStok(row) },
    mutasi,
    kategoriLabel: KATEGORI,
    satuanList: SATUAN,
    bolehKelola: bolehKelola(req.user),
  });
});

module.exports = router;
module.exports.KATEGORI = KATEGORI;
module.exports.SATUAN = SATUAN;
module.exports.bolehKelola = bolehKelola;
module.exports.kondisiStok = kondisiStok;
