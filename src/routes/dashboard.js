'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth, aksesSemuaDusun, dusunScope } = require('../auth');
const { audit } = require('../helpers');
const { pastikanPeriodeBerjalan } = require('../services/periode');
const { infoLangganan } = require('../services/langganan');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  // Akun warga (pelanggan) punya beranda sendiri.
  if (req.user.role === 'warga') return res.redirect('/warga');
  const semua = aksesSemuaDusun(req.user);
  const scope = dusunScope(req.user);
  const desaId = req.user.desa_id;
  // Periode bulan berjalan otomatis dibuat saat pengelola masuk.
  if (['admin_desa', 'admin_dusun'].includes(req.user.role)) {
    const auto = pastikanPeriodeBerjalan(desaId);
    if (auto.dibuat) audit(req, 'create', 'periode_tagihan', auto.periode.id, 'otomatis (bulan baru)');
  }
  const whereDusun = scope ? ' AND dusun_id = ?' : '';
  const params = scope ? [scope] : [];

  const pelangganAktif = db.prepare(
    `SELECT COUNT(*) AS n FROM pelanggan WHERE status = 'aktif' AND desa_id = ?${whereDusun}`
  ).get(desaId, ...params).n;

  const sumurAktif = db.prepare(`
    SELECT COUNT(*) AS n FROM sumur s JOIN dusun d ON d.id = s.dusun_id
    WHERE s.status = 'aktif' AND d.desa_id = ?${scope ? ' AND s.dusun_id = ?' : ''}
  `).get(desaId, ...params).n;

  const periodeBerjalan = db.prepare(`
    SELECT * FROM periode_tagihan
    WHERE desa_id = ? AND status <> 'tutup'
    ORDER BY tahun DESC, bulan DESC LIMIT 1
  `).get(desaId);

  const periodeKeuangan = db.prepare(`
    SELECT p.* FROM periode_tagihan p
    WHERE p.desa_id = ?
      AND EXISTS (SELECT 1 FROM tagihan t WHERE t.periode_id = p.id)
    ORDER BY p.tahun DESC, p.bulan DESC LIMIT 1
  `).get(desaId);

  const ringkas = { jumlah: 0, total: 0, terbayar: 0, sisa: 0 };
  if (periodeKeuangan) {
    const r = db.prepare(`
      SELECT COUNT(*) AS jumlah,
             COALESCE(SUM(total), 0) AS total,
             COALESCE(SUM(terbayar), 0) AS terbayar,
             COALESCE(SUM(CASE WHEN status = 'batal' THEN 0 ELSE total - terbayar END), 0) AS sisa
      FROM tagihan WHERE periode_id = ?${whereDusun}
    `).get(periodeKeuangan.id, ...params);
    Object.assign(ringkas, r);
  }

  const tunggakan = db.prepare(`
    SELECT COALESCE(SUM(total - terbayar), 0) AS total, COUNT(*) AS jumlah
    FROM tagihan
    WHERE status IN ('belum_bayar','sebagian','tunggakan')${whereDusun}
      AND dusun_id IN (SELECT id FROM dusun WHERE desa_id = ?)
  `).get(...params, desaId);

  let baca = { total: pelangganAktif, terbaca: 0, final: 0 };
  if (periodeBerjalan) {
    const r = db.prepare(`
      SELECT COUNT(*) AS terbaca,
             SUM(CASE WHEN b.status = 'final' THEN 1 ELSE 0 END) AS final
      FROM pembacaan_meter b
      JOIN pelanggan p ON p.id = b.pelanggan_id
      WHERE b.periode_id = ? AND p.desa_id = ?${scope ? ' AND p.dusun_id = ?' : ''}
    `).get(periodeBerjalan.id, desaId, ...params);
    baca = { total: pelangganAktif, terbaca: r.terbaca || 0, final: r.final || 0 };
  }
  const progressBaca = baca.total > 0 ? Math.round((baca.terbaca / baca.total) * 100) : 0;

  let produksi = 0;
  let terjual = 0;
  let nrw = 0;
  if (periodeKeuangan) {
    const ym = `${periodeKeuangan.tahun}-${String(periodeKeuangan.bulan).padStart(2, '0')}`;
    produksi = db.prepare(`
      SELECT COALESCE(SUM(pr.volume_m3), 0) AS v
      FROM produksi_air pr
      JOIN sumur s ON s.id = pr.sumur_id
      JOIN dusun d ON d.id = s.dusun_id
      WHERE strftime('%Y-%m', pr.tanggal) = ? AND d.desa_id = ?${scope ? ' AND s.dusun_id = ?' : ''}
    `).get(ym, desaId, ...params).v;

    terjual = db.prepare(`
      SELECT COALESCE(SUM(pemakaian_m3), 0) AS v
      FROM tagihan WHERE periode_id = ? AND status <> 'batal'${whereDusun}
    `).get(periodeKeuangan.id, ...params).v;

    if (produksi > 0) nrw = ((produksi - terjual) / produksi) * 100;
  }

  const keluhanTerbuka = db.prepare(`
    SELECT COUNT(*) AS n FROM keluhan
    WHERE status IN ('baru','diproses')${scope ? ' AND dusun_id = ?' : ''}
      AND dusun_id IN (SELECT id FROM dusun WHERE desa_id = ?)
  `).get(...params, desaId).n;

  const rekapDusun = db.prepare(`
    SELECT d.id, d.nama,
           COUNT(t.id) AS jumlah,
           COALESCE(SUM(t.total), 0) AS total,
           COALESCE(SUM(t.terbayar), 0) AS terbayar,
           COALESCE(SUM(t.pemakaian_m3), 0) AS m3
    FROM dusun d
    LEFT JOIN tagihan t ON t.dusun_id = d.id AND t.periode_id = ?
    WHERE d.desa_id = ?${scope ? ' AND d.id = ?' : ''}
    GROUP BY d.id, d.nama
    ORDER BY d.nama
  `).all(periodeKeuangan ? periodeKeuangan.id : 0, desaId, ...(scope ? [scope] : []));

  const pembayaranTerbaru = db.prepare(`
    SELECT b.id, b.nomor_kwitansi, b.tanggal_bayar, b.jumlah, b.metode,
           t.nomor_tagihan, p.nama
    FROM pembayaran b
    JOIN tagihan t ON t.id = b.tagihan_id
    JOIN pelanggan p ON p.id = t.pelanggan_id
    JOIN dusun d ON d.id = t.dusun_id
    WHERE b.status = 'valid' AND d.desa_id = ?${scope ? ' AND t.dusun_id = ?' : ''}
    ORDER BY b.tanggal_bayar DESC, b.id DESC
    LIMIT 6
  `).all(desaId, ...params);

  const tunggakanTeratas = db.prepare(`
    SELECT t.id, t.nomor_tagihan, t.total, t.terbayar, (t.total - t.terbayar) AS sisa,
           t.jatuh_tempo, p.nama, d.nama AS dusun
    FROM tagihan t
    JOIN pelanggan p ON p.id = t.pelanggan_id
    JOIN dusun d ON d.id = t.dusun_id
    WHERE t.status IN ('belum_bayar','sebagian','tunggakan')${scope ? ' AND t.dusun_id = ?' : ''}
      AND d.desa_id = ?
    ORDER BY sisa DESC
    LIMIT 6
  `).all(...params, desaId);

  res.render('dashboard', {
    title: 'Dashboard',
    pelangganAktif,
    sumurAktif,
    periodeBerjalan,
    periodeKeuangan,
    ringkas,
    tunggakan,
    baca,
    progressBaca,
    produksi,
    terjual,
    nrw,
    keluhanTerbuka,
    rekapDusun,
    pembayaranTerbaru,
    tunggakanTeratas,
    semua,
    langganan: req.user.role === 'superadmin' ? null : infoLangganan(desaId),
  });
});

module.exports = router;
