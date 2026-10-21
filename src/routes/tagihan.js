'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth, requireRole, aksesSemuaDusun, dusunScope } = require('../auth');
const { audit, todayISO } = require('../helpers');
const { statusDari, catatPembayaran } = require('../services/pembayaran');

const router = express.Router();
router.use(requireAuth);

function bisaAksesTagihan(user, dusunId) {
  const dusun = db.prepare('SELECT desa_id FROM dusun WHERE id = ?').get(Number(dusunId));
  if (!dusun || Number(dusun.desa_id) !== Number(user.desa_id)) return false;
  if (['admin_desa', 'superadmin', 'kasir'].includes(user.role)) return true;
  return Number(user.dusun_id) === Number(dusunId);
}

// ---------------------------------------------------------------------------
// DAFTAR TAGIHAN
// ---------------------------------------------------------------------------

router.get('/tagihan', (req, res) => {
  const scope = dusunScope(req.user);
  const periodeId = Number(req.query.periode) || null;
  const filterStatus = String(req.query.status || '').trim();
  const filterDusun = Number(req.query.dusun) || null;
  const q = String(req.query.q || '').trim();
  const pelangganId = Number(req.query.pelanggan) || null;
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = 40;

  let pelangganTerpilih = null;
  if (pelangganId) {
    pelangganTerpilih = db.prepare(`
      SELECT p.id, p.nama, p.nomor_pelanggan, p.dusun_id, m.nomor_meter
      FROM pelanggan p
      LEFT JOIN sambungan m ON m.pelanggan_id = p.id AND m.status = 'aktif'
      WHERE p.id = ? AND p.desa_id = ?
    `).get(pelangganId, req.user.desa_id);
    if (!pelangganTerpilih) {
      req.flash('error', 'Pelanggan tidak ditemukan.');
      return res.redirect('/tagihan');
    }
    if (scope != null && Number(pelangganTerpilih.dusun_id) !== Number(scope)) {
      return res.status(403).render('error', {
        title: 'Akses ditolak',
        message: 'Pelanggan ini bukan milik dusun Anda.',
      });
    }
  }

  let where = 'WHERE d.desa_id = ?';
  const params = [req.user.desa_id];
  if (scope != null) { where += ' AND t.dusun_id = ?'; params.push(scope); }
  if (pelangganTerpilih) { where += ' AND t.pelanggan_id = ?'; params.push(pelangganTerpilih.id); }
  if (periodeId) { where += ' AND t.periode_id = ?'; params.push(periodeId); }
  if (filterDusun) { where += ' AND t.dusun_id = ?'; params.push(filterDusun); }
  if (filterStatus === 'tunggakan') {
    where += " AND t.status <> 'lunas' AND t.status <> 'batal'";
  } else if (filterStatus) {
    where += ' AND t.status = ?';
    params.push(filterStatus);
  }
  if (q) {
    where += ` AND (p.nama LIKE ? OR p.nomor_pelanggan LIKE ? OR t.nomor_tagihan LIKE ?
      OR sb.nomor_meter LIKE ? OR sb.nomor_seri LIKE ?)`;
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }

  const ringkas = db.prepare(`
    SELECT COUNT(*) AS jumlah,
           COALESCE(SUM(t.total), 0) AS total,
           COALESCE(SUM(t.terbayar), 0) AS terbayar,
           COALESCE(SUM(CASE WHEN t.status = 'batal' THEN 0 ELSE t.total - t.terbayar END), 0) AS sisa
    FROM tagihan t JOIN pelanggan p ON p.id = t.pelanggan_id
    JOIN dusun d ON d.id = t.dusun_id
    LEFT JOIN sambungan sb ON sb.id = t.sambungan_id
    ${where}
  `).get(...params);

  const rows = db.prepare(`
    SELECT t.*, p.nama, p.nomor_pelanggan, d.nama AS dusun,
           per.tahun, per.bulan, sb.nomor_meter
    FROM tagihan t
    JOIN pelanggan p ON p.id = t.pelanggan_id
    JOIN dusun d ON d.id = t.dusun_id
    JOIN periode_tagihan per ON per.id = t.periode_id
    LEFT JOIN sambungan sb ON sb.id = t.sambungan_id
    ${where}
    ORDER BY per.tahun DESC, per.bulan DESC, p.nomor_pelanggan
    LIMIT ? OFFSET ?
  `).all(...params, perPage, (page - 1) * perPage);

  const totalPages = Math.max(1, Math.ceil(ringkas.jumlah / perPage));

  res.render('tagihan/index', {
    title: 'Tagihan',
    rows,
    ringkas,
    page,
    totalPages,
    // Hanya peran ini yang boleh mencatat pembayaran langsung dari daftar tagihan.
    bolehBayar: ['kasir', 'admin_desa', 'admin_dusun', 'superadmin'].includes(req.user.role),
    periodeList: db.prepare('SELECT * FROM periode_tagihan WHERE desa_id = ? ORDER BY tahun DESC, bulan DESC').all(req.user.desa_id),
    dusunList: scope == null
      ? db.prepare('SELECT * FROM dusun WHERE desa_id = ? ORDER BY kode').all(req.user.desa_id)
      : db.prepare('SELECT * FROM dusun WHERE id = ? AND desa_id = ?').all(scope, req.user.desa_id),
    filters: { periode: periodeId, status: filterStatus, dusun: filterDusun, q, pelanggan: pelangganId },
    pelangganTerpilih,
  });
});

// Autocomplete pelanggan: dicari dari nomor meter, nama, atau nomor pelanggan.
router.get('/tagihan/cari', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ data: [] });
  const scope = dusunScope(req.user);
  const pola = `%${q}%`;
  const data = db.prepare(`
    SELECT p.id, p.nama, p.nomor_pelanggan, m.nomor_meter, m.nomor_seri, d.nama AS dusun
    FROM pelanggan p
    JOIN dusun d ON d.id = p.dusun_id
    LEFT JOIN sambungan m ON m.pelanggan_id = p.id AND m.status = 'aktif'
    WHERE p.desa_id = ?${scope != null ? ' AND p.dusun_id = ?' : ''}
      AND (m.nomor_meter LIKE ? OR m.nomor_seri LIKE ? OR p.nama LIKE ? OR p.nomor_pelanggan LIKE ?)
    ORDER BY CASE WHEN m.nomor_meter LIKE ? THEN 0 WHEN m.nomor_seri LIKE ? THEN 1 ELSE 2 END,
      p.nomor_pelanggan
    LIMIT 15
  `).all(
    req.user.desa_id,
    ...(scope != null ? [scope] : []),
    pola, pola, pola, pola, pola, pola
  );
  return res.json({ data });
});

// ---------------------------------------------------------------------------
// DETAIL TAGIHAN & PEMBAYARAN
// ---------------------------------------------------------------------------

function ambilTagihan(id) {
  return db.prepare(`
    SELECT t.*, p.nama, p.nomor_pelanggan, p.alamat, p.telepon,
           d.nama AS dusun, per.tahun, per.bulan, m.nomor_meter
    FROM tagihan t
    JOIN pelanggan p ON p.id = t.pelanggan_id
    JOIN dusun d ON d.id = t.dusun_id
    JOIN periode_tagihan per ON per.id = t.periode_id
    LEFT JOIN sambungan m ON m.id = t.sambungan_id
    WHERE t.id = ?
  `).get(id);
}

router.get('/tagihan/:id/cetak', (req, res) => {
  const tagihan = ambilTagihan(Number(req.params.id));
  if (!tagihan) {
    req.flash('error', 'Tagihan tidak ditemukan.');
    return res.redirect('/tagihan');
  }
  if (!bisaAksesTagihan(req.user, tagihan.dusun_id)) {
    return res.status(403).render('error', { title: 'Akses ditolak', message: 'Tagihan ini bukan milik pengelola Anda.' });
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
    title: `Cetak ${tagihan.nomor_tagihan}`, tagihan, items, pembayaran, totalDibayar, desa,
  });
});

router.get('/tagihan/:id', (req, res) => {
  const tagihan = ambilTagihan(Number(req.params.id));
  if (!tagihan) {
    req.flash('error', 'Tagihan tidak ditemukan.');
    return res.redirect('/tagihan');
  }
  if (!bisaAksesTagihan(req.user, tagihan.dusun_id)) {
    return res.status(403).render('error', { title: 'Akses ditolak', message: 'Tagihan ini bukan milik dusun Anda.' });
  }

  const items = db.prepare('SELECT * FROM tagihan_item WHERE tagihan_id = ? ORDER BY urutan, id').all(tagihan.id);
  const pembayaran = db.prepare(`
    SELECT b.*, u.nama AS kasir FROM pembayaran b
    LEFT JOIN users u ON u.id = b.kasir_id
    WHERE b.tagihan_id = ? ORDER BY b.id DESC
  `).all(tagihan.id);

  const bolehBayar = ['kasir', 'admin_desa', 'superadmin', 'admin_dusun'].includes(req.user.role)
    && tagihan.status !== 'batal' && tagihan.status !== 'lunas';

  res.render('tagihan/detail', {
    title: `Tagihan ${tagihan.nomor_tagihan}`,
    tagihan,
    items,
    pembayaran,
    bolehBayar,
    adminDesa: aksesSemuaDusun(req.user),
  });
});

router.post('/tagihan/:id/bayar', requireRole('kasir', 'admin_desa', 'admin_dusun', 'superadmin'), (req, res) => {
  const tagihan = ambilTagihan(Number(req.params.id));
  if (!tagihan) {
    req.flash('error', 'Tagihan tidak ditemukan.');
    return res.redirect('/tagihan');
  }
  if (!bisaAksesTagihan(req.user, tagihan.dusun_id)) {
    return res.status(403).render('error', { title: 'Akses ditolak', message: 'Tagihan ini bukan milik dusun Anda.' });
  }
  if (tagihan.status === 'batal') {
    req.flash('error', 'Tagihan sudah dibatalkan.');
    return res.redirect(`/tagihan/${tagihan.id}`);
  }

  const sisa = Math.round((tagihan.total - tagihan.terbayar) * 100) / 100;
  const jumlah = Math.round((Number(req.body.jumlah) || 0) * 100) / 100;
  const metode = ['tunai', 'transfer', 'qris', 'lain'].includes(req.body.metode) ? req.body.metode : 'tunai';
  const tanggal = String(req.body.tanggal_bayar || '').trim() || todayISO();

  if (jumlah <= 0) {
    req.flash('error', 'Jumlah pembayaran harus lebih dari nol.');
    return res.redirect(`/tagihan/${tagihan.id}`);
  }
  if (jumlah > sisa + 0.005) {
    req.flash('error', `Jumlah pembayaran melebihi sisa tagihan (${sisa}).`);
    return res.redirect(`/tagihan/${tagihan.id}`);
  }

  try {
    const pembayaranId = catatPembayaran({
      tagihan,
      jumlah,
      metode,
      tanggal,
      userId: req.user.id,
      catatan: req.body.catatan,
    });

    audit(req, 'create', 'pembayaran', pembayaranId, `${tagihan.nomor_tagihan} sebesar ${jumlah}`);
    req.flash('success', 'Pembayaran dicatat. Kwitansi siap dicetak.');
    return res.redirect(`/kwitansi/${pembayaranId}`);
  } catch (err) {
    req.flash('error', `Gagal mencatat pembayaran: ${err.message}`);
    return res.redirect(`/tagihan/${tagihan.id}`);
  }
});

router.post('/pembayaran/:id/batal', requireRole('admin_desa', 'superadmin'), (req, res) => {
  const bayar = db.prepare(`
    SELECT b.*, t.dusun_id, t.total, t.jatuh_tempo, t.nomor_tagihan
    FROM pembayaran b JOIN tagihan t ON t.id = b.tagihan_id WHERE b.id = ?
  `).get(Number(req.params.id));
  if (!bayar) {
    req.flash('error', 'Pembayaran tidak ditemukan.');
    return res.redirect('/tagihan');
  }
  if (!bisaAksesTagihan(req.user, bayar.dusun_id)) {
    return res.status(403).render('error', { title: 'Akses ditolak', message: 'Pembayaran ini bukan milik pengelola Anda.' });
  }
  if (bayar.status === 'batal') {
    req.flash('error', 'Pembayaran sudah dibatalkan sebelumnya.');
    return res.redirect(`/tagihan/${bayar.tagihan_id}`);
  }

  const alasan = String(req.body.alasan || '').trim() || 'Dibatalkan admin desa';
  try {
    db.transaction(() => {
      db.prepare(`UPDATE pembayaran SET status='batal', dibatalkan_oleh=?, alasan_batal=?
        WHERE id=?`).run(req.user.id, alasan, bayar.id);

      const totalValid = db.prepare("SELECT COALESCE(SUM(jumlah),0) AS v FROM pembayaran WHERE tagihan_id = ? AND status = 'valid'")
        .get(bayar.tagihan_id).v;
      const statusBaru = statusDari(bayar.total, totalValid, bayar.jatuh_tempo);
      db.prepare('UPDATE tagihan SET terbayar = ?, status = ? WHERE id = ?')
        .run(totalValid, statusBaru, bayar.tagihan_id);
    })();
    audit(req, 'batal', 'pembayaran', bayar.id, `${bayar.nomor_tagihan}: ${alasan}`);
    req.flash('success', 'Pembayaran dibatalkan dan status tagihan diperbarui.');
  } catch (err) {
    req.flash('error', `Gagal membatalkan pembayaran: ${err.message}`);
  }
  return res.redirect(`/tagihan/${bayar.tagihan_id}`);
});

// ---------------------------------------------------------------------------
// KWITANSI
// ---------------------------------------------------------------------------

router.get('/kwitansi/:id', (req, res) => {
  const bayar = db.prepare(`
    SELECT b.*, u.nama AS kasir
    FROM pembayaran b LEFT JOIN users u ON u.id = b.kasir_id
    WHERE b.id = ?
  `).get(Number(req.params.id));
  if (!bayar) {
    req.flash('error', 'Kwitansi tidak ditemukan.');
    return res.redirect('/tagihan');
  }
  const tagihan = ambilTagihan(bayar.tagihan_id);
  if (!bisaAksesTagihan(req.user, tagihan.dusun_id)) {
    return res.status(403).render('error', { title: 'Akses ditolak', message: 'Kwitansi ini bukan milik dusun Anda.' });
  }
  const items = db.prepare('SELECT * FROM tagihan_item WHERE tagihan_id = ? ORDER BY urutan, id').all(tagihan.id);
  const totalDibayar = db.prepare("SELECT COALESCE(SUM(jumlah),0) AS v FROM pembayaran WHERE tagihan_id = ? AND status = 'valid'")
    .get(tagihan.id).v;

  res.render('tagihan/kwitansi', {
    title: `Kwitansi ${bayar.nomor_kwitansi}`,
    bayar,
    tagihan,
    items,
    totalDibayar,
    desa: db.prepare('SELECT * FROM desa WHERE id = ?').get(req.user.desa_id),
  });
});

module.exports = router;
