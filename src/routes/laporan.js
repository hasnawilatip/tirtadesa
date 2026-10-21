'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth, dusunScope } = require('../auth');
const { todayISO } = require('../helpers');

const router = express.Router();
router.use(requireAuth);

function periodeTerpilih(req) {
  const desaId = req.user.desa_id;
  const id = Number(req.query.periode) || null;
  if (id) {
    return db.prepare('SELECT * FROM periode_tagihan WHERE id = ? AND desa_id = ?').get(id, desaId);
  }
  return db.prepare(`
    SELECT p.* FROM periode_tagihan p
    WHERE p.desa_id = ? AND EXISTS (SELECT 1 FROM tagihan t WHERE t.periode_id = p.id)
    ORDER BY p.tahun DESC, p.bulan DESC LIMIT 1
  `).get(desaId) || db.prepare('SELECT * FROM periode_tagihan WHERE desa_id = ? ORDER BY tahun DESC, bulan DESC LIMIT 1').get(desaId);
}

function agingBucket(jatuhTempo) {
  if (!jatuhTempo) return 'belum';
  const hari = Math.floor((new Date(`${todayISO()}T00:00:00`) - new Date(`${jatuhTempo}T00:00:00`)) / 86400000);
  if (hari <= 0) return 'belum';
  if (hari <= 90) return '0_3';
  if (hari <= 180) return '4_6';
  return 'lebih_6';
}

function ambilTunggakan(scope, desaId) {
  const rows = db.prepare(`
    SELECT t.id, t.nomor_tagihan, t.total, t.terbayar, (t.total - t.terbayar) AS sisa,
           t.jatuh_tempo, p.nama, p.nomor_pelanggan, d.nama AS dusun,
           per.tahun, per.bulan
    FROM tagihan t
    JOIN pelanggan p ON p.id = t.pelanggan_id
    JOIN dusun d ON d.id = t.dusun_id
    JOIN periode_tagihan per ON per.id = t.periode_id
    WHERE t.status IN ('belum_bayar','sebagian','tunggakan')
      AND d.desa_id = ?
      ${scope != null ? 'AND t.dusun_id = ?' : ''}
    ORDER BY t.jatuh_tempo ASC, p.nama
  `).all(desaId, ...(scope != null ? [scope] : []));

  rows.forEach((r) => {
    r.hari = r.jatuh_tempo
      ? Math.max(0, Math.floor((new Date(`${todayISO()}T00:00:00`) - new Date(`${r.jatuh_tempo}T00:00:00`)) / 86400000))
      : 0;
    r.bucket = agingBucket(r.jatuh_tempo);
  });
  return rows;
}

function ringkasanAging(rows) {
  const map = { belum: 0, '0_3': 0, '4_6': 0, lebih_6: 0 };
  rows.forEach((r) => { map[r.bucket] += r.sisa; });
  return map;
}

router.get('/laporan', (req, res) => {
  const scope = dusunScope(req.user);
  const periode = periodeTerpilih(req);
  const periodeList = db.prepare('SELECT * FROM periode_tagihan WHERE desa_id = ? ORDER BY tahun DESC, bulan DESC').all(req.user.desa_id);

  if (!periode) {
    return res.render('laporan', {
      title: 'Laporan',
      periodeList,
      periode: null,
      rekapDusun: [],
      totals: { jumlah: 0, m3: 0, total: 0, terbayar: 0, sisa: 0 },
      tunggakan: [],
      aging: { belum: 0, '0_3': 0, '4_6': 0, lebih_6: 0 },
      nrw: [],
      kasMetode: [],
      kasKasir: [],
      totalKas: 0,
      pembelianBulan: [],
      totalPembelian: 0,
      gajiBulan: [],
      totalGaji: 0,
      totalProduksi: 0,
      totalTerjual: 0,
      totalNrw: 0,
    });
  }

  const ym = `${periode.tahun}-${String(periode.bulan).padStart(2, '0')}`;

  const rekapDusun = db.prepare(`
    SELECT d.id, d.nama,
           COUNT(t.id) AS jumlah,
           COALESCE(SUM(t.pemakaian_m3), 0) AS m3,
           COALESCE(SUM(t.total), 0) AS total,
           COALESCE(SUM(t.terbayar), 0) AS terbayar,
           COALESCE(SUM(CASE WHEN t.status = 'batal' THEN 0 ELSE t.total - t.terbayar END), 0) AS sisa
    FROM dusun d
    LEFT JOIN tagihan t ON t.dusun_id = d.id AND t.periode_id = ?
    WHERE d.desa_id = ?${scope != null ? ' AND d.id = ?' : ''}
    GROUP BY d.id, d.nama
    ORDER BY d.nama
  `).all(periode.id, req.user.desa_id, ...(scope != null ? [scope] : []));

  const totals = rekapDusun.reduce((a, r) => ({
    jumlah: a.jumlah + r.jumlah,
    m3: a.m3 + r.m3,
    total: a.total + r.total,
    terbayar: a.terbayar + r.terbayar,
    sisa: a.sisa + r.sisa,
  }), { jumlah: 0, m3: 0, total: 0, terbayar: 0, sisa: 0 });

  const tunggakan = ambilTunggakan(scope, req.user.desa_id);
  const aging = ringkasanAging(tunggakan);

  const nrw = db.prepare(`
    SELECT s.id, s.kode, s.nama, d.nama AS dusun,
           COALESCE(prod.v, 0) AS produksi,
           COALESCE(jual.v, 0) AS terjual
    FROM sumur s
    JOIN dusun d ON d.id = s.dusun_id
    LEFT JOIN (
      SELECT sumur_id, SUM(volume_m3) AS v FROM produksi_air
      WHERE strftime('%Y-%m', tanggal) = ? GROUP BY sumur_id
    ) prod ON prod.sumur_id = s.id
    LEFT JOIN (
      SELECT p2.sumur_id, SUM(t.pemakaian_m3) AS v
      FROM tagihan t JOIN pelanggan p2 ON p2.id = t.pelanggan_id
      WHERE t.periode_id = ? AND t.status <> 'batal'
      GROUP BY p2.sumur_id
    ) jual ON jual.sumur_id = s.id
    WHERE 1=1 AND d.desa_id = ?${scope != null ? ' AND s.dusun_id = ?' : ''}
    ORDER BY d.nama, s.kode
  `).all(ym, periode.id, req.user.desa_id, ...(scope != null ? [scope] : []));

  nrw.forEach((r) => {
    r.nrw = r.produksi > 0 ? ((r.produksi - r.terjual) / r.produksi) * 100 : 0;
  });
  const totalProduksi = nrw.reduce((a, r) => a + r.produksi, 0);
  const totalTerjual = nrw.reduce((a, r) => a + r.terjual, 0);
  const totalNrw = totalProduksi > 0 ? ((totalProduksi - totalTerjual) / totalProduksi) * 100 : 0;

  const kasMetode = db.prepare(`
    SELECT b.metode, COUNT(*) AS n, COALESCE(SUM(b.jumlah), 0) AS total
    FROM pembayaran b JOIN tagihan t ON t.id = b.tagihan_id
    JOIN dusun d ON d.id = t.dusun_id
    WHERE b.status = 'valid' AND strftime('%Y-%m', b.tanggal_bayar) = ? AND d.desa_id = ?
      ${scope != null ? 'AND t.dusun_id = ?' : ''}
    GROUP BY b.metode ORDER BY total DESC
  `).all(ym, req.user.desa_id, ...(scope != null ? [scope] : []));

  const kasKasir = db.prepare(`
    SELECT COALESCE(u.nama, 'Tidak diketahui') AS kasir, COUNT(*) AS n, COALESCE(SUM(b.jumlah), 0) AS total
    FROM pembayaran b
    JOIN tagihan t ON t.id = b.tagihan_id
    JOIN dusun d ON d.id = t.dusun_id
    LEFT JOIN users u ON u.id = b.kasir_id
    WHERE b.status = 'valid' AND strftime('%Y-%m', b.tanggal_bayar) = ? AND d.desa_id = ?
      ${scope != null ? 'AND t.dusun_id = ?' : ''}
    GROUP BY u.id, u.nama ORDER BY total DESC
  `).all(ym, req.user.desa_id, ...(scope != null ? [scope] : []));

  const totalKas = kasMetode.reduce((a, r) => a + r.total, 0);

  // Pengeluaran pembelian bahan bulan ini (nota yang sudah diterima).
  const pembelianBulan = db.prepare(`
    SELECT p.id, p.nomor, p.tanggal, p.supplier, p.metode, p.total
    FROM pembelian p
    WHERE p.desa_id = ? AND p.status = 'diterima' AND substr(p.tanggal, 1, 7) = ?
    ORDER BY p.tanggal DESC, p.id DESC
  `).all(req.user.desa_id, ym);
  const totalPembelian = pembelianBulan.reduce((a, p) => a + p.total, 0);

  // Pengeluaran gaji karyawan yang sudah dibayar pada periode ini.
  const gajiBulan = db.prepare(`
    SELECT p.id, p.nomor, k.nama, p.gaji_bersih, p.tanggal_bayar, p.metode
    FROM penggajian p
    JOIN karyawan k ON k.id = p.karyawan_id
    WHERE p.desa_id = ? AND p.tahun = ? AND p.bulan = ? AND p.status = 'dibayar'
      ${scope != null ? 'AND k.dusun_id = ?' : ''}
    ORDER BY p.tanggal_bayar, p.id
  `).all(req.user.desa_id, periode.tahun, periode.bulan, ...(scope != null ? [scope] : []));
  const totalGaji = gajiBulan.reduce((a, g) => a + Number(g.gaji_bersih || 0), 0);

  res.render('laporan', {
    title: 'Laporan',
    periodeList,
    periode,
    rekapDusun,
    totals,
    tunggakan,
    aging,
    nrw,
    kasMetode,
    kasKasir,
    totalKas,
    pembelianBulan,
    totalPembelian,
    gajiBulan,
    totalGaji,
    totalProduksi,
    totalTerjual,
    totalNrw,
  });
});

function csvNilai(v) {
  let teks = String(v == null ? '' : v);
  // Cegah formula injection saat berkas dibuka di Excel/Sheets.
  if (/^[=+\-@\t\r]/.test(teks)) teks = `'${teks}`;
  return `"${teks.replace(/"/g, '""')}"`;
}

router.get('/laporan/export.csv', (req, res) => {
  const scope = dusunScope(req.user);
  const periode = periodeTerpilih(req);
  const jenis = String(req.query.jenis || 'rekap');

  if (!periode) {
    req.flash('error', 'Belum ada periode untuk diekspor.');
    return res.redirect('/laporan');
  }

  const baris = [];
  let namaFile;

  if (jenis === 'tunggakan') {
    baris.push(['Pelanggan', 'Nomor', 'Dusun', 'Periode', 'Jatuh tempo', 'Umur (hari)', 'Sisa tagihan'].map(csvNilai).join(','));
    ambilTunggakan(scope, req.user.desa_id).forEach((r) => {
      baris.push([
        r.nama, r.nomor_pelanggan, r.dusun,
        `${r.tahun}-${String(r.bulan).padStart(2, '0')}`,
        r.jatuh_tempo || '', r.hari, Math.round(r.sisa),
      ].map(csvNilai).join(','));
    });
    namaFile = `tunggakan-${periode.tahun}-${String(periode.bulan).padStart(2, '0')}.csv`;
  } else {
    baris.push(['Dusun', 'Jumlah tagihan', 'Pemakaian m3', 'Total tagihan', 'Terbayar', 'Sisa'].map(csvNilai).join(','));
    const rekap = db.prepare(`
      SELECT d.nama, COUNT(t.id) AS jumlah, COALESCE(SUM(t.pemakaian_m3),0) AS m3,
             COALESCE(SUM(t.total),0) AS total, COALESCE(SUM(t.terbayar),0) AS terbayar
      FROM dusun d
      LEFT JOIN tagihan t ON t.dusun_id = d.id AND t.periode_id = ?
      WHERE d.desa_id = ?${scope != null ? ' AND d.id = ?' : ''}
      GROUP BY d.id, d.nama ORDER BY d.nama
    `).all(periode.id, req.user.desa_id, ...(scope != null ? [scope] : []));
    rekap.forEach((r) => {
      baris.push([r.nama, r.jumlah, r.m3, Math.round(r.total), Math.round(r.terbayar), Math.round(r.total - r.terbayar)]
        .map(csvNilai).join(','));
    });
    namaFile = `rekap-${periode.tahun}-${String(periode.bulan).padStart(2, '0')}.csv`;
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${namaFile}"`);
  return res.send(`\uFEFF${baris.join('\r\n')}`);
});

router.get('/audit', (req, res) => {
  if (!['admin_desa', 'superadmin'].includes(req.user.role)) {
    return res.status(403).render('error', {
      title: 'Akses ditolak',
      message: 'Hanya admin desa yang dapat melihat audit log.',
    });
  }
  const rows = db.prepare(`
    SELECT a.*, u.nama AS user_nama
    FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    ${req.user.role === 'superadmin' ? '' : 'WHERE u.desa_id = ?'}
    ORDER BY a.id DESC LIMIT 200
  `).all(...(req.user.role === 'superadmin' ? [] : [req.user.desa_id]));
  return res.render('audit', { title: 'Audit Log', rows });
});

module.exports = router;
