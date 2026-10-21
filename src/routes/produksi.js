'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth, aksesSemuaDusun, dusunScope, bolehKelolaDusun } = require('../auth');
const { audit, todayISO } = require('../helpers');

const router = express.Router();
router.use(requireAuth);

function defaultBulan(desaId) {
  const p = db.prepare(`
    SELECT tahun, bulan FROM periode_tagihan p
    WHERE p.desa_id = ? AND EXISTS (SELECT 1 FROM tagihan t WHERE t.periode_id = p.id)
    ORDER BY tahun DESC, bulan DESC LIMIT 1
  `).get(desaId);
  if (p) return `${p.tahun}-${String(p.bulan).padStart(2, '0')}`;
  return todayISO().slice(0, 7);
}

router.get('/produksi', (req, res) => {
  const scope = dusunScope(req.user);
  const bulan = /^\d{4}-\d{2}$/.test(String(req.query.bulan || '')) ? req.query.bulan : defaultBulan(req.user.desa_id);
  const [tahun, bln] = bulan.split('-').map(Number);
  const filterSumur = Number(req.query.sumur) || null;

  let whereSumur = 'WHERE d.desa_id = ?';
  const paramsSumur = [req.user.desa_id];
  if (scope != null) { whereSumur += ' AND s.dusun_id = ?'; paramsSumur.push(scope); }
  if (filterSumur) { whereSumur += ' AND s.id = ?'; paramsSumur.push(filterSumur); }

  const sumurList = db.prepare(`
    SELECT s.*, d.nama AS dusun FROM sumur s JOIN dusun d ON d.id = s.dusun_id
    ${whereSumur} ORDER BY d.nama, s.kode
  `).all(...paramsSumur);

  const entries = db.prepare(`
    SELECT pr.*, s.nama AS sumur, s.kode, d.nama AS dusun
    FROM produksi_air pr
    JOIN sumur s ON s.id = pr.sumur_id
    JOIN dusun d ON d.id = s.dusun_id
    WHERE strftime('%Y-%m', pr.tanggal) = ? AND d.desa_id = ?${scope != null ? ' AND s.dusun_id = ?' : ''}${filterSumur ? ' AND pr.sumur_id = ?' : ''}
    ORDER BY pr.tanggal DESC, s.kode
  `).all(bulan, req.user.desa_id, ...(scope != null ? [scope] : []), ...(filterSumur ? [filterSumur] : []));

  const ringkas = db.prepare(`
    SELECT s.id, s.kode, s.nama, d.nama AS dusun,
           COALESCE(prod.v, 0) AS produksi,
           COALESCE(jual.v, 0) AS terjual,
           (SELECT COUNT(*) FROM pelanggan p3 WHERE p3.sumur_id = s.id AND p3.status = 'aktif') AS pelanggan
    FROM sumur s
    JOIN dusun d ON d.id = s.dusun_id
    LEFT JOIN (
      SELECT sumur_id, SUM(volume_m3) AS v FROM produksi_air
      WHERE strftime('%Y-%m', tanggal) = ? GROUP BY sumur_id
    ) prod ON prod.sumur_id = s.id
    LEFT JOIN (
      SELECT p2.sumur_id, SUM(t.pemakaian_m3) AS v
      FROM tagihan t
      JOIN pelanggan p2 ON p2.id = t.pelanggan_id
      JOIN periode_tagihan per ON per.id = t.periode_id
      WHERE per.tahun = ? AND per.bulan = ? AND t.status <> 'batal'
      GROUP BY p2.sumur_id
    ) jual ON jual.sumur_id = s.id
    ${whereSumur}
    ORDER BY d.nama, s.kode
  `).all(bulan, tahun, bln, ...paramsSumur);

  ringkas.forEach((r) => {
    r.nrw = r.produksi > 0 ? ((r.produksi - r.terjual) / r.produksi) * 100 : 0;
  });

  const totalProduksi = ringkas.reduce((a, r) => a + r.produksi, 0);
  const totalTerjual = ringkas.reduce((a, r) => a + r.terjual, 0);
  const totalNrw = totalProduksi > 0 ? ((totalProduksi - totalTerjual) / totalProduksi) * 100 : 0;

  res.render('produksi', {
    title: 'Produksi Air',
    bulan,
    entries,
    ringkas,
    sumurList,
    filterSumur,
    semua: aksesSemuaDusun(req.user),
    totalProduksi,
    totalTerjual,
    totalNrw,
  });
});

router.post('/produksi', (req, res) => {
  const sumurId = Number(req.body.sumur_id);
  const sumur = db.prepare('SELECT * FROM sumur WHERE id = ?').get(sumurId);
  if (!sumur) {
    req.flash('error', 'Sumur tidak ditemukan.');
    return res.redirect('/produksi');
  }
  if (!bolehKelolaDusun(req.user, sumur.dusun_id)) {
    req.flash('error', 'Anda tidak berhak mencatat produksi sumur ini.');
    return res.redirect('/produksi');
  }

  const tanggal = String(req.body.tanggal || '').trim() || todayISO();
  const awal = Number(req.body.meter_awal) || 0;
  const akhir = Number(req.body.meter_akhir) || 0;
  if (akhir < awal) {
    req.flash('error', 'Meter akhir tidak boleh lebih kecil dari meter awal.');
    return res.redirect('/produksi');
  }
  const volume = Math.round((akhir - awal) * 100) / 100;

  try {
    const ada = db.prepare('SELECT id FROM produksi_air WHERE sumur_id = ? AND tanggal = ?').get(sumurId, tanggal);
    if (ada) {
      db.prepare(`UPDATE produksi_air SET meter_awal=?, meter_akhir=?, volume_m3=?, jam_operasi=?, catatan=?, dicatat_oleh=?
        WHERE id=?`).run(
        awal, akhir, volume, Number(req.body.jam_operasi) || null,
        String(req.body.catatan || '').trim() || null, req.user.id, ada.id
      );
      audit(req, 'update', 'produksi_air', ada.id, `${tanggal}: ${volume} m³`);
    } else {
      const info = db.prepare(`INSERT INTO produksi_air
        (sumur_id, tanggal, meter_awal, meter_akhir, volume_m3, jam_operasi, catatan, dicatat_oleh)
        VALUES (?,?,?,?,?,?,?,?)`).run(
        sumurId, tanggal, awal, akhir, volume,
        Number(req.body.jam_operasi) || null,
        String(req.body.catatan || '').trim() || null, req.user.id
      );
      audit(req, 'create', 'produksi_air', info.lastInsertRowid, `${tanggal}: ${volume} m³`);
    }
    req.flash('success', `Produksi ${tanggal} tersimpan (${volume} m³).`);
  } catch (err) {
    req.flash('error', `Gagal menyimpan produksi: ${err.message}`);
  }
  res.redirect(`/produksi?bulan=${tanggal.slice(0, 7)}`);
});

router.post('/produksi/:id/hapus', (req, res) => {
  const row = db.prepare(`
    SELECT pr.*, s.dusun_id FROM produksi_air pr JOIN sumur s ON s.id = pr.sumur_id WHERE pr.id = ?
  `).get(Number(req.params.id));
  if (!row) {
    req.flash('error', 'Data produksi tidak ditemukan.');
    return res.redirect('/produksi');
  }
  if (!bolehKelolaDusun(req.user, row.dusun_id)) {
    return res.status(403).render('error', { title: 'Akses ditolak', message: 'Data ini bukan milik dusun Anda.' });
  }
  db.prepare('DELETE FROM produksi_air WHERE id = ?').run(row.id);
  audit(req, 'delete', 'produksi_air', row.id, row.tanggal);
  req.flash('success', 'Data produksi dihapus.');
  res.redirect(`/produksi?bulan=${String(row.tanggal).slice(0, 7)}`);
});

module.exports = router;
