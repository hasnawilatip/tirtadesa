'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth, aksesSemuaDusun, dusunScope, bolehKelolaDusun } = require('../auth');
const { audit } = require('../helpers');

const router = express.Router();
router.use(requireAuth);

router.get('/keluhan', (req, res) => {
  const scope = dusunScope(req.user);
  const filterStatus = String(req.query.status || '').trim();
  const q = String(req.query.q || '').trim();

  let where = 'WHERE d.desa_id = ?';
  const params = [req.user.desa_id];
  if (scope != null) { where += ' AND k.dusun_id = ?'; params.push(scope); }
  if (filterStatus) { where += ' AND k.status = ?'; params.push(filterStatus); }
  if (q) { where += ' AND (k.deskripsi LIKE ? OR p.nama LIKE ? OR k.dilaporkan_oleh LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }

  const rows = db.prepare(`
    SELECT k.*, d.nama AS dusun, p.nama AS pelanggan_nama, p.nomor_pelanggan,
           s.nama AS sumur, u.nama AS petugas
    FROM keluhan k
    JOIN dusun d ON d.id = k.dusun_id
    LEFT JOIN pelanggan p ON p.id = k.pelanggan_id
    LEFT JOIN sumur s ON s.id = k.sumur_id
    LEFT JOIN users u ON u.id = k.ditangani_oleh
    ${where}
    ORDER BY CASE k.status WHEN 'baru' THEN 0 WHEN 'diproses' THEN 1 ELSE 2 END, k.tanggal_lapor DESC
  `).all(...params);

  const pelangganList = db.prepare(`
    SELECT id, nomor_pelanggan, nama, dusun_id FROM pelanggan
    WHERE desa_id = ?${scope != null ? ' AND dusun_id = ?' : ''}
    ORDER BY nama
  `).all(req.user.desa_id, ...(scope != null ? [scope] : []));

  const sumurList = db.prepare(`
    SELECT s.id, s.kode, s.nama, s.dusun_id FROM sumur s
    JOIN dusun d ON d.id = s.dusun_id
    WHERE d.desa_id = ?${scope != null ? ' AND s.dusun_id = ?' : ''}
    ORDER BY s.kode
  `).all(req.user.desa_id, ...(scope != null ? [scope] : []));

  res.render('keluhan', {
    title: 'Keluhan Pelanggan',
    rows,
    pelangganList,
    sumurList,
    dusunList: scope == null
      ? db.prepare('SELECT * FROM dusun WHERE desa_id = ? ORDER BY kode').all(req.user.desa_id)
      : db.prepare('SELECT * FROM dusun WHERE id = ? AND desa_id = ?').all(scope, req.user.desa_id),
    filters: { status: filterStatus, q },
    semua: aksesSemuaDusun(req.user),
  });
});

router.post('/keluhan', (req, res) => {
  const dusunId = Number(req.body.dusun_id) || (req.user.dusun_id || null);
  if (!dusunId || !bolehKelolaDusun(req.user, dusunId)) {
    req.flash('error', 'Dusun keluhan tidak valid.');
    return res.redirect('/keluhan');
  }
  const kategori = ['kebocoran', 'air_mati', 'kualitas_air', 'meter', 'tagihan', 'lain'].includes(req.body.kategori)
    ? req.body.kategori : 'lain';
  const deskripsi = String(req.body.deskripsi || '').trim();
  if (!deskripsi) {
    req.flash('error', 'Deskripsi keluhan wajib diisi.');
    return res.redirect('/keluhan');
  }

  const pelangganId = Number(req.body.pelanggan_id) || null;
  const sumurId = Number(req.body.sumur_id) || null;

  // Pelanggan/sumur yang dipilih harus milik dusun pada desa pengguna.
  if (pelangganId) {
    const p = db.prepare('SELECT dusun_id FROM pelanggan WHERE id = ? AND desa_id = ?').get(pelangganId, req.user.desa_id);
    if (!p || Number(p.dusun_id) !== Number(dusunId)) {
      req.flash('error', 'Pelanggan yang dipilih bukan milik dusun tersebut.');
      return res.redirect('/keluhan');
    }
  }
  if (sumurId) {
    const s = db.prepare(`SELECT s.dusun_id FROM sumur s JOIN dusun d ON d.id = s.dusun_id
      WHERE s.id = ? AND d.desa_id = ?`).get(sumurId, req.user.desa_id);
    if (!s || Number(s.dusun_id) !== Number(dusunId)) {
      req.flash('error', 'Sumur yang dipilih bukan milik dusun tersebut.');
      return res.redirect('/keluhan');
    }
  }

  try {
    const info = db.prepare(`INSERT INTO keluhan
      (dusun_id, pelanggan_id, sumur_id, kategori, deskripsi, prioritas, status, dilaporkan_oleh, telepon)
      VALUES (?,?,?,?,?,?, 'baru', ?,?)`).run(
      dusunId, pelangganId, sumurId, kategori, deskripsi,
      ['rendah', 'sedang', 'tinggi'].includes(req.body.prioritas) ? req.body.prioritas : 'sedang',
      String(req.body.dilaporkan_oleh || '').trim() || null,
      String(req.body.telepon || '').trim() || null
    );
    audit(req, 'create', 'keluhan', info.lastInsertRowid, deskripsi.slice(0, 80));
    req.flash('success', 'Keluhan dicatat.');
  } catch (err) {
    req.flash('error', `Gagal menyimpan keluhan: ${err.message}`);
  }
  res.redirect('/keluhan');
});

router.post('/keluhan/:id/status', (req, res) => {
  const row = db.prepare('SELECT * FROM keluhan WHERE id = ?').get(Number(req.params.id));
  if (!row) {
    req.flash('error', 'Keluhan tidak ditemukan.');
    return res.redirect('/keluhan');
  }
  if (!bolehKelolaDusun(req.user, row.dusun_id)) {
    return res.status(403).render('error', { title: 'Akses ditolak', message: 'Keluhan ini bukan milik dusun Anda.' });
  }
  const status = ['baru', 'diproses', 'selesai', 'ditutup'].includes(req.body.status) ? req.body.status : row.status;
  const tindak = String(req.body.tindak_lanjut || '').trim() || row.tindak_lanjut;
  db.prepare(`UPDATE keluhan SET status=?, tindak_lanjut=?, ditangani_oleh=?,
    tanggal_selesai = CASE WHEN ? IN ('selesai','ditutup') THEN datetime('now','localtime') ELSE tanggal_selesai END
    WHERE id=?`).run(status, tindak, req.user.id, status, row.id);
  audit(req, 'update', 'keluhan', row.id, status);
  req.flash('success', 'Status keluhan diperbarui.');
  res.redirect('/keluhan');
});

module.exports = router;
