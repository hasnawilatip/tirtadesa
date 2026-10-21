'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth, requireRole, aksesSemuaDusun, dusunScope, bolehKelolaDusun, ROLE_LABEL, labelPeran } = require('../auth');
const { audit } = require('../helpers');
const { hashSandi, validasiSandi } = require('../services/sandi');
const { hapusSesiPengguna } = require('../services/sesi');
const { kodeSumur, kodeDusun, kodeGolongan } = require('../services/kode');
const {
  nomorPelangganBaru, nomorMeterBaru, usernameAkunWarga, passwordAkunWarga,
} = require('../services/penomoran');
const { cekKuota } = require('../services/langganan');

const router = express.Router();
router.use(requireAuth);

function daftarDusun(user) {
  const scope = dusunScope(user);
  if (scope == null) return db.prepare('SELECT * FROM dusun WHERE desa_id = ? ORDER BY kode').all(user.desa_id);
  return db.prepare('SELECT * FROM dusun WHERE id = ? AND desa_id = ?').all(scope, user.desa_id);
}

function daftarSumur(user) {
  return db.prepare(`
    SELECT s.* FROM sumur s JOIN dusun d ON d.id = s.dusun_id
    WHERE d.desa_id = ? ORDER BY d.nama, s.kode
  `).all(user.desa_id);
}

function daftarGolongan(user) {
  return db.prepare('SELECT * FROM golongan_tarif WHERE desa_id = ? ORDER BY kode').all(user.desa_id);
}

/** Saran kode sumur untuk tiap dusun (dipakai form agar kode terisi otomatis). */
function petaKodeSumur(user) {
  const peta = {};
  daftarDusun(user).forEach((d) => { peta[d.id] = kodeSumur(d.id); });
  return peta;
}

/** Saran nomor pelanggan berikutnya untuk tiap dusun. */
function petaNomorPelanggan(user) {
  const peta = {};
  daftarDusun(user).forEach((d) => { peta[d.id] = nomorPelangganBaru(d.id); });
  return peta;
}

// ---------------------------------------------------------------------------
// DUSUN
// ---------------------------------------------------------------------------

router.get('/dusun', requireRole('admin_desa', 'superadmin'), (req, res) => {
  const rows = db.prepare(`
    SELECT d.*,
      (SELECT COUNT(*) FROM pelanggan p WHERE p.dusun_id = d.id AND p.status = 'aktif') AS pelanggan,
      (SELECT COUNT(*) FROM sumur s WHERE s.dusun_id = d.id) AS sumur
    FROM dusun d WHERE d.desa_id = ? ORDER BY d.kode
  `).all(req.user.desa_id);
  res.render('master/dusun', { title: 'Master Dusun', rows, kodeOtomatis: kodeDusun() });
});

router.post('/dusun', requireRole('admin_desa', 'superadmin'), (req, res) => {
  const nama = String(req.body.nama || '').trim();
  const kode = String(req.body.kode || '').trim().toUpperCase() || kodeDusun();
  const kepala = String(req.body.kepala_dusun || '').trim();
  if (!nama) {
    req.flash('error', 'Nama dusun wajib diisi.');
    return res.redirect('/dusun');
  }
  const kuota = cekKuota(req.user.desa_id, 'dusun');
  if (!kuota.izin) {
    req.flash('error', kuota.pesan);
    return res.redirect('/dusun');
  }
  try {
    const info = db.prepare('INSERT INTO dusun (desa_id, kode, nama, kepala_dusun) VALUES (?,?,?,?)')
      .run(req.user.desa_id, kode, nama, kepala);
    audit(req, 'create', 'dusun', info.lastInsertRowid, `${kode} - ${nama}`);
    req.flash('success', `Dusun ${nama} berhasil ditambahkan.`);
  } catch (err) {
    req.flash('error', `Gagal menambah dusun: ${err.message}`);
  }
  res.redirect('/dusun');
});

router.post('/dusun/:id', requireRole('admin_desa', 'superadmin'), (req, res) => {
  const id = Number(req.params.id);
  const nama = String(req.body.nama || '').trim();
  const kode = String(req.body.kode || '').trim().toUpperCase();
  const kepala = String(req.body.kepala_dusun || '').trim();
  const aktif = req.body.is_active ? 1 : 0;
  if (!nama) {
    req.flash('error', 'Nama dusun wajib diisi.');
    return res.redirect('/dusun');
  }
  if (kode) {
    const bentrok = db.prepare('SELECT id FROM dusun WHERE kode = ? AND id <> ?').get(kode, id);
    if (bentrok) {
      req.flash('error', `Kode ${kode} sudah dipakai dusun lain.`);
      return res.redirect('/dusun');
    }
  }
  db.prepare(`UPDATE dusun SET nama = ?, kepala_dusun = ?, is_active = ?,
    kode = COALESCE(NULLIF(?, ''), kode) WHERE id = ? AND desa_id = ?`)
    .run(nama, kepala, aktif, kode, id, req.user.desa_id);
  audit(req, 'update', 'dusun', id, nama);
  req.flash('success', 'Data dusun diperbarui.');
  res.redirect('/dusun');
});

// ---------------------------------------------------------------------------
// SUMUR
// ---------------------------------------------------------------------------

router.get('/sumur', (req, res) => {
  const scope = dusunScope(req.user);
  const q = String(req.query.q || '').trim();
  const filterDusun = Number(req.query.dusun) || null;

  let where = 'WHERE d.desa_id = ?';
  const params = [req.user.desa_id];
  if (scope != null) { where += ' AND s.dusun_id = ?'; params.push(scope); }
  if (filterDusun) { where += ' AND s.dusun_id = ?'; params.push(filterDusun); }
  if (q) { where += ' AND (s.nama LIKE ? OR s.kode LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }

  const rows = db.prepare(`
    SELECT s.*, d.nama AS dusun,
      (SELECT COUNT(*) FROM pelanggan p WHERE p.sumur_id = s.id AND p.status = 'aktif') AS pelanggan
    FROM sumur s JOIN dusun d ON d.id = s.dusun_id
    ${where}
    ORDER BY d.nama, s.kode
  `).all(...params);

  res.render('master/sumur', {
    title: 'Sumur Bor',
    rows,
    dusunList: daftarDusun(req.user),
    kodePerDusun: petaKodeSumur(req.user),
    filters: { q, dusun: filterDusun },
  });
});

router.get('/sumur/baru', requireRole('admin_desa', 'admin_dusun'), (req, res) => {
  res.render('master/sumur-form', {
    title: 'Tambah Sumur',
    row: null,
    dusunList: daftarDusun(req.user),
    kodePerDusun: petaKodeSumur(req.user),
  });
});

router.post('/sumur', requireRole('admin_desa', 'admin_dusun'), (req, res) => {
  const dusunId = Number(req.body.dusun_id);
  if (!bolehKelolaDusun(req.user, dusunId)) {
    req.flash('error', 'Anda tidak berhak menambah sumur di dusun tersebut.');
    return res.redirect('/sumur');
  }
  const kode = String(req.body.kode || '').trim() || kodeSumur(dusunId);
  const nama = String(req.body.nama || '').trim();
  if (!nama) {
    req.flash('error', 'Nama sumur wajib diisi.');
    return res.redirect('/sumur/baru');
  }
  const kuota = cekKuota(req.user.desa_id, 'sumur');
  if (!kuota.izin) {
    req.flash('error', kuota.pesan);
    return res.redirect('/sumur');
  }
  try {
    const info = db.prepare(`
      INSERT INTO sumur (dusun_id, kode, nama, alamat, kapasitas_lps, tahun_bor,
        nomor_meter_induk, status, catatan)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(
      dusunId, kode, nama,
      String(req.body.alamat || '').trim() || null,
      Number(req.body.kapasitas_lps) || null,
      Number(req.body.tahun_bor) || null,
      String(req.body.nomor_meter_induk || '').trim() || null,
      ['aktif', 'perbaikan', 'nonaktif'].includes(req.body.status) ? req.body.status : 'aktif',
      String(req.body.catatan || '').trim() || null
    );
    audit(req, 'create', 'sumur', info.lastInsertRowid, `${kode} - ${nama}`);
    req.flash('success', 'Sumur bor berhasil ditambahkan.');
    res.redirect('/sumur');
  } catch (err) {
    req.flash('error', `Gagal menyimpan sumur: ${err.message}`);
    res.redirect('/sumur/baru');
  }
});

router.get('/sumur/:id/edit', requireRole('admin_desa', 'admin_dusun'), (req, res) => {
  const row = db.prepare('SELECT * FROM sumur WHERE id = ?').get(Number(req.params.id));
  if (!row) {
    req.flash('error', 'Sumur tidak ditemukan.');
    return res.redirect('/sumur');
  }
  if (!bolehKelolaDusun(req.user, row.dusun_id)) {
    return res.status(403).render('error', { title: 'Akses ditolak', message: 'Sumur ini bukan milik dusun Anda.' });
  }
  return res.render('master/sumur-form', {
    title: `Edit Sumur ${row.kode}`,
    row,
    dusunList: daftarDusun(req.user),
  });
});

router.post('/sumur/:id', requireRole('admin_desa', 'admin_dusun'), (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM sumur WHERE id = ?').get(id);
  if (!row) {
    req.flash('error', 'Sumur tidak ditemukan.');
    return res.redirect('/sumur');
  }
  if (!bolehKelolaDusun(req.user, row.dusun_id)) {
    return res.status(403).render('error', { title: 'Akses ditolak', message: 'Sumur ini bukan milik dusun Anda.' });
  }
  const dusunId = aksesSemuaDusun(req.user) ? Number(req.body.dusun_id) : row.dusun_id;
  if (!bolehKelolaDusun(req.user, dusunId)) {
    req.flash('error', 'Dusun tujuan tidak valid.');
    return res.redirect(`/sumur/${id}/edit`);
  }
  try {
    db.prepare(`
      UPDATE sumur SET dusun_id=?, kode=?, nama=?, alamat=?, kapasitas_lps=?, tahun_bor=?,
        nomor_meter_induk=?, status=?, catatan=? WHERE id=?
    `).run(
      dusunId,
      String(req.body.kode || '').trim(),
      String(req.body.nama || '').trim(),
      String(req.body.alamat || '').trim() || null,
      Number(req.body.kapasitas_lps) || null,
      Number(req.body.tahun_bor) || null,
      String(req.body.nomor_meter_induk || '').trim() || null,
      ['aktif', 'perbaikan', 'nonaktif'].includes(req.body.status) ? req.body.status : 'aktif',
      String(req.body.catatan || '').trim() || null,
      id
    );
    audit(req, 'update', 'sumur', id, req.body.nama);
    req.flash('success', 'Data sumur diperbarui.');
    res.redirect('/sumur');
  } catch (err) {
    req.flash('error', `Gagal memperbarui sumur: ${err.message}`);
    res.redirect(`/sumur/${id}/edit`);
  }
});

// ---------------------------------------------------------------------------
// PELANGGAN
// ---------------------------------------------------------------------------

router.get('/pelanggan', (req, res) => {
  const scope = dusunScope(req.user);
  const q = String(req.query.q || '').trim();
  const filterDusun = Number(req.query.dusun) || null;
  const filterSumur = Number(req.query.sumur) || null;
  const filterStatus = String(req.query.status || '').trim();
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = 40;

  let where = 'WHERE p.desa_id = ?';
  const params = [req.user.desa_id];
  if (scope != null) { where += ' AND p.dusun_id = ?'; params.push(scope); }
  if (filterDusun) { where += ' AND p.dusun_id = ?'; params.push(filterDusun); }
  if (filterSumur) { where += ' AND p.sumur_id = ?'; params.push(filterSumur); }
  if (filterStatus) { where += ' AND p.status = ?'; params.push(filterStatus); }
  if (q) {
    where += ` AND (p.nama LIKE ? OR p.nomor_pelanggan LIKE ? OR m.nomor_meter LIKE ?
      OR m.nomor_seri LIKE ?)`;
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }

  const total = db.prepare(`
    SELECT COUNT(*) AS n FROM pelanggan p
    LEFT JOIN sambungan m ON m.pelanggan_id = p.id AND m.status = 'aktif'
    ${where}
  `).get(...params).n;

  const rows = db.prepare(`
    SELECT p.*, d.nama AS dusun, s.nama AS sumur,
           g.nama AS golongan, m.nomor_meter, m.nomor_seri, m.merk AS meter_merk,
           wa.username AS akun_username, wa.is_active AS akun_aktif
    FROM pelanggan p
    JOIN dusun d ON d.id = p.dusun_id
    LEFT JOIN sumur s ON s.id = p.sumur_id
    LEFT JOIN golongan_tarif g ON g.id = p.golongan_id
    LEFT JOIN sambungan m ON m.pelanggan_id = p.id AND m.status = 'aktif'
    LEFT JOIN users wa ON wa.pelanggan_id = p.id AND wa.role = 'warga'
    ${where}
    ORDER BY p.nomor_pelanggan
    LIMIT ? OFFSET ?
  `).all(...params, perPage, (page - 1) * perPage);

  res.render('master/pelanggan', {
    title: 'Pelanggan',
    rows,
    total,
    page,
    perPage,
    totalPages: Math.max(1, Math.ceil(total / perPage)),
    dusunList: daftarDusun(req.user),
    sumurList: daftarSumur(req.user),
    golonganList: daftarGolongan(req.user),
    filters: { q, dusun: filterDusun, sumur: filterSumur, status: filterStatus },
  });
});

function formPelanggan(req, res, row) {
  res.render('master/pelanggan-form', {
    title: row ? `Edit ${row.nomor_pelanggan}` : 'Tambah Pelanggan',
    row,
    dusunList: daftarDusun(req.user),
    sumurList: daftarSumur(req.user),
    golonganList: daftarGolongan(req.user),
    nomorPerDusun: petaNomorPelanggan(req.user),
    nomorMeterOtomatis: nomorMeterBaru(),
    meter: row
      ? db.prepare("SELECT nomor_meter, ukuran_inch FROM sambungan WHERE pelanggan_id = ? AND status = 'aktif'").get(row.id)
      : null,
  });
}

router.get('/pelanggan/baru', (req, res) => {
  req.flash('info', 'Pelanggan baru didaftarkan lewat menu Pasang Baru agar perhitungan bahan dan persetujuan admin tercatat.');
  res.redirect('/pasang?buka=modalPasang');
});

// Jalur lama penambahan pelanggan langsung dialihkan ke alur pendaftaran pasang baru.
router.post('/pelanggan', (req, res) => {
  req.flash('info', 'Gunakan menu Pasang Baru untuk menambahkan pelanggan: petugas mengisi data & bahan, admin menyetujui.');
  res.redirect('/pasang?buka=modalPasang');
});

// Buat akun warga langsung dari daftar pelanggan.
router.post('/pelanggan/:id/akun', requireRole('admin_desa', 'admin_dusun'), (req, res) => {
  const pelanggan = db.prepare('SELECT * FROM pelanggan WHERE id = ? AND desa_id = ?')
    .get(Number(req.params.id), req.user.desa_id);
  if (!pelanggan) {
    req.flash('error', 'Pelanggan tidak ditemukan.');
    return res.redirect('/pelanggan');
  }
  if (!bolehKelolaDusun(req.user, pelanggan.dusun_id)) {
    return res.status(403).render('error', {
      title: 'Akses ditolak',
      message: 'Pelanggan ini bukan milik dusun Anda.',
    });
  }
  if (db.prepare('SELECT id FROM users WHERE pelanggan_id = ?').get(pelanggan.id)) {
    req.flash('error', 'Pelanggan ini sudah memiliki akun warga.');
    return res.redirect('/pelanggan');
  }

  const username = String(req.body.username || '').trim().toLowerCase()
    || usernameAkunWarga(pelanggan.nomor_pelanggan);
  const password = String(req.body.password || '').trim() || passwordAkunWarga();
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    req.flash('error', 'Username hanya huruf kecil, angka, titik, garis bawah/strip (3–32 karakter).');
    return res.redirect('/pelanggan');
  }
  const salahSandi = validasiSandi(password, { username, nama: pelanggan.nama });
  if (salahSandi) {
    req.flash('error', salahSandi);
    return res.redirect('/pelanggan');
  }
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
    req.flash('error', 'Username tidak tersedia. Pilih username lain.');
    return res.redirect('/pelanggan');
  }

  try {
    const info = db.prepare(`INSERT INTO users
      (desa_id, dusun_id, pelanggan_id, nama, username, password_hash, role, must_change_password)
      VALUES (?,?,?,?,?,?, 'warga', 1)`).run(
      pelanggan.desa_id, pelanggan.dusun_id, pelanggan.id, pelanggan.nama,
      username, hashSandi(password)
    );
    audit(req, 'create', 'users', info.lastInsertRowid, `${username} (warga) untuk ${pelanggan.nomor_pelanggan}`);
    req.flash('success', `Akun warga untuk ${pelanggan.nama} dibuat — username: ${username}, kata sandi sementara: ${password}. Warga wajib menggantinya saat masuk pertama.`);
  } catch (err) {
    console.error('Gagal membuat akun warga:', err.message);
    req.flash('error', 'Gagal membuat akun warga. Periksa kembali data yang diisi.');
  }
  res.redirect('/pelanggan');
});

router.get('/pelanggan/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare(`
    SELECT p.*, d.nama AS dusun, d.kode AS dusun_kode, s.nama AS sumur,
           g.nama AS golongan, g.kode AS golongan_kode
    FROM pelanggan p
    JOIN dusun d ON d.id = p.dusun_id
    LEFT JOIN sumur s ON s.id = p.sumur_id
    LEFT JOIN golongan_tarif g ON g.id = p.golongan_id
    WHERE p.id = ?
  `).get(id);
  if (!row) {
    req.flash('error', 'Pelanggan tidak ditemukan.');
    return res.redirect('/pelanggan');
  }
  if (!bolehKelolaDusun(req.user, row.dusun_id) && req.user.role !== 'kasir') {
    return res.status(403).render('error', { title: 'Akses ditolak', message: 'Pelanggan ini bukan milik dusun Anda.' });
  }
  if (req.user.role === 'kasir' && Number(row.desa_id) !== Number(req.user.desa_id)) {
    return res.status(403).render('error', { title: 'Akses ditolak', message: 'Pelanggan ini bukan milik pengelola Anda.' });
  }

  const meter = db.prepare("SELECT * FROM sambungan WHERE pelanggan_id = ? AND status = 'aktif'").get(id);
  const riwayatMeter = db.prepare(`
    SELECT * FROM sambungan WHERE pelanggan_id = ?
    ORDER BY CASE status WHEN 'aktif' THEN 0 ELSE 1 END, id DESC
  `).all(id);
  const tagihan = db.prepare(`
    SELECT t.*, per.tahun, per.bulan
    FROM tagihan t JOIN periode_tagihan per ON per.id = t.periode_id
    WHERE t.pelanggan_id = ? ORDER BY per.tahun DESC, per.bulan DESC
  `).all(id);
  const pembacaan = db.prepare(`
    SELECT b.*, per.tahun, per.bulan
    FROM pembacaan_meter b JOIN periode_tagihan per ON per.id = b.periode_id
    WHERE b.pelanggan_id = ? ORDER BY per.tahun DESC, per.bulan DESC LIMIT 12
  `).all(id);
  const pembayaran = db.prepare(`
    SELECT b.* FROM pembayaran b JOIN tagihan t ON t.id = b.tagihan_id
    WHERE t.pelanggan_id = ? ORDER BY b.tanggal_bayar DESC, b.id DESC
  `).all(id);

  const totalTagihan = tagihan.reduce((a, t) => a + t.total, 0);
  const totalBayar = tagihan.reduce((a, t) => a + t.terbayar, 0);

  res.render('master/pelanggan-detail', {
    title: row.nama,
    row,
    meter,
    riwayatMeter,
    tagihan,
    pembacaan,
    pembayaran,
    totalTagihan,
    totalBayar,
  });
});

// Ganti meter: meter lama dicatat sebagai 'diganti', meter baru dipasang.
router.post('/pelanggan/:id/ganti-meter', requireRole('admin_desa', 'admin_dusun'), (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM pelanggan WHERE id = ? AND desa_id = ?').get(id, req.user.desa_id);
  if (!row) {
    req.flash('error', 'Pelanggan tidak ditemukan.');
    return res.redirect('/pelanggan');
  }
  if (!bolehKelolaDusun(req.user, row.dusun_id)) {
    return res.status(403).render('error', {
      title: 'Akses ditolak',
      message: 'Pelanggan ini bukan milik dusun Anda.',
    });
  }

  const lama = db.prepare("SELECT * FROM sambungan WHERE pelanggan_id = ? AND status = 'aktif'").get(id);
  const nomorSeri = String(req.body.nomor_seri || '').trim();
  if (!nomorSeri) {
    req.flash('error', 'Nomor seri meter baru wajib diisi.');
    return res.redirect(`/pelanggan/${id}`);
  }
  const tanggalPasang = String(req.body.tanggal_pasang || '').trim() || new Date().toISOString().slice(0, 10);
  const alasan = String(req.body.alasan || '').trim() || 'Penggantian meter';

  try {
    const nomorBaru = nomorMeterBaru();
    db.transaction(() => {
      if (lama) {
        db.prepare(`UPDATE sambungan SET status = 'diganti', tanggal_lepas = ?, alasan_ganti = ?
          WHERE id = ?`).run(tanggalPasang, alasan, lama.id);
      }
      db.prepare(`INSERT INTO sambungan
        (pelanggan_id, nomor_meter, nomor_seri, merk, tipe, ukuran_inch, status, tanggal_pasang)
        VALUES (?,?,?,?,?,?, 'aktif', ?)`).run(
        id, nomorBaru, nomorSeri,
        String(req.body.merk || '').trim() || null,
        String(req.body.tipe || '').trim() || null,
        Number(req.body.ukuran_inch) || (lama ? lama.ukuran_inch : 0.5),
        tanggalPasang
      );
    })();
    audit(req, 'update', 'sambungan', id, `Ganti meter: ${lama ? lama.nomor_meter : '-'} → ${nomorBaru} (SN ${nomorSeri})`);
    req.flash('success', `Meter diganti. Nomor meter baru: ${nomorBaru} (SN ${nomorSeri}).`);
  } catch (err) {
    req.flash('error', `Gagal mengganti meter: ${err.message}`);
  }
  res.redirect(`/pelanggan/${id}`);
});

router.get('/pelanggan/:id/edit', (req, res) => {
  const row = db.prepare('SELECT * FROM pelanggan WHERE id = ?').get(Number(req.params.id));
  if (!row) {
    req.flash('error', 'Pelanggan tidak ditemukan.');
    return res.redirect('/pelanggan');
  }
  if (!bolehKelolaDusun(req.user, row.dusun_id)) {
    return res.status(403).render('error', { title: 'Akses ditolak', message: 'Pelanggan ini bukan milik dusun Anda.' });
  }
  return formPelanggan(req, res, row);
});

router.post('/pelanggan/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM pelanggan WHERE id = ?').get(id);
  if (!row) {
    req.flash('error', 'Pelanggan tidak ditemukan.');
    return res.redirect('/pelanggan');
  }
  if (!bolehKelolaDusun(req.user, row.dusun_id)) {
    return res.status(403).render('error', { title: 'Akses ditolak', message: 'Pelanggan ini bukan milik dusun Anda.' });
  }
  const sumurId = Number(req.body.sumur_id) || null;
  const golonganId = Number(req.body.golongan_id) || null;
  if (!req.body.nama || !golonganId) {
    req.flash('error', 'Nama dan golongan wajib diisi.');
    return res.redirect(`/pelanggan/${id}/edit`);
  }
  if (sumurId) {
    const sumur = db.prepare('SELECT * FROM sumur WHERE id = ?').get(sumurId);
    if (!sumur || sumur.dusun_id !== row.dusun_id) {
      req.flash('error', 'Sumur yang dipilih bukan milik dusun pelanggan ini.');
      return res.redirect(`/pelanggan/${id}/edit`);
    }
  }

  // Mengaktifkan kembali pelanggan menambah pemakaian kuota paket, jadi ikut diperiksa
  // agar batas paket tidak bisa dilewati lewat nonaktif → tambah → aktifkan lagi.
  const statusBaru = req.body.status === 'nonaktif' ? 'nonaktif' : 'aktif';
  if (row.status === 'nonaktif' && statusBaru === 'aktif') {
    const kuota = cekKuota(req.user.desa_id, 'pelanggan');
    if (!kuota.izin) {
      req.flash('error', kuota.pesan);
      return res.redirect(`/pelanggan/${id}/edit`);
    }
  }
  try {
    db.transaction(() => {
      db.prepare(`
        UPDATE pelanggan SET sumur_id=?, golongan_id=?, nama=?, nik=?, alamat=?, rt=?, rw=?,
          telepon=?, status=?, tanggal_daftar=? WHERE id=?
      `).run(
        sumurId, golonganId, String(req.body.nama).trim(),
        String(req.body.nik || '').trim() || null,
        String(req.body.alamat || '').trim() || null,
        String(req.body.rt || '').trim() || null,
        String(req.body.rw || '').trim() || null,
        String(req.body.telepon || '').trim() || null,
        statusBaru,
        String(req.body.tanggal_daftar || '').trim() || row.tanggal_daftar,
        id
      );
      const meterBaru = String(req.body.nomor_meter || '').trim();
      const seriBaru = String(req.body.nomor_seri || '').trim() || null;
      const merkBaru = String(req.body.merk || '').trim() || null;
      const tipeBaru = String(req.body.tipe || '').trim() || null;
      if (meterBaru) {
        const aktif = db.prepare("SELECT * FROM sambungan WHERE pelanggan_id = ? AND status = 'aktif'").get(id);
        if (aktif) {
          db.prepare(`UPDATE sambungan SET nomor_meter = ?, nomor_seri = ?, merk = ?, tipe = ?,
            ukuran_inch = ? WHERE id = ?`)
            .run(meterBaru, seriBaru, merkBaru, tipeBaru, Number(req.body.ukuran_inch) || aktif.ukuran_inch, aktif.id);
        } else {
          db.prepare(`INSERT INTO sambungan
            (pelanggan_id, nomor_meter, nomor_seri, merk, tipe, ukuran_inch, status, tanggal_pasang)
            VALUES (?,?,?,?,?,?, 'aktif', date('now','localtime'))`)
            .run(id, meterBaru, seriBaru, merkBaru, tipeBaru, Number(req.body.ukuran_inch) || 0.5);
        }
      }
    })();
    audit(req, 'update', 'pelanggan', id, req.body.nama);
    req.flash('success', 'Data pelanggan diperbarui.');
    res.redirect(`/pelanggan/${id}`);
  } catch (err) {
    req.flash('error', `Gagal memperbarui pelanggan: ${err.message}`);
    res.redirect(`/pelanggan/${id}/edit`);
  }
});

// ---------------------------------------------------------------------------
// TARIF
// ---------------------------------------------------------------------------

router.get('/tarif', (req, res) => {
  const golongan = db.prepare('SELECT * FROM golongan_tarif WHERE desa_id = ? ORDER BY kode').all(req.user.desa_id);
  const blok = db.prepare(`
    SELECT tb.* FROM tarif_blok tb
    JOIN golongan_tarif g ON g.id = tb.golongan_id
    WHERE g.desa_id = ?
    ORDER BY tb.golongan_id, tb.blok_ke, tb.berlaku_mulai
  `).all(req.user.desa_id);
  const blokByGolongan = {};
  blok.forEach((b) => {
    if (!blokByGolongan[b.golongan_id]) blokByGolongan[b.golongan_id] = [];
    blokByGolongan[b.golongan_id].push(b);
  });
  res.render('master/tarif', {
    title: 'Golongan & Tarif',
    golongan,
    blokByGolongan,
    kodeOtomatis: kodeGolongan(req.user.desa_id),
    adminDesa: aksesSemuaDusun(req.user),
  });
});

router.post('/tarif/golongan', requireRole('admin_desa', 'superadmin'), (req, res) => {
  const kode = String(req.body.kode || '').trim().toUpperCase() || kodeGolongan(req.user.desa_id);
  const nama = String(req.body.nama || '').trim();
  if (!nama) {
    req.flash('error', 'Nama golongan wajib diisi.');
    return res.redirect('/tarif');
  }
  try {
    const info = db.prepare(`INSERT INTO golongan_tarif
      (desa_id, kode, nama, abonemen, min_pemakaian_m3, denda_persen, denda_maks_persen)
      VALUES (?,?,?,?,?,?,?)`).run(
      req.user.desa_id, kode, nama,
      Number(req.body.abonemen) || 0,
      Number(req.body.min_pemakaian_m3) || 0,
      Number(req.body.denda_persen) || 0,
      Number(req.body.denda_maks_persen) || 0
    );
    audit(req, 'create', 'golongan_tarif', info.lastInsertRowid, `${kode} - ${nama}`);
    req.flash('success', 'Golongan tarif ditambahkan.');
  } catch (err) {
    req.flash('error', `Gagal menambah golongan: ${err.message}`);
  }
  res.redirect('/tarif');
});

router.post('/tarif/golongan/:id', requireRole('admin_desa', 'superadmin'), (req, res) => {
  const id = Number(req.params.id);
  const milik = db.prepare('SELECT 1 FROM golongan_tarif WHERE id = ? AND desa_id = ?').get(id, req.user.desa_id);
  if (!milik) {
    req.flash('error', 'Golongan tarif tidak ditemukan.');
    return res.redirect('/tarif');
  }
  db.prepare(`UPDATE golongan_tarif SET nama=?, abonemen=?, min_pemakaian_m3=?,
    denda_persen=?, denda_maks_persen=? WHERE id=?`).run(
    String(req.body.nama || '').trim(),
    Number(req.body.abonemen) || 0,
    Number(req.body.min_pemakaian_m3) || 0,
    Number(req.body.denda_persen) || 0,
    Number(req.body.denda_maks_persen) || 0,
    id
  );
  audit(req, 'update', 'golongan_tarif', id, req.body.nama);
  req.flash('success', 'Golongan tarif diperbarui.');
  res.redirect('/tarif');
});

router.post('/tarif/blok', requireRole('admin_desa', 'superadmin'), (req, res) => {
  const golonganId = Number(req.body.golongan_id);
  const blokKe = Number(req.body.blok_ke);
  const dari = Number(req.body.dari_m3) || 0;
  const sampai = req.body.sampai_m3 === '' ? null : Number(req.body.sampai_m3);
  const harga = Number(req.body.harga_per_m3) || 0;
  const berlaku = String(req.body.berlaku_mulai || '').trim() || new Date().toISOString().slice(0, 10);

  if (!golonganId || !blokKe || harga <= 0) {
    req.flash('error', 'Golongan, blok, dan harga wajib diisi dengan benar.');
    return res.redirect('/tarif');
  }
  const milik = db.prepare('SELECT 1 FROM golongan_tarif WHERE id = ? AND desa_id = ?').get(golonganId, req.user.desa_id);
  if (!milik) {
    req.flash('error', 'Golongan tarif tidak ditemukan.');
    return res.redirect('/tarif');
  }
  try {
    const ada = db.prepare('SELECT id FROM tarif_blok WHERE golongan_id=? AND blok_ke=? AND berlaku_mulai=?')
      .get(golonganId, blokKe, berlaku);
    if (ada) {
      db.prepare('UPDATE tarif_blok SET dari_m3=?, sampai_m3=?, harga_per_m3=? WHERE id=?')
        .run(dari, sampai, harga, ada.id);
      audit(req, 'update', 'tarif_blok', ada.id, `Blok ${blokKe} = ${harga}`);
    } else {
      const info = db.prepare(`INSERT INTO tarif_blok
        (golongan_id, blok_ke, dari_m3, sampai_m3, harga_per_m3, berlaku_mulai)
        VALUES (?,?,?,?,?,?)`).run(golonganId, blokKe, dari, sampai, harga, berlaku);
      audit(req, 'create', 'tarif_blok', info.lastInsertRowid, `Blok ${blokKe} = ${harga}`);
    }
    req.flash('success', 'Blok tarif disimpan.');
  } catch (err) {
    req.flash('error', `Gagal menyimpan blok tarif: ${err.message}`);
  }
  res.redirect('/tarif');
});

router.post('/tarif/blok/:id/delete', requireRole('admin_desa', 'superadmin'), (req, res) => {
  const id = Number(req.params.id);
  const milik = db.prepare(`SELECT tb.id FROM tarif_blok tb
    JOIN golongan_tarif g ON g.id = tb.golongan_id
    WHERE tb.id = ? AND g.desa_id = ?`).get(id, req.user.desa_id);
  if (!milik) {
    req.flash('error', 'Blok tarif tidak ditemukan.');
    return res.redirect('/tarif');
  }
  db.prepare('DELETE FROM tarif_blok WHERE id = ?').run(id);
  audit(req, 'delete', 'tarif_blok', id, null);
  req.flash('success', 'Blok tarif dihapus.');
  res.redirect('/tarif');
});

// ---------------------------------------------------------------------------
// PENGGUNA
// ---------------------------------------------------------------------------

// Akun admin (pengelola) dikelola superadmin.
const ROLE_ADMIN = ['superadmin', 'admin_desa', 'admin_dusun'];
// Akun staf dikelola admin masing-masing pengelola.
const ROLE_STAF_DESA = ['petugas_catat', 'kasir', 'warga'];
const ROLE_STAF_DUSUN = ['petugas_catat', 'warga'];
const ROLE_TERIKAT_DUSUN = ['admin_dusun', 'petugas_catat', 'warga'];

function roleYangBolehDibuat(user) {
  if (user.role === 'superadmin') return ROLE_ADMIN;
  if (user.role === 'admin_desa') return ROLE_STAF_DESA;
  if (user.role === 'admin_dusun') return ROLE_STAF_DUSUN;
  return [];
}

/** Daftar akun sesuai cakupan: superadmin = admin saja, admin = staf sendiri. */
function daftarPengguna(user, tingkat = 'pengelola') {
  const dasar = `SELECT u.*, d.nama AS dusun, p.nama AS pelanggan_nama, p.nomor_pelanggan,
      ds.nama AS desa_nama, ds.jenis AS desa_jenis
    FROM users u
    LEFT JOIN dusun d ON d.id = u.dusun_id
    LEFT JOIN pelanggan p ON p.id = u.pelanggan_id
    LEFT JOIN desa ds ON ds.id = u.desa_id`;

  if (user.role === 'superadmin') {
    // Bawaan: hanya superadmin & admin pengelola (admin desa). Akun di bawahnya
    // (admin dusun, kasir, petugas, warga) tidak ditampilkan di daftar utama.
    const petaPeran = {
      pengelola: ['superadmin', 'admin_desa'],
      dusun: ['admin_dusun'],
      semua: ['superadmin', 'admin_desa', 'admin_dusun'],
    };
    const peran = petaPeran[tingkat] || petaPeran.pengelola;
    const tanda = peran.map(() => '?').join(',');
    return db.prepare(`${dasar}
      WHERE u.role IN (${tanda})
      ORDER BY CASE u.role WHEN 'superadmin' THEN 0 WHEN 'admin_desa' THEN 1 ELSE 2 END, u.nama`).all(...peran);
  }
  if (user.role === 'admin_desa') {
    return db.prepare(`${dasar}
      WHERE u.role IN ('petugas_catat','kasir','warga') AND u.desa_id = ?
      ORDER BY CASE u.role WHEN 'kasir' THEN 0 WHEN 'petugas_catat' THEN 1 ELSE 2 END, u.nama`).all(user.desa_id);
  }
  return db.prepare(`${dasar}
    WHERE u.role IN ('petugas_catat','warga') AND u.dusun_id = ?
    ORDER BY CASE u.role WHEN 'petugas_catat' THEN 0 ELSE 1 END, u.nama`).all(user.dusun_id);
}

/**
 * Superadmin hanya mengelola akun admin.
 * Admin desa mengelola staf desa; admin dusun mengelola staf dusunnya sendiri.
 * Akun sendiri hanya boleh diubah pada aksi tertentu (mis. reset password sendiri).
 */
function bolehKelolaAkun(user, target, { diriSendiri = false } = {}) {
  if (target.id === user.id) return diriSendiri;
  // Superadmin boleh mengelola akun admin lintas pengelola.
  if (user.role === 'superadmin') return ROLE_ADMIN.includes(target.role);
  if (Number(target.desa_id) !== Number(user.desa_id)) return false;
  if (user.role === 'admin_desa') return ROLE_STAF_DESA.includes(target.role);
  if (user.role === 'admin_dusun') {
    return ROLE_STAF_DUSUN.includes(target.role) && Number(target.dusun_id) === Number(user.dusun_id);
  }
  return false;
}

router.get('/pengguna', requireRole('superadmin', 'admin_desa', 'admin_dusun'), (req, res) => {
  const adminDusun = req.user.role === 'admin_dusun';
  const superadmin = req.user.role === 'superadmin';
  const tingkatSah = ['pengelola', 'dusun', 'semua'];
  const tingkat = superadmin && tingkatSah.includes(req.query.tingkat) ? req.query.tingkat : 'pengelola';
  const rows = daftarPengguna(req.user, tingkat).map((u) => ({
    ...u,
    role_label: labelPeran(u, { jenis: u.desa_jenis }),
  }));
  res.render('master/pengguna', {
    title: 'Pengguna',
    rows,
    tingkat,
    jumlahAdminDusun: superadmin
      ? db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin_dusun'").get().n
      : 0,
    desa: db.prepare('SELECT * FROM desa WHERE id = ?').get(req.user.desa_id),
    roleOptions: roleYangBolehDibuat(req.user),
    isSuperadmin: superadmin,
    adminDusun,
    dusunList: adminDusun
      ? db.prepare('SELECT * FROM dusun WHERE id = ?').all(req.user.dusun_id)
      : db.prepare('SELECT * FROM dusun WHERE desa_id = ? ORDER BY kode').all(req.user.desa_id),
    pelangganList: adminDusun
      ? db.prepare(`SELECT id, nama, nomor_pelanggan FROM pelanggan
          WHERE desa_id = ? AND dusun_id = ? AND status = 'aktif' ORDER BY nomor_pelanggan`).all(req.user.desa_id, req.user.dusun_id)
      : db.prepare(`SELECT id, nama, nomor_pelanggan FROM pelanggan
          WHERE desa_id = ? AND status = 'aktif' ORDER BY nomor_pelanggan`).all(req.user.desa_id),
    // Superadmin dapat mengubah peran & dusun akun admin lintas pengelola.
    semuaDusun: superadmin
      ? db.prepare('SELECT id, desa_id, kode, nama FROM dusun ORDER BY desa_id, kode').all()
      : [],
  });
});

router.post('/pengguna', requireRole('superadmin', 'admin_desa', 'admin_dusun'), (req, res) => {
  const nama = String(req.body.nama || '').trim();
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const role = String(req.body.role || '');
  let dusunId = Number(req.body.dusun_id) || null;
  const desa = db.prepare('SELECT id FROM desa WHERE id = ?').get(req.user.desa_id);

  if (!nama || !username || !password) {
    req.flash('error', 'Nama, username, dan kata sandi wajib diisi.');
    return res.redirect('/pengguna');
  }
  const salahSandi = validasiSandi(password, { username, nama });
  if (salahSandi) {
    req.flash('error', salahSandi);
    return res.redirect('/pengguna');
  }
  if (!roleYangBolehDibuat(req.user).includes(role)) {
    req.flash('error', 'Anda tidak berhak mendaftarkan akun dengan peran tersebut.');
    return res.redirect('/pengguna');
  }

  // Admin dusun hanya boleh mendaftarkan staf di dusunnya sendiri.
  if (req.user.role === 'admin_dusun') dusunId = req.user.dusun_id;

  // Akun warga wajib ditautkan ke satu pelanggan.
  let pelangganId = null;
  if (role === 'warga') {
    pelangganId = Number(req.body.pelanggan_id) || null;
    if (!pelangganId) {
      req.flash('error', 'Pilih pelanggan yang akan memakai akun warga ini.');
      return res.redirect('/pengguna');
    }
    const pelanggan = db.prepare('SELECT id, dusun_id FROM pelanggan WHERE id = ? AND desa_id = ?')
      .get(pelangganId, req.user.desa_id);
    if (!pelanggan) {
      req.flash('error', 'Pelanggan yang dipilih tidak ditemukan.');
      return res.redirect('/pengguna');
    }
    if (req.user.role === 'admin_dusun' && Number(pelanggan.dusun_id) !== Number(req.user.dusun_id)) {
      req.flash('error', 'Pelanggan tersebut bukan warga dusun Anda.');
      return res.redirect('/pengguna');
    }
    const sudah = db.prepare('SELECT id, username FROM users WHERE pelanggan_id = ?').get(pelangganId);
    if (sudah) {
      req.flash('error', `Pelanggan ini sudah memiliki akun warga (${sudah.username}).`);
      return res.redirect('/pengguna');
    }
    dusunId = pelanggan.dusun_id;
  }

  if (ROLE_TERIKAT_DUSUN.includes(role)) {
    if (!dusunId) {
      req.flash('error', `Peran ${ROLE_LABEL[role]} wajib terhubung ke dusun.`);
      return res.redirect('/pengguna');
    }
    const dusun = db.prepare('SELECT id FROM dusun WHERE id = ? AND is_active = 1 AND desa_id = ?')
      .get(dusunId, req.user.desa_id);
    if (!dusun) {
      req.flash('error', 'Dusun yang dipilih tidak ditemukan atau nonaktif.');
      return res.redirect('/pengguna');
    }
  } else {
    dusunId = null;
  }

  try {
    const info = db.prepare(`INSERT INTO users (desa_id, dusun_id, pelanggan_id, nama, username, password_hash, role, must_change_password)
      VALUES (?,?,?,?,?,?,?, 1)`).run(
      desa ? desa.id : 1, dusunId, pelangganId, nama, username, hashSandi(password), role
    );
    audit(req, 'create', 'users', info.lastInsertRowid, `${username} (${role})`);
    req.flash('success', `Akun ${nama} (${ROLE_LABEL[role]}) berhasil didaftarkan. Kata sandi sementara wajib diganti saat masuk pertama.`);
  } catch (err) {
    console.error('Gagal mendaftarkan pengguna:', err.message);
    req.flash('error', 'Gagal mendaftarkan pengguna. Periksa kembali data yang diisi.');
  }
  res.redirect('/pengguna');
});

/**
 * Superadmin memperbaiki data akun admin: nama, username, peran, dan dusun.
 * Akun staf (petugas/kasir/warga) tetap dikelola admin pengelola masing-masing.
 */
router.post('/pengguna/:id/ubah', requireRole('superadmin'), (req, res) => {
  const id = Number(req.params.id);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const tingkat = ['pengelola', 'dusun', 'semua'].includes(req.body.tingkat) ? req.body.tingkat : 'semua';
  const kembali = `/pengguna?tingkat=${tingkat}`;

  if (!target) {
    req.flash('error', 'Pengguna tidak ditemukan.');
    return res.redirect(kembali);
  }
  if (!ROLE_ADMIN.includes(target.role)) {
    req.flash('error', 'Hanya akun admin yang dapat diubah dari panel superadmin.');
    return res.redirect(kembali);
  }

  const nama = String(req.body.nama || '').trim();
  const username = String(req.body.username || '').trim().toLowerCase();
  const role = String(req.body.role || '').trim();

  if (!nama || !username) {
    req.flash('error', 'Nama dan username wajib diisi.');
    return res.redirect(kembali);
  }
  if (!/^[a-z0-9][a-z0-9._-]{2,29}$/.test(username)) {
    req.flash('error', 'Username hanya boleh huruf kecil, angka, titik, garis bawah, atau strip (3–30 karakter).');
    return res.redirect(kembali);
  }
  if (!ROLE_ADMIN.includes(role)) {
    req.flash('error', 'Peran akun tidak valid.');
    return res.redirect(kembali);
  }
  if (db.prepare('SELECT 1 FROM users WHERE username = ? AND id <> ?').get(username, target.id)) {
    req.flash('error', `Username ${username} sudah dipakai akun lain.`);
    return res.redirect(kembali);
  }

  // Jangan sampai superadmin menurunkan peran akunnya sendiri dan terkunci.
  if (target.id === req.user.id && role !== 'superadmin') {
    req.flash('error', 'Anda tidak dapat menurunkan peran akun sendiri.');
    return res.redirect(kembali);
  }
  if (target.role === 'superadmin' && role !== 'superadmin') {
    const aktif = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'superadmin' AND is_active = 1").get().n;
    if (aktif <= 1) {
      req.flash('error', 'Superadmin aktif terakhir tidak boleh diturunkan perannya.');
      return res.redirect(kembali);
    }
  }

  let dusunId = null;
  if (role === 'admin_dusun') {
    dusunId = Number(req.body.dusun_id) || null;
    if (!dusunId) {
      req.flash('error', 'Admin dusun wajib dihubungkan ke salah satu dusun pada ruang kerjanya.');
      return res.redirect(kembali);
    }
    const dusun = db.prepare('SELECT id FROM dusun WHERE id = ? AND desa_id = ?').get(dusunId, target.desa_id);
    if (!dusun) {
      req.flash('error', 'Dusun yang dipilih bukan milik ruang kerja akun ini.');
      return res.redirect(kembali);
    }
  }

  try {
    db.prepare('UPDATE users SET nama = ?, username = ?, role = ?, dusun_id = ? WHERE id = ?')
      .run(nama, username, role, dusunId, target.id);
    // Paksa login ulang bila akun lain diubah agar sesi lama tidak memakai peran lama.
    if (target.id !== req.user.id) hapusSesiPengguna(target.id);
    audit(req, 'update', 'users', target.id,
      `Ubah akun ${target.username} → ${username} (${target.role} → ${role})`);
    req.flash('success', `Akun ${nama} diperbarui (${ROLE_LABEL[role]}).`);
  } catch (err) {
    console.error('Gagal mengubah pengguna:', err.message);
    req.flash('error', 'Gagal mengubah akun. Periksa kembali data yang diisi.');
  }
  res.redirect(kembali);
});

router.post('/pengguna/:id/toggle', requireRole('superadmin', 'admin_desa', 'admin_dusun'), (req, res) => {
  const id = Number(req.params.id);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) {
    req.flash('error', 'Pengguna tidak ditemukan.');
    return res.redirect('/pengguna');
  }
  if (!bolehKelolaAkun(req.user, target)) {
    req.flash('error', 'Anda tidak berhak mengubah status akun ini.');
    return res.redirect('/pengguna');
  }
  if (target.is_active && target.role === 'superadmin') {
    const aktif = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'superadmin' AND is_active = 1").get().n;
    if (aktif <= 1) {
      req.flash('error', 'Superadmin aktif terakhir tidak boleh dinonaktifkan.');
      return res.redirect('/pengguna');
    }
  }
  db.prepare('UPDATE users SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END WHERE id = ?').run(id);
  if (target.is_active) hapusSesiPengguna(id);
  audit(req, 'update', 'users', id, `Ubah status aktif (${target.username})`);
  req.flash('success', `Status akun ${target.nama} diubah.`);
  res.redirect('/pengguna');
});

router.post('/pengguna/:id/password', requireRole('superadmin', 'admin_desa', 'admin_dusun'), (req, res) => {
  const id = Number(req.params.id);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) {
    req.flash('error', 'Pengguna tidak ditemukan.');
    return res.redirect('/pengguna');
  }
  if (!bolehKelolaAkun(req.user, target, { diriSendiri: true })) {
    req.flash('error', 'Anda tidak berhak mereset password akun ini.');
    return res.redirect('/pengguna');
  }
  const password = String(req.body.password || '');
  const salahSandi = validasiSandi(password, { username: target.username, nama: target.nama });
  if (salahSandi) {
    req.flash('error', salahSandi);
    return res.redirect('/pengguna');
  }
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?')
    .run(hashSandi(password), id);
  hapusSesiPengguna(id);
  audit(req, 'update', 'users', id, `Reset password (${target.username}); sesi lama diakhiri`);
  req.flash('success', `Password akun ${target.nama} diperbarui.`);
  res.redirect('/pengguna');
});

module.exports = router;
