'use strict';

/**
 * Pendaftaran pasang baru (sambungan rumah).
 * Alur: petugas mendata calon pelanggan + menghitung kebutuhan pipa/bahan →
 * diajukan ke admin → admin menyetujui (stok gudang otomatis dikeluarkan) →
 * setelah pemasangan selesai, data pelanggan & meter dibuat otomatis.
 */

const express = require('express');
const { db } = require('../db');
const {
  requireAuth, requireRole, aksesSemuaDusun, dusunScope, bolehKelolaDusun,
} = require('../auth');
const { audit, todayISO } = require('../helpers');
const { nomorPendaftaranBaru, nomorPelangganBaru, nomorMeterBaru } = require('../services/penomoran');
const { cekKuota } = require('../services/langganan');

const router = express.Router();
router.use(requireAuth);

const PERAN_PENDAFTAR = ['admin_desa', 'admin_dusun', 'petugas_catat'];
const PERAN_APPROVAL = ['admin_desa', 'admin_dusun'];
const STATUS = ['draf', 'diajukan', 'disetujui', 'ditolak', 'terpasang', 'dibatalkan'];

function daftarDusun(user) {
  const scope = dusunScope(user);
  if (scope == null) return db.prepare('SELECT * FROM dusun WHERE desa_id = ? ORDER BY kode').all(user.desa_id);
  return db.prepare('SELECT * FROM dusun WHERE id = ? AND desa_id = ?').all(scope, user.desa_id);
}

function daftarSumur(user) {
  return db.prepare(`
    SELECT s.*, d.nama AS dusun_nama FROM sumur s JOIN dusun d ON d.id = s.dusun_id
    WHERE d.desa_id = ? ORDER BY d.nama, s.kode
  `).all(user.desa_id);
}

function daftarGolongan(user) {
  return db.prepare('SELECT * FROM golongan_tarif WHERE desa_id = ? ORDER BY kode').all(user.desa_id);
}

function daftarBahan(user) {
  return db.prepare(`SELECT * FROM bahan WHERE desa_id = ? AND is_active = 1
    ORDER BY CASE kategori
      WHEN 'pipa' THEN 1 WHEN 'fitting' THEN 2 WHEN 'meter' THEN 3
      WHEN 'aksesoris' THEN 4 WHEN 'alat' THEN 5 ELSE 6 END, nama`).all(user.desa_id);
}

function ambilPendaftaran(user, id) {
  return db.prepare(`SELECT p.*, d.nama AS dusun_nama, g.nama AS golongan_nama, g.kode AS golongan_kode,
      s.kode AS sumur_kode, s.nama AS sumur_nama,
      du.nama AS diajukan_nama, su.nama AS disetujui_nama
    FROM pendaftaran_pasang p
    JOIN dusun d ON d.id = p.dusun_id
    LEFT JOIN golongan_tarif g ON g.id = p.golongan_id
    LEFT JOIN sumur s ON s.id = p.sumur_id
    LEFT JOIN users du ON du.id = p.diajukan_oleh
    LEFT JOIN users su ON su.id = p.disetujui_oleh
    WHERE p.id = ? AND p.desa_id = ?`).get(Number(id), user.desa_id);
}

function bolehAkses(user, row) {
  if (!row) return false;
  if (Number(row.desa_id) !== Number(user.desa_id)) return false;
  return aksesSemuaDusun(user) || Number(row.dusun_id) === Number(user.dusun_id);
}

function bolehUbah(user, row) {
  if (!bolehAkses(user, row)) return false;
  if (!['admin_desa', 'admin_dusun', 'petugas_catat'].includes(user.role)) return false;
  if (!['draf', 'ditolak'].includes(row.status)) return false;
  if (user.role === 'admin_desa' || user.role === 'admin_dusun') return true;
  return Number(row.diajukan_oleh) === Number(user.id) || row.diajukan_oleh == null;
}

/**
 * Ambil baris bahan dari form (bahan_id[] & jumlah[]), buang yang kosong,
 * gabungkan duplikat, dan hitung subtotal berdasarkan harga gudang.
 */
function bacaRincianBahan(req, desaId) {
  const idMentah = req.body.bahan_id;
  const jumlahMentah = req.body.jumlah;
  const daftarId = Array.isArray(idMentah) ? idMentah : (idMentah ? [idMentah] : []);
  const daftarJumlah = Array.isArray(jumlahMentah) ? jumlahMentah : (jumlahMentah ? [jumlahMentah] : []);
  const gabung = new Map();
  daftarId.forEach((id, i) => {
    const bahanId = Number(id);
    if (!bahanId) return;
    const jumlah = Number(daftarJumlah[i]) || 0;
    if (jumlah <= 0) return;
    gabung.set(bahanId, (gabung.get(bahanId) || 0) + jumlah);
  });
  const hasil = [];
  const ambil = db.prepare('SELECT * FROM bahan WHERE id = ? AND desa_id = ?');
  gabung.forEach((jumlah, bahanId) => {
    const bahan = ambil.get(bahanId, desaId);
    if (!bahan) return;
    hasil.push({
      bahan_id: bahan.id,
      nama_bahan: bahan.nama,
      satuan: bahan.satuan,
      jumlah,
      harga_satuan: Number(bahan.harga_satuan) || 0,
      subtotal: jumlah * (Number(bahan.harga_satuan) || 0),
    });
  });
  return hasil;
}

function simpanRincian(pendaftaranId, rincian) {
  db.prepare('DELETE FROM pendaftaran_bahan WHERE pendaftaran_id = ?').run(pendaftaranId);
  const insert = db.prepare(`INSERT INTO pendaftaran_bahan
    (pendaftaran_id, bahan_id, nama_bahan, satuan, jumlah, harga_satuan, subtotal)
    VALUES (?,?,?,?,?,?,?)`);
  rincian.forEach((b) => {
    insert.run(pendaftaranId, b.bahan_id, b.nama_bahan, b.satuan, b.jumlah, b.harga_satuan, b.subtotal);
  });
}

function totalBahan(rincian) {
  return rincian.reduce((jumlah, b) => jumlah + b.subtotal, 0);
}

function dataForm(req) {
  return {
    dusun_id: String(req.body.dusun_id || ''),
    sumur_id: String(req.body.sumur_id || ''),
    golongan_id: String(req.body.golongan_id || ''),
    nama: String(req.body.nama || '').trim(),
    nik: String(req.body.nik || '').trim(),
    alamat: String(req.body.alamat || '').trim(),
    rt: String(req.body.rt || '').trim(),
    rw: String(req.body.rw || '').trim(),
    telepon: String(req.body.telepon || '').trim(),
    jumlah_penghuni: Number(req.body.jumlah_penghuni) || null,
    tanggal_survei: String(req.body.tanggal_survei || '').trim() || todayISO(),
    ukuran_pipa: String(req.body.ukuran_pipa || '').trim(),
    panjang_pipa: Number(req.body.panjang_pipa) || 0,
    kedalaman_tapping: req.body.kedalaman_tapping === '' || req.body.kedalaman_tapping == null
      ? null : Number(req.body.kedalaman_tapping),
    biaya_jasa: Number(req.body.biaya_jasa) || 0,
    catatan: String(req.body.catatan || '').trim(),
  };
}

function ukuranInci(ukuranPipa) {
  const teks = String(ukuranPipa || '').replace(',', '.').trim();
  if (teks.includes('/')) {
    const [a, b] = teks.split('/').map(Number);
    if (a && b) return Number((a / b).toFixed(3));
  }
  const angka = Number(teks.replace(/[^0-9.]/g, ''));
  return Number.isFinite(angka) && angka > 0 ? angka : 0.5;
}

function rincianPendaftaran(id) {
  return db.prepare('SELECT * FROM pendaftaran_bahan WHERE pendaftaran_id = ? ORDER BY id').all(id);
}

function muatForm(req, res, opsi = {}) {
  res.render('pasang/form', {
    title: opsi.row ? `Ubah ${opsi.row.nomor}` : 'Daftar Pasang Baru',
    row: opsi.row || null,
    rincian: opsi.rincian || [],
    dusunList: daftarDusun(req.user),
    sumurList: daftarSumur(req.user),
    golonganList: daftarGolongan(req.user),
    bahanList: daftarBahan(req.user),
    nomorOtomatis: opsi.nomorOtomatis || nomorPendaftaranBaru(req.user.desa_id),
  });
}

// ---------------------------------------------------------------------------
// DAFTAR
// ---------------------------------------------------------------------------

router.get('/pasang', requireRole(...PERAN_PENDAFTAR, 'kasir'), (req, res) => {
  const filters = {
    q: String(req.query.q || '').trim(),
    status: String(req.query.status || '').trim(),
    dusun: String(req.query.dusun || '').trim(),
  };
  const syarat = ['p.desa_id = ?'];
  const nilai = [req.user.desa_id];
  const scope = dusunScope(req.user);
  if (scope != null) {
    syarat.push('p.dusun_id = ?');
    nilai.push(scope);
  } else if (filters.dusun) {
    syarat.push('p.dusun_id = ?');
    nilai.push(Number(filters.dusun));
  }
  if (STATUS.includes(filters.status)) {
    syarat.push('p.status = ?');
    nilai.push(filters.status);
  }
  if (filters.q) {
    syarat.push('(p.nama LIKE ? OR p.nomor LIKE ? OR p.telepon LIKE ? OR p.alamat LIKE ?)');
    nilai.push(`%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`);
  }
  const rows = db.prepare(`
    SELECT p.*, d.nama AS dusun_nama, g.nama AS golongan_nama,
      (SELECT COUNT(*) FROM pendaftaran_bahan b WHERE b.pendaftaran_id = p.id) AS jumlah_bahan
    FROM pendaftaran_pasang p
    JOIN dusun d ON d.id = p.dusun_id
    LEFT JOIN golongan_tarif g ON g.id = p.golongan_id
    WHERE ${syarat.join(' AND ')}
    ORDER BY p.id DESC
  `).all(...nilai);

  const hitung = (status) => db.prepare(`SELECT COUNT(*) AS n FROM pendaftaran_pasang
    WHERE desa_id = ? AND status = ? ${scope != null ? 'AND dusun_id = ?' : ''}`)
    .get(...(scope != null ? [req.user.desa_id, status, scope] : [req.user.desa_id, status])).n;

  res.render('pasang/index', {
    title: 'Pendaftaran Pasang Baru',
    rows,
    filters,
    dusunList: daftarDusun(req.user),
    sumurList: daftarSumur(req.user),
    golonganList: daftarGolongan(req.user),
    bahanList: daftarBahan(req.user),
    nomorOtomatis: nomorPendaftaranBaru(req.user.desa_id),
    ringkas: {
      draf: hitung('draf'),
      diajukan: hitung('diajukan'),
      disetujui: hitung('disetujui'),
      terpasang: hitung('terpasang'),
    },
    bolehDaftar: PERAN_PENDAFTAR.includes(req.user.role),
  });
});

// ---------------------------------------------------------------------------
// FORM
// ---------------------------------------------------------------------------

router.get('/pasang/baru', requireRole(...PERAN_PENDAFTAR), (req, res) => {
  // Formulir tambah kini berupa popup di halaman daftar (konsisten dengan menu lain).
  res.redirect('/pasang?buka=modalPasang');
});

router.post('/pasang', requireRole(...PERAN_PENDAFTAR), (req, res) => {
  const data = dataForm(req);
  const dusunId = Number(data.dusun_id);
  if (!dusunId || !bolehKelolaDusun(req.user, dusunId)) {
    req.flash('error', 'Dusun tidak valid atau bukan wilayah Anda.');
    return res.redirect('/pasang?buka=modalPasang');
  }
  if (!data.nama) {
    req.flash('error', 'Nama calon pelanggan wajib diisi.');
    return res.redirect('/pasang?buka=modalPasang');
  }
  const rincian = bacaRincianBahan(req, req.user.desa_id);
  const totalBahanRincian = totalBahan(rincian);
  const diajukan = req.body.aksi === 'ajukan';
  const nomor = nomorPendaftaranBaru(req.user.desa_id);

  try {
    const id = db.transaction(() => {
      const info = db.prepare(`INSERT INTO pendaftaran_pasang
        (desa_id, nomor, dusun_id, sumur_id, golongan_id, nama, nik, alamat, rt, rw, telepon,
         jumlah_penghuni, tanggal_survei, ukuran_pipa, panjang_pipa, kedalaman_tapping, catatan,
         biaya_jasa, total_bahan, total_biaya, status, diajukan_oleh, diajukan_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        req.user.desa_id, nomor, dusunId,
        Number(data.sumur_id) || null, Number(data.golongan_id) || null,
        data.nama, data.nik || null, data.alamat || null, data.rt || null, data.rw || null,
        data.telepon || null, data.jumlah_penghuni, data.tanggal_survei, data.ukuran_pipa || null,
        data.panjang_pipa, data.kedalaman_tapping, data.catatan || null,
        data.biaya_jasa, totalBahanRincian, totalBahanRincian + data.biaya_jasa,
        diajukan ? 'diajukan' : 'draf', req.user.id, diajukan ? new Date().toISOString() : null
      );
      simpanRincian(info.lastInsertRowid, rincian);
      return info.lastInsertRowid;
    })();
    audit(req, 'create', 'pendaftaran_pasang', id, `${nomor} - ${data.nama}`);
    req.flash('success', diajukan
      ? `Pendaftaran ${nomor} diajukan ke admin untuk persetujuan.`
      : `Pendaftaran ${nomor} disimpan sebagai draf.`);
    res.redirect(`/pasang/${id}`);
  } catch (err) {
    req.flash('error', `Gagal menyimpan pendaftaran: ${err.message}`);
    res.redirect('/pasang?buka=modalPasang');
  }
});

router.get('/pasang/:id/edit', requireRole(...PERAN_PENDAFTAR), (req, res) => {
  const row = ambilPendaftaran(req.user, req.params.id);
  if (!row) {
    req.flash('error', 'Pendaftaran tidak ditemukan.');
    return res.redirect('/pasang');
  }
  if (!bolehUbah(req.user, row)) {
    req.flash('error', 'Pendaftaran ini sudah diproses dan tidak dapat diubah.');
    return res.redirect(`/pasang/${row.id}`);
  }
  muatForm(req, res, { row, rincian: rincianPendaftaran(row.id) });
});

router.post('/pasang/:id', requireRole(...PERAN_PENDAFTAR), (req, res) => {
  const row = ambilPendaftaran(req.user, req.params.id);
  if (!row) {
    req.flash('error', 'Pendaftaran tidak ditemukan.');
    return res.redirect('/pasang');
  }
  if (!bolehUbah(req.user, row)) {
    req.flash('error', 'Pendaftaran ini sudah diproses dan tidak dapat diubah.');
    return res.redirect(`/pasang/${row.id}`);
  }
  const data = dataForm(req);
  const dusunId = Number(data.dusun_id) || row.dusun_id;
  if (!bolehKelolaDusun(req.user, dusunId)) {
    req.flash('error', 'Dusun tidak valid atau bukan wilayah Anda.');
    return res.redirect(`/pasang/${row.id}/edit`);
  }
  if (!data.nama) {
    req.flash('error', 'Nama calon pelanggan wajib diisi.');
    return res.redirect(`/pasang/${row.id}/edit`);
  }
  const rincian = bacaRincianBahan(req, req.user.desa_id);
  const totalBahanRincian = totalBahan(rincian);
  const diajukan = req.body.aksi === 'ajukan';
  db.transaction(() => {
    db.prepare(`UPDATE pendaftaran_pasang SET dusun_id = ?, sumur_id = ?, golongan_id = ?,
        nama = ?, nik = ?, alamat = ?, rt = ?, rw = ?, telepon = ?, jumlah_penghuni = ?,
        tanggal_survei = ?, ukuran_pipa = ?, panjang_pipa = ?, kedalaman_tapping = ?, catatan = ?,
        biaya_jasa = ?, total_bahan = ?, total_biaya = ?, status = ?,
        diajukan_oleh = COALESCE(diajukan_oleh, ?), diajukan_at = CASE WHEN ? = 'diajukan'
          THEN COALESCE(diajukan_at, datetime('now','localtime')) ELSE diajukan_at END
      WHERE id = ?`).run(
      dusunId, Number(data.sumur_id) || null, Number(data.golongan_id) || null,
      data.nama, data.nik || null, data.alamat || null, data.rt || null, data.rw || null,
      data.telepon || null, data.jumlah_penghuni, data.tanggal_survei, data.ukuran_pipa || null,
      data.panjang_pipa, data.kedalaman_tapping, data.catatan || null,
      data.biaya_jasa, totalBahanRincian, totalBahanRincian + data.biaya_jasa,
      diajukan ? 'diajukan' : 'draf', req.user.id, diajukan ? 'diajukan' : row.status, row.id
    );
    simpanRincian(row.id, rincian);
  })();
  audit(req, 'update', 'pendaftaran_pasang', row.id, `${row.nomor} - ${data.nama}`);
  req.flash('success', diajukan
    ? `Pendaftaran ${row.nomor} diperbarui dan diajukan ke admin.`
    : `Pendaftaran ${row.nomor} diperbarui.`);
  res.redirect(`/pasang/${row.id}`);
});

// ---------------------------------------------------------------------------
// DETAIL & AKSI
// ---------------------------------------------------------------------------

router.get('/pasang/:id', requireRole(...PERAN_PENDAFTAR, 'kasir'), (req, res) => {
  const row = ambilPendaftaran(req.user, req.params.id);
  if (!bolehAkses(req.user, row)) {
    return res.status(403).render('error', {
      title: 'Akses ditolak',
      message: 'Pendaftaran ini bukan milik wilayah Anda.',
    });
  }
  const rincian = rincianPendaftaran(row.id);
  const riwayat = db.prepare(`
    SELECT m.*, u.nama AS pengguna, b.nama AS bahan_nama, b.satuan
    FROM bahan_mutasi m
    JOIN bahan b ON b.id = m.bahan_id
    LEFT JOIN users u ON u.id = m.user_id
    WHERE m.referensi = ? ORDER BY m.id
  `).all(row.nomor);
  const pelanggan = row.pelanggan_id
    ? db.prepare('SELECT * FROM pelanggan WHERE id = ?').get(row.pelanggan_id)
    : null;
  res.render('pasang/detail', {
    title: `Pendaftaran ${row.nomor}`,
    row,
    rincian,
    riwayat,
    pelanggan,
    golonganList: daftarGolongan(req.user),
    sumurList: daftarSumur(req.user),
    bolehUbah: bolehUbah(req.user, row),
    bolehSetujui: PERAN_APPROVAL.includes(req.user.role) && ['draf', 'diajukan'].includes(row.status),
    bolehTolak: PERAN_APPROVAL.includes(req.user.role) && ['draf', 'diajukan'].includes(row.status),
    bolehPasang: row.status === 'disetujui' && PERAN_PENDAFTAR.includes(req.user.role),
    bolehBatal: PERAN_APPROVAL.includes(req.user.role)
      && ['diajukan', 'disetujui'].includes(row.status),
    bolehHapus: ['draf', 'ditolak', 'dibatalkan'].includes(row.status) && bolehUbah(req.user, row),
    today: todayISO(),
  });
});

router.post('/pasang/:id/ajukan', requireRole(...PERAN_PENDAFTAR), (req, res) => {
  const row = ambilPendaftaran(req.user, req.params.id);
  if (!bolehAkses(req.user, row)) {
    req.flash('error', 'Pendaftaran tidak ditemukan.');
    return res.redirect('/pasang');
  }
  if (!['draf', 'ditolak'].includes(row.status)) {
    req.flash('error', 'Hanya draf yang bisa diajukan.');
    return res.redirect(`/pasang/${row.id}`);
  }
  db.prepare(`UPDATE pendaftaran_pasang SET status = 'diajukan', alasan_tolak = NULL,
    diajukan_oleh = ?, diajukan_at = datetime('now','localtime') WHERE id = ?`).run(req.user.id, row.id);
  audit(req, 'ajukan', 'pendaftaran_pasang', row.id, row.nomor);
  req.flash('success', `Pendaftaran ${row.nomor} diajukan ke admin.`);
  res.redirect(`/pasang/${row.id}`);
});

router.post('/pasang/:id/setujui', requireRole(...PERAN_APPROVAL), (req, res) => {
  const row = ambilPendaftaran(req.user, req.params.id);
  if (!bolehAkses(req.user, row)) {
    req.flash('error', 'Pendaftaran tidak ditemukan.');
    return res.redirect('/pasang');
  }
  if (!['draf', 'diajukan'].includes(row.status)) {
    req.flash('error', 'Pendaftaran ini sudah diproses.');
    return res.redirect(`/pasang/${row.id}`);
  }
  const rincian = rincianPendaftaran(row.id);
  const kurang = [];
  rincian.forEach((b) => {
    const stok = db.prepare('SELECT stok, satuan, kode FROM bahan WHERE id = ?').get(b.bahan_id);
    const tersedia = stok ? Number(stok.stok) : 0;
    if (tersedia < Number(b.jumlah)) {
      kurang.push(`${b.nama_bahan}: butuh ${b.jumlah} ${b.satuan}, stok ${tersedia}`);
    }
  });
  if (kurang.length) {
    req.flash('error', `Stok gudang belum cukup — ${kurang.join('; ')}. Tambah penerimaan barang dulu.`);
    return res.redirect(`/pasang/${row.id}`);
  }
  try {
    db.transaction(() => {
      rincian.forEach((b) => {
        const bahan = db.prepare('SELECT stok FROM bahan WHERE id = ?').get(b.bahan_id);
        const stokAkhir = Number(bahan.stok) - Number(b.jumlah);
        db.prepare('UPDATE bahan SET stok = ? WHERE id = ?').run(stokAkhir, b.bahan_id);
        db.prepare(`INSERT INTO bahan_mutasi
          (bahan_id, jenis, jumlah, stok_akhir, referensi, keterangan, user_id)
          VALUES (?,?,?,?,?,?,?)`).run(
          b.bahan_id, 'keluar', b.jumlah, stokAkhir, row.nomor,
          `Pemasangan ${row.nomor} — ${row.nama}`, req.user.id
        );
      });
      db.prepare(`UPDATE pendaftaran_pasang SET status = 'disetujui', disetujui_oleh = ?,
        disetujui_at = datetime('now','localtime'), catatan_admin = ?, alasan_tolak = NULL
        WHERE id = ?`).run(req.user.id, String(req.body.catatan_admin || '').trim() || null, row.id);
    })();
    audit(req, 'setujui', 'pendaftaran_pasang', row.id,
      `${row.nomor} — ${rincian.length} jenis bahan dikeluarkan dari gudang`);
    req.flash('success', `Pendaftaran ${row.nomor} disetujui. Bahan sudah dikeluarkan dari gudang.`);
  } catch (err) {
    req.flash('error', `Gagal menyetujui: ${err.message}`);
  }
  res.redirect(`/pasang/${row.id}`);
});

router.post('/pasang/:id/tolak', requireRole(...PERAN_APPROVAL), (req, res) => {
  const row = ambilPendaftaran(req.user, req.params.id);
  if (!bolehAkses(req.user, row)) {
    req.flash('error', 'Pendaftaran tidak ditemukan.');
    return res.redirect('/pasang');
  }
  if (!['draf', 'diajukan'].includes(row.status)) {
    req.flash('error', 'Pendaftaran ini sudah diproses.');
    return res.redirect(`/pasang/${row.id}`);
  }
  const alasan = String(req.body.alasan_tolak || '').trim();
  db.prepare(`UPDATE pendaftaran_pasang SET status = 'ditolak', alasan_tolak = ?,
    disetujui_oleh = ? WHERE id = ?`).run(alasan || 'Tidak memenuhi syarat', req.user.id, row.id);
  audit(req, 'tolak', 'pendaftaran_pasang', row.id, `${row.nomor} — ${alasan}`);
  req.flash('success', `Pendaftaran ${row.nomor} ditolak dan dikembalikan ke petugas.`);
  res.redirect(`/pasang/${row.id}`);
});

// Pemasangan selesai → jadikan pelanggan resmi (nomor pelanggan & meter otomatis).
router.post('/pasang/:id/terpasang', requireRole(...PERAN_PENDAFTAR), (req, res) => {
  const row = ambilPendaftaran(req.user, req.params.id);
  if (!bolehAkses(req.user, row)) {
    req.flash('error', 'Pendaftaran tidak ditemukan.');
    return res.redirect('/pasang');
  }
  if (row.status !== 'disetujui') {
    req.flash('error', 'Pendaftaran harus disetujui admin sebelum ditandai terpasang.');
    return res.redirect(`/pasang/${row.id}`);
  }
  const tanggalPasang = String(req.body.tanggal_pasang || '').trim() || todayISO();
  // Golongan tarif wajib ada karena kolomnya NOT NULL di tabel pelanggan.
  const golonganId = Number(req.body.golongan_id) || row.golongan_id;
  const golongan = golonganId
    ? db.prepare('SELECT id FROM golongan_tarif WHERE id = ? AND desa_id = ?').get(golonganId, row.desa_id)
    : null;
  if (!golongan) {
    req.flash('error', 'Pilih golongan tarif dulu sebelum pemasangan ditandai selesai.');
    return res.redirect(`/pasang/${row.id}`);
  }
  const sumurId = Number(req.body.sumur_id) || row.sumur_id;
  if (sumurId) {
    const sumur = db.prepare(`SELECT s.id FROM sumur s JOIN dusun d ON d.id = s.dusun_id
      WHERE s.id = ? AND d.desa_id = ?`).get(sumurId, row.desa_id);
    if (!sumur) {
      req.flash('error', 'Sumur yang dipilih tidak valid.');
      return res.redirect(`/pasang/${row.id}`);
    }
  }
  // Kuota pelanggan sesuai paket langganan pengelola.
  const kuota = cekKuota(row.desa_id, 'pelanggan');
  if (!kuota.izin) {
    req.flash('error', `${kuota.pesan} Pemasangan belum bisa diselesaikan.`);
    return res.redirect(`/pasang/${row.id}`);
  }
  try {
    const hasil = db.transaction(() => {
      const nomorPelanggan = nomorPelangganBaru(row.dusun_id);
      const info = db.prepare(`INSERT INTO pelanggan
        (desa_id, dusun_id, sumur_id, golongan_id, nomor_pelanggan, nama, nik, alamat, rt, rw, telepon,
         status, tanggal_daftar)
        VALUES (?,?,?,?,?,?,?,?,?,?,?, 'aktif', ?)`).run(
        row.desa_id, row.dusun_id, sumurId, golongan.id, nomorPelanggan,
        row.nama, row.nik, row.alamat, row.rt, row.rw, row.telepon, tanggalPasang
      );
      const nomorMeter = nomorMeterBaru();
      db.prepare(`INSERT INTO sambungan
        (pelanggan_id, nomor_meter, nomor_seri, merk, tipe, ukuran_inch, status, tanggal_pasang)
        VALUES (?,?,?,?,?,?, 'aktif', ?)`).run(
        info.lastInsertRowid, nomorMeter,
        String(req.body.nomor_seri || '').trim() || null,
        String(req.body.merk || '').trim() || null,
        String(req.body.tipe || '').trim() || null,
        ukuranInci(row.ukuran_pipa), tanggalPasang
      );
      db.prepare(`UPDATE pendaftaran_pasang SET status = 'terpasang', pelanggan_id = ?
        WHERE id = ?`).run(info.lastInsertRowid, row.id);
      return { pelangganId: info.lastInsertRowid, nomorPelanggan, nomorMeter };
    })();
    audit(req, 'terpasang', 'pendaftaran_pasang', row.id,
      `${row.nomor} → pelanggan ${hasil.nomorPelanggan} (meter ${hasil.nomorMeter})`);
    req.flash('success', `Pemasangan selesai. Pelanggan ${hasil.nomorPelanggan} dengan meter ${hasil.nomorMeter} dibuat otomatis.`);
  } catch (err) {
    req.flash('error', `Gagal membuat pelanggan: ${err.message}`);
  }
  res.redirect(`/pasang/${row.id}`);
});

router.post('/pasang/:id/batal', requireRole(...PERAN_APPROVAL), (req, res) => {
  const row = ambilPendaftaran(req.user, req.params.id);
  if (!bolehAkses(req.user, row)) {
    req.flash('error', 'Pendaftaran tidak ditemukan.');
    return res.redirect('/pasang');
  }
  if (!['diajukan', 'disetujui'].includes(row.status)) {
    req.flash('error', 'Pendaftaran ini tidak dapat dibatalkan.');
    return res.redirect(`/pasang/${row.id}`);
  }
  const alasan = String(req.body.alasan_batal || '').trim() || 'Dibatalkan oleh admin';
  const rincian = rincianPendaftaran(row.id);
  db.transaction(() => {
    if (row.status === 'disetujui') {
      rincian.forEach((b) => {
        const bahan = db.prepare('SELECT stok FROM bahan WHERE id = ?').get(b.bahan_id);
        if (!bahan) return;
        const stokAkhir = Number(bahan.stok) + Number(b.jumlah);
        db.prepare('UPDATE bahan SET stok = ? WHERE id = ?').run(stokAkhir, b.bahan_id);
        db.prepare(`INSERT INTO bahan_mutasi
          (bahan_id, jenis, jumlah, stok_akhir, referensi, keterangan, user_id)
          VALUES (?,?,?,?,?,?,?)`).run(
          b.bahan_id, 'masuk', b.jumlah, stokAkhir, row.nomor,
          `Pengembalian bahan — ${row.nomor} dibatalkan`, req.user.id
        );
      });
    }
    db.prepare(`UPDATE pendaftaran_pasang SET status = 'dibatalkan', catatan_admin = ? WHERE id = ?`)
      .run(alasan, row.id);
  })();
  audit(req, 'batal', 'pendaftaran_pasang', row.id, `${row.nomor} — ${alasan}`);
  req.flash('success', row.status === 'disetujui'
    ? `Pendaftaran ${row.nomor} dibatalkan dan bahan dikembalikan ke gudang.`
    : `Pendaftaran ${row.nomor} dibatalkan.`);
  res.redirect(`/pasang/${row.id}`);
});

router.post('/pasang/:id/hapus', requireRole(...PERAN_PENDAFTAR), (req, res) => {
  const row = ambilPendaftaran(req.user, req.params.id);
  if (!bolehUbah(req.user, row)) {
    req.flash('error', 'Pendaftaran ini tidak dapat dihapus.');
    return res.redirect('/pasang');
  }
  db.transaction(() => {
    db.prepare('DELETE FROM pendaftaran_bahan WHERE pendaftaran_id = ?').run(row.id);
    db.prepare('DELETE FROM pendaftaran_pasang WHERE id = ?').run(row.id);
  })();
  audit(req, 'hapus', 'pendaftaran_pasang', row.id, row.nomor);
  req.flash('success', `Pendaftaran ${row.nomor} dihapus.`);
  res.redirect('/pasang');
});

module.exports = router;
