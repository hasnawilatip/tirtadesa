'use strict';

/**
 * Kepegawaian & penggajian.
 * Hanya admin desa dan admin dusun. Admin dusun dibatasi pada karyawannya
 * sendiri (scope dusun), admin desa mencakup seluruh dusun di desanya.
 */

const express = require('express');
const { db } = require('../db');
const { requireAuth, requireRole, aksesSemuaDusun } = require('../auth');
const { audit, todayISO } = require('../helpers');
const { nomorKaryawanBaru, nomorKasbonBaru } = require('../services/penomoran');
const gaji = require('../services/penggajian');

const router = express.Router();
// Batasi middleware ke prefix modul ini saja. Tanpa daftar jalur, router.use()
// akan ikut berjalan pada SEMUA permintaan (termasuk /superadmin) dan menolak
// peran lain sebelum rute lain sempat diproses.
router.use(['/karyawan', '/absensi', '/penggajian', '/kasbon'],
  requireAuth, requireRole('admin_desa', 'admin_dusun'));

const STATUS_ABSEN = ['hadir', 'izin', 'sakit', 'cuti', 'alpa', 'libur'];
const STATUS_KARYAWAN = ['aktif', 'nonaktif'];

function scopeDusun(user) {
  return aksesSemuaDusun(user) ? null : (user.dusun_id || -1);
}

function daftarDusun(user) {
  const scope = scopeDusun(user);
  return db.prepare(`SELECT id, kode, nama FROM dusun
    WHERE desa_id = ?${scope != null ? ' AND id = ?' : ''}
    ORDER BY kode`).all(user.desa_id, ...(scope != null ? [scope] : []));
}

function karyawanDalamScope(user, id) {
  const k = db.prepare('SELECT * FROM karyawan WHERE id = ? AND desa_id = ?').get(Number(id), user.desa_id);
  if (!k) return null;
  if (!aksesSemuaDusun(user) && Number(k.dusun_id) !== Number(user.dusun_id)) return null;
  return k;
}

function slipDalamScope(user, id) {
  const slip = db.prepare('SELECT * FROM penggajian WHERE id = ? AND desa_id = ?').get(Number(id), user.desa_id);
  if (!slip) return null;
  if (aksesSemuaDusun(user)) return slip;
  const k = karyawanDalamScope(user, slip.karyawan_id);
  return k ? slip : null;
}

function kasbonDalamScope(user, id) {
  const kasbon = db.prepare('SELECT * FROM kasbon WHERE id = ? AND desa_id = ?').get(Number(id), user.desa_id);
  if (!kasbon) return null;
  const k = karyawanDalamScope(user, kasbon.karyawan_id);
  return k ? kasbon : null;
}

function parseBulan(nilai) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(nilai || '').trim());
  if (m) {
    const tahun = Number(m[1]);
    const bulan = Number(m[2]);
    if (tahun >= 2000 && tahun <= 2100 && bulan >= 1 && bulan <= 12) return { tahun, bulan };
  }
  const sekarang = new Date();
  return { tahun: sekarang.getFullYear(), bulan: sekarang.getMonth() + 1 };
}

/** Bulan untuk form (dari body) — memakai format YYYY-MM. */
function parseBulanBody(nilai) {
  const hasil = parseBulan(nilai);
  return `${hasil.tahun}-${String(hasil.bulan).padStart(2, '0')}`;
}

function nomorAtauNol(nilai) {
  const n = Number(nilai);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function tanggalValid(nilai) {
  const teks = String(nilai || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(teks) ? teks : null;
}

/** Daftar karyawan aktif dalam scope, dipakai form absensi & slip. */
function karyawanAktif(user) {
  const scope = scopeDusun(user);
  return db.prepare(`SELECT k.id, k.nomor, k.nama, k.jabatan, k.dusun_id, d.nama AS dusun
    FROM karyawan k LEFT JOIN dusun d ON d.id = k.dusun_id
    WHERE k.desa_id = ? AND k.status = 'aktif'${scope != null ? ' AND k.dusun_id = ?' : ''}
    ORDER BY k.nama`).all(user.desa_id, ...(scope != null ? [scope] : []));
}

/** Sisa kasbon per karyawan (satu query, dipetakan di JS). */
function petaSisaKasbon(desaId) {
  const rows = db.prepare(`
    SELECT ks.karyawan_id, ks.jumlah,
           COALESCE((SELECT SUM(b.jumlah) FROM kasbon_bayar b WHERE b.kasbon_id = ks.id), 0) AS dibayar
    FROM kasbon ks WHERE ks.desa_id = ? AND ks.status = 'terbuka'
  `).all(desaId);
  const peta = new Map();
  rows.forEach((r) => {
    const sisa = Math.max(0, Number(r.jumlah) - Number(r.dibayar));
    peta.set(r.karyawan_id, (peta.get(r.karyawan_id) || 0) + sisa);
  });
  return peta;
}

// ---------------------------------------------------------------------------
// KARYAWAN
// ---------------------------------------------------------------------------

router.get('/karyawan', (req, res) => {
  const scope = scopeDusun(req.user);
  const filters = {
    q: String(req.query.q || '').trim(),
    status: String(req.query.status || '').trim(),
    dusun: String(req.query.dusun || '').trim(),
  };
  const syarat = ['k.desa_id = ?'];
  const nilai = [req.user.desa_id];
  if (scope != null) { syarat.push('k.dusun_id = ?'); nilai.push(scope); }
  if (filters.q) {
    syarat.push('(k.nama LIKE ? OR k.nomor LIKE ? OR k.jabatan LIKE ? OR k.nik LIKE ?)');
    const q = `%${filters.q}%`;
    nilai.push(q, q, q, q);
  }
  if (STATUS_KARYAWAN.includes(filters.status)) { syarat.push('k.status = ?'); nilai.push(filters.status); }
  if (filters.dusun) { syarat.push('k.dusun_id = ?'); nilai.push(Number(filters.dusun)); }

  const rows = db.prepare(`
    SELECT k.*, d.nama AS dusun
    FROM karyawan k LEFT JOIN dusun d ON d.id = k.dusun_id
    WHERE ${syarat.join(' AND ')}
    ORDER BY CASE k.status WHEN 'aktif' THEN 0 ELSE 1 END, k.nama
  `).all(...nilai);

  const sisaMap = petaSisaKasbon(req.user.desa_id);
  rows.forEach((r) => { r.kasbon_sisa = sisaMap.get(r.id) || 0; });

  const semua = db.prepare(`SELECT k.status, k.gaji_pokok, k.tunjangan_tetap
    FROM karyawan k WHERE k.desa_id = ?${scope != null ? ' AND k.dusun_id = ?' : ''}`)
    .all(req.user.desa_id, ...(scope != null ? [scope] : []));

  res.render('kepegawaian/karyawan', {
    title: 'Karyawan',
    rows,
    filters,
    dusunList: daftarDusun(req.user),
    nomorOtomatis: nomorKaryawanBaru(req.user.desa_id),
    semuaDusun: aksesSemuaDusun(req.user),
    ringkas: {
      jumlah: semua.filter((k) => k.status === 'aktif').length,
      nonaktif: semua.filter((k) => k.status !== 'aktif').length,
      pokok: semua.reduce((a, k) => a + (k.status === 'aktif' ? Number(k.gaji_pokok) : 0), 0),
      tunjangan: semua.reduce((a, k) => a + (k.status === 'aktif' ? Number(k.tunjangan_tetap) : 0), 0),
      kasbon: Array.from(sisaMap.values()).reduce((a, n) => a + n, 0),
    },
  });
});

function bacaFormKaryawan(req) {
  const dusunId = Number(req.body.dusun_id) || null;
  if (dusunId) {
    const dusun = db.prepare('SELECT id FROM dusun WHERE id = ? AND desa_id = ?').get(dusunId, req.user.desa_id);
    if (!dusun) return { error: 'Dusun tidak valid.' };
    if (!aksesSemuaDusun(req.user) && Number(req.user.dusun_id) !== dusunId) {
      return { error: 'Anda hanya dapat mengelola karyawan dusun Anda sendiri.' };
    }
  } else if (!aksesSemuaDusun(req.user)) {
    return { error: 'Dusun karyawan wajib diisi.' };
  }
  const nama = String(req.body.nama || '').trim();
  if (!nama) return { error: 'Nama karyawan wajib diisi.' };

  return {
    data: {
      dusun_id: dusunId,
      nama,
      nik: String(req.body.nik || '').trim() || null,
      jabatan: String(req.body.jabatan || '').trim() || null,
      telepon: String(req.body.telepon || '').trim() || null,
      tanggal_masuk: tanggalValid(req.body.tanggal_masuk),
      tanggal_keluar: tanggalValid(req.body.tanggal_keluar),
      status: STATUS_KARYAWAN.includes(req.body.status) ? req.body.status : 'aktif',
      gaji_pokok: nomorAtauNol(req.body.gaji_pokok),
      tunjangan_tetap: nomorAtauNol(req.body.tunjangan_tetap),
      potongan_tetap: nomorAtauNol(req.body.potongan_tetap),
      tarif_lembur: nomorAtauNol(req.body.tarif_lembur),
      potongan_alpa: nomorAtauNol(req.body.potongan_alpa),
      rekening: String(req.body.rekening || '').trim() || null,
      catatan: String(req.body.catatan || '').trim() || null,
    },
  };
}

router.post('/karyawan', (req, res) => {
  const hasil = bacaFormKaryawan(req);
  if (hasil.error) {
    req.flash('error', hasil.error);
    return res.redirect('/karyawan');
  }
  const d = hasil.data;
  try {
    const nomor = nomorKaryawanBaru(req.user.desa_id);
    const info = db.prepare(`INSERT INTO karyawan
      (desa_id, dusun_id, nomor, nama, nik, jabatan, telepon, tanggal_masuk, tanggal_keluar,
       status, gaji_pokok, tunjangan_tetap, potongan_tetap, tarif_lembur, potongan_alpa, rekening, catatan)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      req.user.desa_id, d.dusun_id, nomor, d.nama, d.nik, d.jabatan, d.telepon,
      d.tanggal_masuk, d.tanggal_keluar, d.status, d.gaji_pokok, d.tunjangan_tetap,
      d.potongan_tetap, d.tarif_lembur, d.potongan_alpa, d.rekening, d.catatan,
    );
    audit(req, 'create', 'karyawan', info.lastInsertRowid, `${nomor} ${d.nama}`);
    req.flash('success', `Karyawan ${d.nama} ditambahkan (${nomor}).`);
  } catch (err) {
    req.flash('error', `Gagal menyimpan karyawan: ${err.message}`);
  }
  res.redirect('/karyawan');
});

router.post('/karyawan/:id', (req, res) => {
  const karyawan = karyawanDalamScope(req.user, req.params.id);
  if (!karyawan) {
    req.flash('error', 'Karyawan tidak ditemukan.');
    return res.redirect('/karyawan');
  }
  const hasil = bacaFormKaryawan(req);
  if (hasil.error) {
    req.flash('error', hasil.error);
    return res.redirect('/karyawan');
  }
  const d = hasil.data;
  try {
    db.prepare(`UPDATE karyawan SET
      dusun_id = ?, nama = ?, nik = ?, jabatan = ?, telepon = ?, tanggal_masuk = ?, tanggal_keluar = ?,
      status = ?, gaji_pokok = ?, tunjangan_tetap = ?, potongan_tetap = ?, tarif_lembur = ?,
      potongan_alpa = ?, rekening = ?, catatan = ?
      WHERE id = ?`).run(
      d.dusun_id, d.nama, d.nik, d.jabatan, d.telepon, d.tanggal_masuk, d.tanggal_keluar,
      d.status, d.gaji_pokok, d.tunjangan_tetap, d.potongan_tetap, d.tarif_lembur,
      d.potongan_alpa, d.rekening, d.catatan, karyawan.id,
    );
    audit(req, 'update', 'karyawan', karyawan.id, d.nama);
    req.flash('success', 'Data karyawan diperbarui.');
  } catch (err) {
    req.flash('error', `Gagal memperbarui karyawan: ${err.message}`);
  }
  res.redirect('/karyawan');
});

// ---------------------------------------------------------------------------
// ABSENSI
// ---------------------------------------------------------------------------

router.get('/absensi', (req, res) => {
  const { tahun, bulan } = parseBulan(req.query.bulan);
  const { mulai, selesai } = gaji.rentangBulan(tahun, bulan);
  const scope = scopeDusun(req.user);

  const rekap = db.prepare(`
    SELECT k.id, k.nomor, k.nama, k.jabatan, d.nama AS dusun,
      COALESCE(SUM(CASE WHEN a.status = 'hadir' THEN 1 ELSE 0 END), 0) AS hadir,
      COALESCE(SUM(CASE WHEN a.status = 'izin'  THEN 1 ELSE 0 END), 0) AS izin,
      COALESCE(SUM(CASE WHEN a.status = 'sakit' THEN 1 ELSE 0 END), 0) AS sakit,
      COALESCE(SUM(CASE WHEN a.status = 'cuti'  THEN 1 ELSE 0 END), 0) AS cuti,
      COALESCE(SUM(CASE WHEN a.status = 'alpa'  THEN 1 ELSE 0 END), 0) AS alpa,
      COALESCE(SUM(CASE WHEN a.status = 'libur' THEN 1 ELSE 0 END), 0) AS libur,
      COALESCE(SUM(a.lembur_jam), 0) AS lembur
    FROM karyawan k
    LEFT JOIN dusun d ON d.id = k.dusun_id
    LEFT JOIN absensi a ON a.karyawan_id = k.id AND a.tanggal >= ? AND a.tanggal < ?
    WHERE k.desa_id = ? AND k.status = 'aktif'${scope != null ? ' AND k.dusun_id = ?' : ''}
    GROUP BY k.id, k.nomor, k.nama, k.jabatan, d.nama
    ORDER BY k.nama
  `).all(mulai, selesai, req.user.desa_id, ...(scope != null ? [scope] : []));

  const catatan = db.prepare(`
    SELECT a.*, k.nama AS karyawan, k.nomor
    FROM absensi a JOIN karyawan k ON k.id = a.karyawan_id
    WHERE k.desa_id = ? AND a.tanggal >= ? AND a.tanggal < ?
      ${scope != null ? 'AND k.dusun_id = ?' : ''}
    ORDER BY a.tanggal DESC, k.nama
    LIMIT 300
  `).all(req.user.desa_id, mulai, selesai, ...(scope != null ? [scope] : []));

  const total = rekap.reduce((a, r) => ({
    hadir: a.hadir + r.hadir,
    alpa: a.alpa + r.alpa,
    lembur: a.lembur + r.lembur,
    tercatat: a.tercatat + r.hadir + r.izin + r.sakit + r.cuti + r.alpa + r.libur,
  }), { hadir: 0, alpa: 0, lembur: 0, tercatat: 0 });

  res.render('kepegawaian/absensi', {
    title: 'Absensi Karyawan',
    rekap,
    catatan,
    total,
    bulan: `${tahun}-${String(bulan).padStart(2, '0')}`,
    tahun,
    bulanAngka: bulan,
    karyawanList: karyawanAktif(req.user),
    hariDalamBulan: gaji.jumlahHari(tahun, bulan),
    today: todayISO(),
  });
});

router.post('/absensi', (req, res) => {
  const karyawan = karyawanDalamScope(req.user, req.body.karyawan_id);
  if (!karyawan) {
    req.flash('error', 'Karyawan tidak ditemukan.');
    return res.redirect('/absensi');
  }
  const tanggal = tanggalValid(req.body.tanggal);
  if (!tanggal) {
    req.flash('error', 'Tanggal absensi tidak valid.');
    return res.redirect(`/absensi?bulan=${String(req.body.bulan || '').slice(0, 7)}`);
  }
  const status = STATUS_ABSEN.includes(req.body.status) ? req.body.status : 'hadir';
  const lembur = Math.min(24, nomorAtauNol(req.body.lembur_jam));
  const jamMasuk = String(req.body.jam_masuk || '').trim() || null;
  const jamKeluar = String(req.body.jam_keluar || '').trim() || null;
  const keterangan = String(req.body.keterangan || '').trim() || null;

  try {
    db.prepare(`
      INSERT INTO absensi (karyawan_id, tanggal, status, jam_masuk, jam_keluar, lembur_jam, keterangan, dicatat_oleh)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(karyawan_id, tanggal) DO UPDATE SET
        status = excluded.status,
        jam_masuk = excluded.jam_masuk,
        jam_keluar = excluded.jam_keluar,
        lembur_jam = excluded.lembur_jam,
        keterangan = excluded.keterangan,
        dicatat_oleh = excluded.dicatat_oleh
    `).run(karyawan.id, tanggal, status, jamMasuk, jamKeluar, lembur, keterangan, req.user.id);
    audit(req, 'update', 'absensi', karyawan.id, `${karyawan.nama} ${tanggal} ${status}`);
    req.flash('success', `Absensi ${karyawan.nama} tanggal ${tanggal} disimpan.`);
  } catch (err) {
    req.flash('error', `Gagal menyimpan absensi: ${err.message}`);
  }
  res.redirect(`/absensi?bulan=${tanggal.slice(0, 7)}`);
});

/** Isi cepat: tandai semua karyawan aktif pada satu tanggal. */
router.post('/absensi/massal', (req, res) => {
  const tanggal = tanggalValid(req.body.tanggal);
  if (!tanggal) {
    req.flash('error', 'Tanggal absensi tidak valid.');
    return res.redirect('/absensi');
  }
  const status = STATUS_ABSEN.includes(req.body.status) ? req.body.status : 'hadir';
  const daftar = karyawanAktif(req.user);
  let dibuat = 0;
  try {
    const tambah = db.prepare(`INSERT OR IGNORE INTO absensi
      (karyawan_id, tanggal, status, dicatat_oleh) VALUES (?,?,?,?)`);
    const jalankan = db.transaction(() => {
      daftar.forEach((k) => {
        const info = tambah.run(k.id, tanggal, status, req.user.id);
        if (info.changes) dibuat += 1;
      });
    });
    jalankan();
    audit(req, 'create', 'absensi', null, `Massal ${tanggal} ${status}: ${dibuat} karyawan`);
    req.flash('success', `${dibuat} catatan absensi dibuat untuk ${tanggal}; `
      + `${daftar.length - dibuat} karyawan sudah tercatat sebelumnya.`);
  } catch (err) {
    req.flash('error', `Gagal mengisi absensi massal: ${err.message}`);
  }
  res.redirect(`/absensi?bulan=${tanggal.slice(0, 7)}`);
});

router.post('/absensi/:id/hapus', (req, res) => {
  const row = db.prepare('SELECT * FROM absensi WHERE id = ?').get(Number(req.params.id));
  if (!row) {
    req.flash('error', 'Catatan absensi tidak ditemukan.');
    return res.redirect('/absensi');
  }
  const karyawan = karyawanDalamScope(req.user, row.karyawan_id);
  if (!karyawan) {
    return res.status(403).render('error', {
      title: 'Akses ditolak',
      message: 'Catatan absensi ini bukan milik karyawan desa/dusun Anda.',
    });
  }
  db.prepare('DELETE FROM absensi WHERE id = ?').run(row.id);
  audit(req, 'delete', 'absensi', row.id, `${karyawan.nama} ${row.tanggal}`);
  req.flash('success', 'Catatan absensi dihapus.');
  res.redirect(`/absensi?bulan=${String(row.tanggal).slice(0, 7)}`);
});

// ---------------------------------------------------------------------------
// PENGGAJIAN
// ---------------------------------------------------------------------------

router.get('/penggajian', (req, res) => {
  const { tahun, bulan } = parseBulan(req.query.bulan);
  const filterStatus = ['draf', 'dibayar'].includes(req.query.status) ? req.query.status : '';
  const scope = scopeDusun(req.user);

  const syarat = ['p.desa_id = ?', 'p.tahun = ?', 'p.bulan = ?'];
  const nilai = [req.user.desa_id, tahun, bulan];
  if (scope != null) { syarat.push('k.dusun_id = ?'); nilai.push(scope); }
  if (filterStatus) { syarat.push('p.status = ?'); nilai.push(filterStatus); }

  const rows = db.prepare(`
    SELECT p.*, k.nama AS karyawan, k.nomor AS nomor_karyawan, k.jabatan, d.nama AS dusun
    FROM penggajian p
    JOIN karyawan k ON k.id = p.karyawan_id
    LEFT JOIN dusun d ON d.id = k.dusun_id
    WHERE ${syarat.join(' AND ')}
    ORDER BY k.nama
  `).all(...nilai);

  const sudah = new Set(db.prepare(`
    SELECT p.karyawan_id FROM penggajian p JOIN karyawan k ON k.id = p.karyawan_id
    WHERE p.desa_id = ? AND p.tahun = ? AND p.bulan = ?${scope != null ? ' AND k.dusun_id = ?' : ''}
  `).all(req.user.desa_id, tahun, bulan, ...(scope != null ? [scope] : [])).map((r) => r.karyawan_id));

  const belum = karyawanAktif(req.user).filter((k) => !sudah.has(k.id));

  res.render('kepegawaian/penggajian', {
    title: 'Penggajian',
    rows,
    belum,
    ringkas: gaji.ringkasanPeriode(req.user.desa_id, tahun, bulan),
    filterStatus,
    bulan: `${tahun}-${String(bulan).padStart(2, '0')}`,
    tahun,
    bulanAngka: bulan,
    today: todayISO(),
  });
});

router.post('/penggajian/buat', (req, res) => {
  const nilai = parseBulanBody(req.body.bulan);
  const { tahun, bulan } = parseBulan(nilai);
  const daftar = karyawanAktif(req.user);
  let dibuat = 0;
  try {
    const jalankan = db.transaction(() => {
      daftar.forEach((k) => {
        const karyawan = db.prepare('SELECT * FROM karyawan WHERE id = ?').get(k.id);
        if (gaji.buatSlip(karyawan, tahun, bulan, req.user.id)) dibuat += 1;
      });
    });
    jalankan();
    audit(req, 'create', 'penggajian', null, `Buat slip ${nilai}: ${dibuat}`);
    if (dibuat) req.flash('success', `${dibuat} slip gaji draf dibuat untuk ${nilai}.`);
    else req.flash('info', 'Semua karyawan aktif sudah memiliki slip pada periode ini.');
  } catch (err) {
    req.flash('error', `Gagal membuat slip gaji: ${err.message}`);
  }
  res.redirect(`/penggajian?bulan=${nilai}`);
});

router.post('/penggajian/:id/hitung', (req, res) => {
  const slip = slipDalamScope(req.user, req.params.id);
  if (!slip) {
    req.flash('error', 'Slip gaji tidak ditemukan.');
    return res.redirect('/penggajian');
  }
  try {
    gaji.hitungUlang(slip.id);
    audit(req, 'update', 'penggajian', slip.id, `Hitung ulang ${slip.nomor}`);
    req.flash('success', 'Slip gaji dihitung ulang dari data absensi terbaru.');
  } catch (err) {
    req.flash('error', err.message);
  }
  res.redirect(`/penggajian?bulan=${slip.tahun}-${String(slip.bulan).padStart(2, '0')}`);
});

router.post('/penggajian/:id/bayar', (req, res) => {
  const slip = slipDalamScope(req.user, req.params.id);
  if (!slip) {
    req.flash('error', 'Slip gaji tidak ditemukan.');
    return res.redirect('/penggajian');
  }
  try {
    gaji.bayarSlip(slip.id, {
      tanggalBayar: tanggalValid(req.body.tanggal_bayar) || todayISO(),
      metode: req.body.metode,
      catatan: req.body.catatan,
    }, req.user.id);
    audit(req, 'update', 'penggajian', slip.id, `Bayar ${slip.nomor}`);
    req.flash('success', 'Slip gaji ditandai dibayar; potongan kasbon ikut dicatat.');
  } catch (err) {
    req.flash('error', err.message);
  }
  res.redirect(`/penggajian?bulan=${slip.tahun}-${String(slip.bulan).padStart(2, '0')}`);
});

router.post('/penggajian/:id/hapus', (req, res) => {
  const slip = slipDalamScope(req.user, req.params.id);
  if (!slip) {
    req.flash('error', 'Slip gaji tidak ditemukan.');
    return res.redirect('/penggajian');
  }
  if (slip.status !== 'draf') {
    req.flash('error', 'Slip yang sudah dibayar tidak dapat dihapus.');
    return res.redirect(`/penggajian?bulan=${slip.tahun}-${String(slip.bulan).padStart(2, '0')}`);
  }
  db.prepare('DELETE FROM penggajian WHERE id = ?').run(slip.id);
  audit(req, 'delete', 'penggajian', slip.id, slip.nomor);
  req.flash('success', 'Slip gaji draf dihapus.');
  res.redirect(`/penggajian?bulan=${slip.tahun}-${String(slip.bulan).padStart(2, '0')}`);
});

router.get('/penggajian/:id/cetak', (req, res) => {
  const slip = slipDalamScope(req.user, req.params.id);
  if (!slip) {
    return res.status(404).render('error', {
      title: 'Slip tidak ditemukan',
      message: 'Slip gaji tidak ditemukan atau bukan milik desa/dusun Anda.',
    });
  }
  const karyawan = db.prepare('SELECT k.*, d.nama AS dusun FROM karyawan k LEFT JOIN dusun d ON d.id = k.dusun_id WHERE k.id = ?')
    .get(slip.karyawan_id);
  res.render('kepegawaian/slip', {
    title: `Slip Gaji ${slip.nomor}`,
    slip,
    karyawan,
    potonganHarian: gaji.potonganAlpaHarian(karyawan),
    pemberi: res.locals.desaAktif,
  });
});

// ---------------------------------------------------------------------------
// KASBON
// ---------------------------------------------------------------------------

router.get('/kasbon', (req, res) => {
  const scope = scopeDusun(req.user);
  const filterStatus = ['terbuka', 'lunas', 'dibatalkan'].includes(req.query.status) ? req.query.status : '';
  const q = String(req.query.q || '').trim();

  const syarat = ['ks.desa_id = ?'];
  const nilai = [req.user.desa_id];
  if (scope != null) { syarat.push('k.dusun_id = ?'); nilai.push(scope); }
  if (filterStatus) { syarat.push('ks.status = ?'); nilai.push(filterStatus); }
  if (q) {
    syarat.push('(k.nama LIKE ? OR ks.nomor LIKE ? OR ks.keterangan LIKE ?)');
    nilai.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }

  const rows = db.prepare(`
    SELECT ks.*, k.nama AS karyawan, k.nomor AS nomor_karyawan, d.nama AS dusun,
           COALESCE((SELECT SUM(b.jumlah) FROM kasbon_bayar b WHERE b.kasbon_id = ks.id), 0) AS dibayar
    FROM kasbon ks
    JOIN karyawan k ON k.id = ks.karyawan_id
    LEFT JOIN dusun d ON d.id = k.dusun_id
    WHERE ${syarat.join(' AND ')}
    ORDER BY CASE ks.status WHEN 'terbuka' THEN 0 WHEN 'lunas' THEN 1 ELSE 2 END, ks.tanggal DESC, ks.id DESC
  `).all(...nilai);
  rows.forEach((r) => { r.sisa = Math.max(0, Number(r.jumlah) - Number(r.dibayar)); });

  const terbuka = rows.filter((r) => r.status === 'terbuka');
  res.render('kepegawaian/kasbon', {
    title: 'Kasbon Karyawan',
    rows,
    filters: { status: filterStatus, q },
    karyawanList: karyawanAktif(req.user),
    nomorOtomatis: nomorKasbonBaru(req.user.desa_id),
    today: todayISO(),
    ringkas: {
      terbuka: terbuka.length,
      sisa: terbuka.reduce((a, r) => a + r.sisa, 0),
      total: rows.reduce((a, r) => a + Number(r.jumlah), 0),
      dibayar: rows.reduce((a, r) => a + Number(r.dibayar), 0),
    },
  });
});

router.post('/kasbon', (req, res) => {
  const karyawan = karyawanDalamScope(req.user, req.body.karyawan_id);
  if (!karyawan) {
    req.flash('error', 'Karyawan tidak ditemukan.');
    return res.redirect('/kasbon');
  }
  const jumlah = nomorAtauNol(req.body.jumlah);
  if (!jumlah) {
    req.flash('error', 'Jumlah kasbon wajib lebih dari nol.');
    return res.redirect('/kasbon');
  }
  const tanggal = tanggalValid(req.body.tanggal) || todayISO();
  try {
    const nomor = nomorKasbonBaru(req.user.desa_id);
    const info = db.prepare(`INSERT INTO kasbon
      (desa_id, karyawan_id, nomor, tanggal, jumlah, keterangan, status, dibuat_oleh)
      VALUES (?,?,?,?,?,?, 'terbuka', ?)`).run(
      req.user.desa_id, karyawan.id, nomor, tanggal, jumlah,
      String(req.body.keterangan || '').trim() || null, req.user.id,
    );
    audit(req, 'create', 'kasbon', info.lastInsertRowid, `${nomor} ${karyawan.nama}`);
    req.flash('success', `Kasbon ${nomor} untuk ${karyawan.nama} dicatat.`);
  } catch (err) {
    req.flash('error', `Gagal menyimpan kasbon: ${err.message}`);
  }
  res.redirect('/kasbon');
});

router.post('/kasbon/:id/bayar', (req, res) => {
  const kasbon = kasbonDalamScope(req.user, req.params.id);
  if (!kasbon) {
    req.flash('error', 'Kasbon tidak ditemukan.');
    return res.redirect('/kasbon');
  }
  if (kasbon.status !== 'terbuka') {
    req.flash('error', 'Kasbon ini sudah lunas atau dibatalkan.');
    return res.redirect('/kasbon');
  }
  const jumlah = nomorAtauNol(req.body.jumlah);
  const dibayar = db.prepare('SELECT COALESCE(SUM(jumlah),0) AS n FROM kasbon_bayar WHERE kasbon_id = ?')
    .get(kasbon.id).n;
  const sisa = Math.max(0, Number(kasbon.jumlah) - Number(dibayar));
  if (!jumlah || jumlah > sisa) {
    req.flash('error', `Jumlah pembayaran harus antara 1 dan ${Math.round(sisa)}.`);
    return res.redirect('/kasbon');
  }
  const tanggal = tanggalValid(req.body.tanggal) || todayISO();
  try {
    const jalankan = db.transaction(() => {
      db.prepare(`INSERT INTO kasbon_bayar (kasbon_id, tanggal, jumlah, keterangan, dicatat_oleh)
        VALUES (?,?,?,?,?)`).run(
        kasbon.id, tanggal, jumlah,
        String(req.body.keterangan || '').trim() || null, req.user.id,
      );
      if (jumlah >= sisa) db.prepare("UPDATE kasbon SET status = 'lunas' WHERE id = ?").run(kasbon.id);
    });
    jalankan();
    audit(req, 'update', 'kasbon', kasbon.id, `Bayar ${kasbon.nomor} ${jumlah}`);
    req.flash('success', jumlah >= sisa ? 'Kasbon lunas.' : 'Pembayaran kasbon dicatat.');
  } catch (err) {
    req.flash('error', `Gagal mencatat pembayaran kasbon: ${err.message}`);
  }
  res.redirect('/kasbon');
});

router.post('/kasbon/:id/batal', (req, res) => {
  const kasbon = kasbonDalamScope(req.user, req.params.id);
  if (!kasbon) {
    req.flash('error', 'Kasbon tidak ditemukan.');
    return res.redirect('/kasbon');
  }
  const dibayar = db.prepare('SELECT COALESCE(SUM(jumlah),0) AS n FROM kasbon_bayar WHERE kasbon_id = ?')
    .get(kasbon.id).n;
  if (Number(dibayar) > 0) {
    req.flash('error', 'Kasbon yang sudah ada pembayaran tidak dapat dibatalkan.');
    return res.redirect('/kasbon');
  }
  db.prepare("UPDATE kasbon SET status = 'dibatalkan' WHERE id = ?").run(kasbon.id);
  audit(req, 'update', 'kasbon', kasbon.id, `Batal ${kasbon.nomor}`);
  req.flash('success', 'Kasbon dibatalkan.');
  res.redirect('/kasbon');
});

module.exports = router;
