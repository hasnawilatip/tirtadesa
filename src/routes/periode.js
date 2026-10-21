'use strict';

const express = require('express');
const crypto = require('crypto');

const { db } = require('../db');
const { requireAuth, requireRole, aksesSemuaDusun, dusunScope, bolehKelolaDusun } = require('../auth');
const { audit, todayISO } = require('../helpers');
const { hitungTagihan } = require('../services/tarif');
const { pastikanPeriodeBerjalan, jatuhTempoBawaan, tanggalTerbitBawaan } = require('../services/periode');
const { buatUnggahan } = require('../services/unggah');
const csrf = require('../services/csrf');

const router = express.Router();
router.use(requireAuth);

const unggahFoto = buatUnggahan({
  folder: 'meter',
  prefix: 'meter',
  tipe: ['image/png', 'image/jpeg', 'image/webp'],
  batas: 4 * 1024 * 1024,
  pesan: 'Foto meter harus berupa gambar PNG, JPG, atau WebP (maks. 4 MB).',
});

function unggahFotoAman(req, res, next) {
  unggahFoto.single('foto')(req, res, (err) => {
    if (err) {
      req.flash('error', err.message || 'Gagal mengunggah foto meter.');
      return res.redirect('/periode');
    }
    return unggahFoto.validasi(req, res, (err2) => {
      if (err2) {
        req.flash('error', err2.message || 'Isi berkas foto meter tidak valid.');
        return res.redirect('/periode');
      }
      return next();
    });
  });
}

function getPeriode(id, desaId) {
  return db.prepare('SELECT * FROM periode_tagihan WHERE id = ? AND desa_id = ?').get(Number(id), desaId);
}

function pelangganTerbaca(periodeId, scope, desaId) {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM pembacaan_meter b
    JOIN pelanggan p ON p.id = b.pelanggan_id
    WHERE b.periode_id = ? AND p.desa_id = ?${scope != null ? ' AND p.dusun_id = ?' : ''}
  `).get(periodeId, desaId, ...(scope != null ? [scope] : [])).n;
}

function jumlahPelangganAktif(scope, desaId) {
  return db.prepare(`SELECT COUNT(*) AS n FROM pelanggan
    WHERE status = 'aktif' AND desa_id = ?${scope != null ? ' AND dusun_id = ?' : ''}`)
    .get(desaId, ...(scope != null ? [scope] : [])).n;
}

// ---------------------------------------------------------------------------
// DAFTAR PERIODE
// ---------------------------------------------------------------------------

router.get('/periode', (req, res) => {
  const scope = dusunScope(req.user);
  const desaId = req.user.desa_id;
  // Periode bulan berjalan dibuat otomatis untuk admin pengelola.
  let auto = { dibuat: false, usang: false, periode: null };
  if (['admin_desa', 'admin_dusun'].includes(req.user.role)) {
    auto = pastikanPeriodeBerjalan(desaId);
    if (auto.dibuat) {
      audit(req, 'create', 'periode_tagihan', auto.periode.id, 'otomatis (bulan baru)');
    }
  }
  const periode = db.prepare('SELECT * FROM periode_tagihan WHERE desa_id = ? ORDER BY tahun DESC, bulan DESC').all(desaId);
  const totalPelanggan = jumlahPelangganAktif(scope, desaId);

  const rows = periode.map((p) => {
    const terbaca = pelangganTerbaca(p.id, scope, desaId);
    const tagihan = db.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total FROM tagihan WHERE periode_id = ?${scope != null ? ' AND dusun_id = ?' : ''}`
    ).get(p.id, ...(scope != null ? [scope] : []));
    return { ...p, terbaca, totalPelanggan, tagihan: tagihan.n, nilai: tagihan.total };
  });

  const terakhir = periode[0];
  let berikutnya = { tahun: new Date().getFullYear(), bulan: new Date().getMonth() + 1 };
  if (terakhir) {
    berikutnya = terakhir.bulan === 12
      ? { tahun: terakhir.tahun + 1, bulan: 1 }
      : { tahun: terakhir.tahun, bulan: terakhir.bulan + 1 };
  }
  const adaTerbuka = periode.some((p) => p.status !== 'tutup');

  res.render('periode/index', {
    title: 'Periode & Baca Meter',
    rows,
    berikutnya,
    jatuhTempoBawaan: jatuhTempoBawaan(berikutnya.tahun, berikutnya.bulan),
    adaTerbuka,
    periodeDibuat: auto.dibuat ? auto.periode : null,
    periodeUsang: auto.usang ? auto.periode : null,
    semua: aksesSemuaDusun(req.user),
  });
});

router.post('/periode', requireRole('admin_desa', 'superadmin'), (req, res) => {
  const tahun = Number(req.body.tahun);
  const bulan = Number(req.body.bulan);
  const jatuhTempo = String(req.body.tanggal_jatuh_tempo || '').trim() || null;

  if (!tahun || bulan < 1 || bulan > 12) {
    req.flash('error', 'Tahun dan bulan periode tidak valid.');
    return res.redirect('/periode');
  }
  const terbuka = db.prepare("SELECT 1 FROM periode_tagihan WHERE desa_id = ? AND status <> 'tutup' LIMIT 1").get(req.user.desa_id);
  if (terbuka) {
    req.flash('error', 'Masih ada periode yang belum ditutup. Tutup periode tersebut terlebih dahulu.');
    return res.redirect('/periode');
  }
  try {
    const info = db.prepare(`INSERT INTO periode_tagihan (desa_id, tahun, bulan, tanggal_jatuh_tempo, status)
      VALUES (?,?,?,?, 'baca_meter')`).run(
      req.user.desa_id, tahun, bulan, jatuhTempo || jatuhTempoBawaan(tahun, bulan)
    );
    audit(req, 'create', 'periode_tagihan', info.lastInsertRowid, `${tahun}-${bulan}`);
    req.flash('success', 'Periode baru dibuka.');
  } catch (err) {
    req.flash('error', `Gagal membuka periode: ${err.message}`);
  }
  res.redirect('/periode');
});

router.post('/periode/:id/tutup', requireRole('admin_desa', 'superadmin'), (req, res) => {
  const periode = getPeriode(req.params.id, req.user.desa_id);
  if (!periode) {
    req.flash('error', 'Periode tidak ditemukan.');
    return res.redirect('/periode');
  }
  db.prepare("UPDATE periode_tagihan SET status = 'tutup' WHERE id = ?").run(periode.id);
  audit(req, 'update', 'periode_tagihan', periode.id, 'Tutup periode');
  req.flash('success', 'Periode ditutup. Data tidak dapat diubah lagi.');
  res.redirect('/periode');
});

// ---------------------------------------------------------------------------
// DAFTAR TUGAS BACA
// ---------------------------------------------------------------------------

router.get('/periode/:id/baca', (req, res) => {
  const periode = getPeriode(req.params.id, req.user.desa_id);
  if (!periode) {
    req.flash('error', 'Periode tidak ditemukan.');
    return res.redirect('/periode');
  }
  const scope = dusunScope(req.user);
  const q = String(req.query.q || '').trim();
  const filterDusun = Number(req.query.dusun) || null;
  const filterStatus = String(req.query.status || '').trim();

  let where = "WHERE p.status = 'aktif' AND p.desa_id = ?";
  const params = [req.user.desa_id];
  if (scope != null) { where += ' AND p.dusun_id = ?'; params.push(scope); }
  if (filterDusun) { where += ' AND p.dusun_id = ?'; params.push(filterDusun); }
  if (q) { where += ' AND (p.nama LIKE ? OR p.nomor_pelanggan LIKE ? OR m.nomor_meter LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (filterStatus === 'belum') where += ' AND b.id IS NULL';
  else if (filterStatus) { where += ' AND b.status = ?'; params.push(filterStatus); }

  const rows = db.prepare(`
    SELECT p.id, p.nomor_pelanggan, p.nama, p.alamat,
           d.nama AS dusun, s.nama AS sumur, m.nomor_meter,
           b.id AS reading_id, b.status AS reading_status, b.pemakaian_m3,
           b.kondisi_meter, b.tanggal_baca
    FROM pelanggan p
    JOIN dusun d ON d.id = p.dusun_id
    LEFT JOIN sumur s ON s.id = p.sumur_id
    JOIN sambungan m ON m.pelanggan_id = p.id AND m.status = 'aktif'
    LEFT JOIN pembacaan_meter b ON b.pelanggan_id = p.id AND b.periode_id = ?
    ${where}
    ORDER BY d.nama, p.nomor_pelanggan
  `).all(periode.id, ...params);

  const allRows = db.prepare(`
    SELECT b.status FROM pembacaan_meter b
    JOIN pelanggan p ON p.id = b.pelanggan_id
    WHERE b.periode_id = ? AND p.desa_id = ?${scope != null ? ' AND p.dusun_id = ?' : ''}
  `).all(periode.id, req.user.desa_id, ...(scope != null ? [scope] : []));
  const total = jumlahPelangganAktif(scope, req.user.desa_id);
  const terbaca = allRows.length;
  const final = allRows.filter((r) => r.status === 'final').length;
  const diajukan = allRows.filter((r) => r.status === 'diajukan').length;

  const pelangganList = db.prepare(`
    SELECT p.id, p.nomor_pelanggan, p.nama, m.nomor_meter, d.nama AS dusun
    FROM pelanggan p
    JOIN dusun d ON d.id = p.dusun_id
    LEFT JOIN sambungan m ON m.pelanggan_id = p.id AND m.status = 'aktif'
    WHERE p.status = 'aktif' AND p.desa_id = ?${scope != null ? ' AND p.dusun_id = ?' : ''}
    ORDER BY d.nama, p.nomor_pelanggan
  `).all(req.user.desa_id, ...(scope != null ? [scope] : []));

  res.render('periode/baca', {
    title: `Baca Meter · ${periode.tahun}-${String(periode.bulan).padStart(2, '0')}`,
    periode,
    rows,
    pelangganList,
    dusunList: scope == null
      ? db.prepare('SELECT * FROM dusun WHERE desa_id = ? ORDER BY kode').all(req.user.desa_id)
      : db.prepare('SELECT * FROM dusun WHERE id = ? AND desa_id = ?').all(scope, req.user.desa_id),
    filters: { q, dusun: filterDusun, status: filterStatus },
    progress: { total, terbaca, final, diajukan, persen: total ? Math.round((terbaca / total) * 100) : 0 },
  });
});
// ---------------------------------------------------------------------------
// INPUT PEMBACAAN
// ---------------------------------------------------------------------------

function dataPelangganBaca(pelangganId, desaId) {
  return db.prepare(`
    SELECT p.*, d.nama AS dusun, s.nama AS sumur, m.id AS sambungan_id, m.nomor_meter,
           g.nama AS golongan, g.min_pemakaian_m3
    FROM pelanggan p
    JOIN dusun d ON d.id = p.dusun_id
    LEFT JOIN sumur s ON s.id = p.sumur_id
    JOIN sambungan m ON m.pelanggan_id = p.id AND m.status = 'aktif'
    JOIN golongan_tarif g ON g.id = p.golongan_id
    WHERE p.id = ? AND p.desa_id = ?
  `).get(pelangganId, desaId);
}

function angkaLaluTerakhir(pelangganId, periodeId) {
  const row = db.prepare(`
    SELECT b.angka_kini FROM pembacaan_meter b
    JOIN periode_tagihan per ON per.id = b.periode_id
    WHERE b.pelanggan_id = ? AND b.periode_id <> ? AND b.status = 'final'
    ORDER BY per.tahun DESC, per.bulan DESC LIMIT 1
  `).get(pelangganId, periodeId);
  return row ? row.angka_kini : 0;
}

/** Data angka meter lalu (dipakai popup catat meter). */
router.get('/periode/:id/angka/:pelangganId', requireRole('admin_desa', 'admin_dusun', 'petugas_catat'), (req, res) => {
  const periode = getPeriode(req.params.id, req.user.desa_id);
  const pelanggan = dataPelangganBaca(Number(req.params.pelangganId), req.user.desa_id);
  if (!periode || !pelanggan) {
    return res.status(404).json({ error: 'Periode atau pelanggan tidak ditemukan.' });
  }
  if (!bolehKelolaDusun(req.user, pelanggan.dusun_id)) {
    return res.status(403).json({ error: 'Pelanggan ini bukan hak akses Anda.' });
  }
  const existing = db.prepare('SELECT * FROM pembacaan_meter WHERE periode_id = ? AND pelanggan_id = ?')
    .get(periode.id, pelanggan.id);
  const angkaLalu = existing ? existing.angka_lalu : angkaLaluTerakhir(pelanggan.id, periode.id);

  return res.json({
    pelanggan: {
      id: pelanggan.id,
      nama: pelanggan.nama,
      nomor: pelanggan.nomor_pelanggan,
      dusun: pelanggan.dusun,
      sumur: pelanggan.sumur,
      meter: pelanggan.nomor_meter,
      golongan: pelanggan.golongan,
    },
    angka_lalu: angkaLalu,
    existing: existing ? {
      status: existing.status,
      angka_kini: existing.angka_kini,
      pemakaian_m3: existing.pemakaian_m3,
      kondisi_meter: existing.kondisi_meter,
      tanggal_baca: existing.tanggal_baca,
      catatan: existing.catatan,
    } : null,
  });
});

router.get('/periode/:id/baca/:pelangganId', requireRole('admin_desa', 'admin_dusun', 'petugas_catat'), (req, res) => {
  const periode = getPeriode(req.params.id, req.user.desa_id);
  const pelanggan = dataPelangganBaca(Number(req.params.pelangganId), req.user.desa_id);
  if (!periode || !pelanggan) {
    req.flash('error', 'Periode atau pelanggan tidak ditemukan.');
    return res.redirect('/periode');
  }
  if (!bolehKelolaDusun(req.user, pelanggan.dusun_id)) {
    return res.status(403).render('error', { title: 'Akses ditolak', message: 'Pelanggan ini bukan milik dusun Anda.' });
  }
  if (periode.status === 'tutup') {
    req.flash('error', 'Periode sudah ditutup.');
    return res.redirect('/periode');
  }

  const existing = db.prepare('SELECT * FROM pembacaan_meter WHERE periode_id = ? AND pelanggan_id = ?')
    .get(periode.id, pelanggan.id);
  const angkaLalu = existing ? existing.angka_lalu : angkaLaluTerakhir(pelanggan.id, periode.id);

  res.render('periode/input', {
    title: `Baca Meter ${pelanggan.nomor_pelanggan}`,
    periode,
    pelanggan,
    existing,
    angkaLalu,
  });
});

router.post('/periode/:id/baca/:pelangganId', requireRole('admin_desa', 'admin_dusun', 'petugas_catat'), unggahFotoAman, csrf.setelahUnggah, (req, res) => {
  const periode = getPeriode(req.params.id, req.user.desa_id);
  const pelanggan = dataPelangganBaca(Number(req.params.pelangganId), req.user.desa_id);
  if (!periode || !pelanggan) {
    req.flash('error', 'Periode atau pelanggan tidak ditemukan.');
    return res.redirect('/periode');
  }
  if (!bolehKelolaDusun(req.user, pelanggan.dusun_id)) {
    return res.status(403).render('error', { title: 'Akses ditolak', message: 'Pelanggan ini bukan milik dusun Anda.' });
  }
  if (periode.status === 'tutup') {
    req.flash('error', 'Periode sudah ditutup, pembacaan tidak dapat diubah.');
    return res.redirect('/periode');
  }

  const existing = db.prepare('SELECT * FROM pembacaan_meter WHERE periode_id = ? AND pelanggan_id = ?')
    .get(periode.id, pelanggan.id);
  if (existing && existing.status === 'final' && !['admin_desa', 'superadmin'].includes(req.user.role)) {
    req.flash('error', 'Pembacaan sudah final. Minta admin desa untuk mengoreksi.');
    return res.redirect(`/periode/${periode.id}/baca`);
  }

  const kondisi = ['normal', 'rusak', 'macet', 'tidak_dihuni'].includes(req.body.kondisi_meter)
    ? req.body.kondisi_meter : 'normal';
  const angkaLalu = Number(req.body.angka_lalu) || 0;
  const angkaKini = Number(req.body.angka_kini);
  const aksi = req.body.aksi === 'draft' ? 'draft' : 'diajukan';

  if (Number.isNaN(angkaKini) || angkaKini < 0) {
    req.flash('error', 'Angka meter tidak valid.');
    return res.redirect(`/periode/${periode.id}/baca/${pelanggan.id}`);
  }
  if (kondisi === 'normal' && angkaKini < angkaLalu) {
    req.flash('error', 'Angka meter kini tidak boleh lebih kecil dari angka lalu. Tandai meter rusak/macet bila perlu.');
    return res.redirect(`/periode/${periode.id}/baca/${pelanggan.id}`);
  }

  let pemakaian;
  if (kondisi === 'rusak' || kondisi === 'macet') {
    const rata = db.prepare(`
      SELECT AVG(pemakaian_m3) AS v FROM (
        SELECT b.pemakaian_m3 FROM pembacaan_meter b
        JOIN periode_tagihan per ON per.id = b.periode_id
        WHERE b.pelanggan_id = ? AND b.periode_id <> ? AND b.status = 'final'
        ORDER BY per.tahun DESC, per.bulan DESC LIMIT 3
      )
    `).get(pelanggan.id, periode.id).v;
    pemakaian = rata != null ? Math.round(rata * 10) / 10 : pelanggan.min_pemakaian_m3;
  } else if (kondisi === 'tidak_dihuni') {
    pemakaian = 0;
  } else {
    pemakaian = Math.round((angkaKini - angkaLalu) * 100) / 100;
  }

  const fotoPath = req.file ? `/uploads/meter/${req.file.filename}` : (existing ? existing.foto_path : null);
  const tanggalBaca = String(req.body.tanggal_baca || '').trim() || todayISO();
  const catatan = String(req.body.catatan || '').trim() || null;

  try {
    if (existing) {
      db.prepare(`
        UPDATE pembacaan_meter
        SET petugas_id=?, angka_lalu=?, angka_kini=?, pemakaian_m3=?, kondisi_meter=?,
            tanggal_baca=?, catatan=?, foto_path=?, status=?, alasan_tolak=NULL,
            diverifikasi_oleh=NULL, diverifikasi_at=NULL
        WHERE id=?
      `).run(
        req.user.id, angkaLalu, angkaKini, pemakaian, kondisi, tanggalBaca, catatan,
        fotoPath, aksi, existing.id
      );
      audit(req, 'update', 'pembacaan_meter', existing.id, `${pelanggan.nomor_pelanggan} = ${pemakaian} m³`);
    } else {
      const info = db.prepare(`
        INSERT INTO pembacaan_meter
          (periode_id, pelanggan_id, sambungan_id, petugas_id, angka_lalu, angka_kini,
           pemakaian_m3, kondisi_meter, tanggal_baca, catatan, foto_path, status, client_uuid)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        periode.id, pelanggan.id, pelanggan.sambungan_id, req.user.id,
        angkaLalu, angkaKini, pemakaian, kondisi, tanggalBaca, catatan, fotoPath,
        aksi, crypto.randomUUID()
      );
      audit(req, 'create', 'pembacaan_meter', info.lastInsertRowid, `${pelanggan.nomor_pelanggan} = ${pemakaian} m³`);
    }
    req.flash('success', `Pembacaan ${pelanggan.nama} tersimpan (${pemakaian} m³).`);
  } catch (err) {
    req.flash('error', `Gagal menyimpan pembacaan: ${err.message}`);
  }
  res.redirect(`/periode/${periode.id}/baca`);
});

// ---------------------------------------------------------------------------
// VERIFIKASI
// ---------------------------------------------------------------------------

router.get('/periode/:id/verifikasi', requireRole('admin_desa', 'admin_dusun'), (req, res) => {
  const periode = getPeriode(req.params.id, req.user.desa_id);
  if (!periode) {
    req.flash('error', 'Periode tidak ditemukan.');
    return res.redirect('/periode');
  }
  const scope = dusunScope(req.user);
  const filterStatus = String(req.query.status || 'diajukan');
  const filterDusun = Number(req.query.dusun) || null;

  let where = 'WHERE d.desa_id = ?';
  const params = [req.user.desa_id];
  if (scope != null) { where += ' AND p.dusun_id = ?'; params.push(scope); }
  if (filterDusun) { where += ' AND p.dusun_id = ?'; params.push(filterDusun); }
  if (filterStatus) { where += ' AND b.status = ?'; params.push(filterStatus); }

  const rows = db.prepare(`
    SELECT b.*, p.nomor_pelanggan, p.nama, d.nama AS dusun,
           s.nama AS sumur, m.nomor_meter, u.nama AS petugas
    FROM pembacaan_meter b
    JOIN pelanggan p ON p.id = b.pelanggan_id
    JOIN dusun d ON d.id = p.dusun_id
    LEFT JOIN sumur s ON s.id = p.sumur_id
    JOIN sambungan m ON m.id = b.sambungan_id
    LEFT JOIN users u ON u.id = b.petugas_id
    ${where}
    ORDER BY d.nama, p.nomor_pelanggan
  `).all(...params);

  const counts = db.prepare(`
    SELECT b.status, COUNT(*) AS n FROM pembacaan_meter b
    JOIN pelanggan p ON p.id = b.pelanggan_id
    WHERE b.periode_id = ? AND p.desa_id = ?${scope != null ? ' AND p.dusun_id = ?' : ''}
    GROUP BY b.status
  `).all(periode.id, req.user.desa_id, ...(scope != null ? [scope] : []));

  res.render('periode/verifikasi', {
    title: `Verifikasi · ${periode.tahun}-${String(periode.bulan).padStart(2, '0')}`,
    periode,
    rows,
    counts,
    filterStatus,
    dusunList: scope == null
      ? db.prepare('SELECT * FROM dusun WHERE desa_id = ? ORDER BY kode').all(req.user.desa_id)
      : db.prepare('SELECT * FROM dusun WHERE id = ? AND desa_id = ?').all(scope, req.user.desa_id),
    filterDusun,
  });
});

router.post('/periode/:id/verifikasi/:readingId', requireRole('admin_desa', 'admin_dusun'), (req, res) => {
  const periode = getPeriode(req.params.id, req.user.desa_id);
  const reading = db.prepare(`
    SELECT b.*, p.dusun_id, p.desa_id FROM pembacaan_meter b
    JOIN pelanggan p ON p.id = b.pelanggan_id WHERE b.id = ?
  `).get(Number(req.params.readingId));

  if (!periode || !reading || reading.periode_id !== periode.id || Number(reading.desa_id) !== Number(req.user.desa_id)) {
    req.flash('error', 'Data pembacaan tidak ditemukan.');
    return res.redirect(`/periode/${req.params.id}/verifikasi`);
  }
  if (!bolehKelolaDusun(req.user, reading.dusun_id)) {
    return res.status(403).render('error', { title: 'Akses ditolak', message: 'Data ini bukan milik dusun Anda.' });
  }

  if (req.body.aksi === 'setujui') {
    db.prepare(`UPDATE pembacaan_meter SET status='final', diverifikasi_oleh=?, diverifikasi_at=datetime('now','localtime'),
      alasan_tolak=NULL WHERE id=?`).run(req.user.id, reading.id);
    audit(req, 'verifikasi', 'pembacaan_meter', reading.id, 'Disetujui');
    req.flash('success', 'Pembacaan disetujui dan final.');
  } else {
    const alasan = String(req.body.alasan || '').trim() || 'Perlu dicek ulang oleh petugas.';
    db.prepare("UPDATE pembacaan_meter SET status='ditolak', alasan_tolak=? WHERE id=?")
      .run(alasan, reading.id);
    audit(req, 'verifikasi', 'pembacaan_meter', reading.id, `Ditolak: ${alasan}`);
    req.flash('warning', 'Pembacaan ditolak dan dikembalikan ke petugas.');
  }
  res.redirect(`/periode/${periode.id}/verifikasi`);
});

// Aksi massal untuk pembacaan yang dicentang pada halaman verifikasi.
router.post('/periode/:id/verifikasi-massal', requireRole('admin_desa', 'admin_dusun'), (req, res) => {
  const periode = getPeriode(req.params.id, req.user.desa_id);
  const filterStatus = ['diajukan', 'final', 'ditolak', 'draft'].includes(String(req.body.status || ''))
    ? `?status=${req.body.status}` : '';
  const daftarKembali = `/periode/${req.params.id}/verifikasi${filterStatus}`;
  if (!periode) {
    req.flash('error', 'Periode tidak ditemukan.');
    return res.redirect('/periode');
  }
  if (periode.status === 'tutup') {
    req.flash('error', 'Periode sudah ditutup.');
    return res.redirect(daftarKembali);
  }

  const aksi = String(req.body.aksi || '');
  if (!['ajukan', 'setujui', 'tolak'].includes(aksi)) {
    req.flash('error', 'Aksi massal tidak dikenal.');
    return res.redirect(daftarKembali);
  }
  let ids = req.body.reading_ids;
  if (!Array.isArray(ids)) ids = ids ? [ids] : [];
  ids = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) {
    req.flash('error', 'Pilih minimal satu pembacaan terlebih dahulu.');
    return res.redirect(daftarKembali);
  }

  const tanda = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT b.id, b.status, p.dusun_id, p.desa_id
    FROM pembacaan_meter b
    JOIN pelanggan p ON p.id = b.pelanggan_id
    WHERE b.periode_id = ? AND b.id IN (${tanda})
  `).all(periode.id, ...ids);

  if (rows.length !== ids.length) {
    req.flash('error', 'Sebagian pembacaan tidak ditemukan pada periode ini.');
    return res.redirect(daftarKembali);
  }
  const tidakBerhak = rows.some((r) => Number(r.desa_id) !== Number(req.user.desa_id)
    || !bolehKelolaDusun(req.user, r.dusun_id));
  if (tidakBerhak) {
    return res.status(403).render('error', { title: 'Akses ditolak', message: 'Ada pembacaan yang bukan hak akses Anda.' });
  }

  const alasan = String(req.body.alasan || '').trim() || 'Perlu dicek ulang oleh petugas.';
  let berubah = 0;

  try {
    db.transaction(() => {
      for (const r of rows) {
        if (aksi === 'setujui' && ['diajukan', 'ditolak'].includes(r.status)) {
          db.prepare(`UPDATE pembacaan_meter SET status='final',
            diverifikasi_oleh=?, diverifikasi_at=datetime('now','localtime'), alasan_tolak=NULL
            WHERE id=?`).run(req.user.id, r.id);
          berubah += 1;
        } else if (aksi === 'tolak' && r.status === 'diajukan') {
          db.prepare("UPDATE pembacaan_meter SET status='ditolak', alasan_tolak=? WHERE id=?")
            .run(alasan, r.id);
          berubah += 1;
        } else if (aksi === 'ajukan' && ['draft', 'ditolak'].includes(r.status)) {
          db.prepare(`UPDATE pembacaan_meter SET status='diajukan', alasan_tolak=NULL,
            diverifikasi_oleh=NULL, diverifikasi_at=NULL WHERE id=?`).run(r.id);
          berubah += 1;
        }
      }
    })();
  } catch (err) {
    req.flash('error', `Gagal memproses aksi massal: ${err.message}`);
    return res.redirect(daftarKembali);
  }

  const label = { ajukan: 'diajukan untuk verifikasi', setujui: 'disetujui', tolak: 'ditolak' }[aksi];
  audit(req, 'verifikasi', 'pembacaan_meter', periode.id, `Massal ${aksi}: ${berubah} pembacaan`);
  if (berubah === 0) {
    req.flash('warning', 'Tidak ada pembacaan yang bisa diproses untuk aksi tersebut.');
  } else {
    req.flash('success', `${berubah} pembacaan ${label}.`);
  }
  return res.redirect(daftarKembali);
});

router.post('/periode/:id/verifikasi-semua', requireRole('admin_desa', 'admin_dusun'), (req, res) => {  const periode = getPeriode(req.params.id, req.user.desa_id);
  if (!periode) {
    req.flash('error', 'Periode tidak ditemukan.');
    return res.redirect('/periode');
  }
  const scope = dusunScope(req.user);
  const info = db.prepare(`
    UPDATE pembacaan_meter
    SET status='final', diverifikasi_oleh=?, diverifikasi_at=datetime('now','localtime')
    WHERE periode_id = ? AND status = 'diajukan'
      AND pelanggan_id IN (SELECT id FROM pelanggan WHERE desa_id = ?${scope != null ? ' AND dusun_id = ?' : ''})
  `).run(req.user.id, periode.id, req.user.desa_id, ...(scope != null ? [scope] : []));
  audit(req, 'verifikasi', 'pembacaan_meter', null, `Setujui massal ${info.changes} pembacaan`);
  req.flash('success', `${info.changes} pembacaan disetujui.`);
  res.redirect(`/periode/${periode.id}/verifikasi`);
});

// ---------------------------------------------------------------------------
// GENERATE TAGIHAN
// ---------------------------------------------------------------------------

function nomorTagihanBerikutnya(periode) {
  const prefix = `TAG/${periode.tahun}/${String(periode.bulan).padStart(2, '0')}/`;
  const row = db.prepare("SELECT nomor_tagihan FROM tagihan WHERE nomor_tagihan LIKE ? ORDER BY id DESC LIMIT 1")
    .get(`${prefix}%`);
  let seq = row ? Number(row.nomor_tagihan.slice(prefix.length)) + 1 : 1;
  let nomor = `${prefix}${String(seq).padStart(4, '0')}`;
  while (db.prepare('SELECT 1 FROM tagihan WHERE nomor_tagihan = ?').get(nomor)) {
    seq += 1;
    nomor = `${prefix}${String(seq).padStart(4, '0')}`;
  }
  return nomor;
}

router.post('/periode/:id/generate', requireRole('admin_desa', 'superadmin'), (req, res) => {
  const periode = getPeriode(req.params.id, req.user.desa_id);
  if (!periode) {
    req.flash('error', 'Periode tidak ditemukan.');
    return res.redirect('/periode');
  }
  if (periode.status === 'tutup') {
    req.flash('error', 'Periode sudah ditutup.');
    return res.redirect('/periode');
  }

  const readings = db.prepare(`
    SELECT b.*, p.golongan_id, p.dusun_id, p.status AS status_pelanggan
    FROM pembacaan_meter b
    JOIN pelanggan p ON p.id = b.pelanggan_id
    LEFT JOIN tagihan t ON t.periode_id = b.periode_id AND t.pelanggan_id = b.pelanggan_id
    WHERE b.periode_id = ? AND b.status = 'final' AND t.id IS NULL AND p.desa_id = ?
  `).all(periode.id, req.user.desa_id);

  if (!readings.length) {
    req.flash('warning', 'Tidak ada pembacaan final yang belum ditagihkan.');
    return res.redirect(`/periode/${periode.id}/verifikasi`);
  }

  const tanggalTerbit = tanggalTerbitBawaan(periode.tahun, periode.bulan);
  let dibuat = 0;

  try {
    db.transaction(() => {
      for (const r of readings) {
        if (r.status_pelanggan === 'nonaktif') continue;
        const bill = hitungTagihan(db, r.golongan_id, r.pemakaian_m3, tanggalTerbit);
        const nomor = nomorTagihanBerikutnya(periode);
        const info = db.prepare(`
          INSERT INTO tagihan
            (periode_id, pelanggan_id, sambungan_id, dusun_id, nomor_tagihan, pemakaian_m3,
             abonemen, biaya_pemakaian, total, terbayar, status, tanggal_terbit, jatuh_tempo)
          VALUES (?,?,?,?,?,?,?,?,?,0,'belum_bayar',?,?)
        `).run(
          periode.id, r.pelanggan_id, r.sambungan_id, r.dusun_id, nomor, r.pemakaian_m3,
          bill.abonemen, bill.biaya_pemakaian, bill.total, tanggalTerbit, periode.tanggal_jatuh_tempo
        );
        bill.items.forEach((it) => {
          db.prepare(`INSERT INTO tagihan_item (tagihan_id, jenis, keterangan, qty, harga_satuan, subtotal, urutan)
            VALUES (?,?,?,?,?,?,?)`).run(
            info.lastInsertRowid, it.jenis, it.keterangan, it.qty, it.harga_satuan, it.subtotal, it.urutan
          );
        });
        dibuat += 1;
      }
      db.prepare("UPDATE periode_tagihan SET status = 'tagihan_terbit' WHERE id = ?").run(periode.id);
    })();
    audit(req, 'generate', 'tagihan', periode.id, `${dibuat} tagihan diterbitkan`);
    req.flash('success', `${dibuat} tagihan berhasil diterbitkan.`);
  } catch (err) {
    req.flash('error', `Gagal menerbitkan tagihan: ${err.message}`);
    return res.redirect(`/periode/${periode.id}/verifikasi`);
  }

  return res.redirect(`/tagihan?periode=${periode.id}`);
});

module.exports = router;
