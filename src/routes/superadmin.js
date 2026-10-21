'use strict';

const crypto = require('crypto');
const express = require('express');
const { db, seedBahanDesa } = require('../db');
const { requireRole, ROLE_LABEL } = require('../auth');
const { audit, formatISO } = require('../helpers');
const { hashSandi, validasiSandi } = require('../services/sandi');
const { kodeDusun } = require('../services/kode');
const { daftarPaket, paketById, ringkasanSemuaDesa } = require('../services/langganan');
const tagihanLgn = require('../services/tagihan-langganan');

const router = express.Router();

// Guard dipasang per rute agar router ini tidak memblokir rute lain yang dimount setelahnya.

const LABEL_PENDAFTARAN = {
  baru: 'Baru',
  dihubungi: 'Dihubungi',
  diterima: 'Diterima',
  ditolak: 'Ditolak',
};
const STATUS_PENDAFTARAN = Object.keys(LABEL_PENDAFTARAN);

const LABEL_RESET = { baru: 'Baru', diproses: 'Diproses', selesai: 'Selesai' };
const STATUS_RESET = Object.keys(LABEL_RESET);

const LABEL_JENIS = { desa: 'Desa', dusun: 'Dusun', individu: 'Individu/Usaha' };

// Jenis pendaftaran menentukan peran awal akun yang dibuat superadmin.
const ROLE_DARI_JENIS = { desa: 'admin_desa', dusun: 'admin_dusun', individu: 'admin_desa' };
const ROLE_AKUN_PENDAFTAR = ['admin_desa', 'admin_dusun'];

function waLink(nomor) {
  let digit = String(nomor || '').replace(/\D/g, '');
  if (digit.startsWith('0')) digit = `62${digit.slice(1)}`;
  return digit ? `https://wa.me/${digit}` : null;
}

function pendaftaranTerbaru(limit = 5) {
  return db.prepare(`SELECT * FROM pendaftaran_pengelola
    ORDER BY created_at DESC, id DESC LIMIT ?`).all(limit)
    .map((p) => ({ ...p, wa: waLink(p.whatsapp) }));
}

/** Username otomatis dari nama pendaftar, dijamin unik. */
function usernameOtomatis(nama) {
  const dasar = String(nama || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 14) || 'pengelola';
  let calon = dasar;
  let urut = 1;
  while (db.prepare('SELECT 1 FROM users WHERE username = ?').get(calon)) {
    urut += 1;
    calon = `${dasar}${urut}`;
  }
  return calon;
}

/** Kata sandi sementara yang mudah dibacakan lewat WhatsApp. */
function sandiSementara(panjang = 8) {
  const huruf = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let hasil = '';
  for (let i = 0; i < panjang; i += 1) hasil += huruf[crypto.randomInt(0, huruf.length)];
  return hasil;
}

/**
 * Buat ruang kerja (desa/tenant) baru untuk pendaftar, lengkap dengan dusun
 * dan tarif awal supaya pengelola bisa langsung menambah pelanggan.
 * Buat ruang kerja (desa/tenant) baru untuk pendaftar, lengkap dengan dusun
 * dan tarif awal supaya pengelola bisa langsung menambah pelanggan.
 * Setiap pengelola hanya melihat data milik desa-nya sendiri.
 */
/**
 * Pisahkan "lokasi" hasil formulir pendaftaran menjadi desa/kecamatan/kabupaten.
 * Contoh: "Desa Sukamaju, Kec. Cibadak, Kab. Sukabumi".
 */
function bagianLokasi(lokasi) {
  const bagian = String(lokasi || '').split(',').map((s) => s.trim()).filter(Boolean);
  // Pendaftaran dusun menyimpan "Dusun X, Desa Y, Kec. Z, ..." → nama desa diambil dari "Desa Y".
  return {
    desa: (bagian.find((b) => /^desa\s/i.test(b)) || bagian[0] || null),
    kecamatan: (bagian.find((b) => /^kec\.?\s/i.test(b)) || '').replace(/^kec\.?\s*/i, '') || null,
    kabupaten: (bagian.find((b) => /^kab(upaten)?\.?\s/i.test(b)) || '').replace(/^kab(upaten)?\.?\s*/i, '') || null,
  };
}

function buatTenant(row, namaDusun, paketId = null) {
  const lokasi = bagianLokasi(row.lokasi);
  const jenis = ['desa', 'dusun', 'individu'].includes(row.jenis) ? row.jenis : 'desa';

  // Nama ruang kerja mengikuti jenis pendaftaran:
  // - individu/usaha → nama usaha pendaftar
  // - dusun mandiri  → nama dusun (bukan nama desa induk)
  // - desa           → nama desa
  let namaDesa;
  if (jenis === 'individu') {
    namaDesa = row.usaha || row.nama;
  } else if (jenis === 'dusun') {
    const dasar = String(namaDusun || row.usaha || row.nama || '').trim();
    namaDesa = /^dusun\s/i.test(dasar) ? dasar : `Dusun ${dasar}`.trim();
  } else {
    namaDesa = lokasi.desa || row.usaha || row.nama;
  }
  namaDesa = namaDesa || lokasi.desa || row.usaha || row.nama;

  const paket = paketId ? paketById(paketId) : null;
  const infoDesa = db.prepare(`INSERT INTO desa
    (nama, jenis, kecamatan, kabupaten, alamat, telepon, paket_id, langganan_mulai, langganan_sampai, status_langganan)
    VALUES (?,?,?,?,?,?,?, date('now','localtime'), date('now','localtime','+30 day'), 'aktif')`).run(
    namaDesa, jenis, lokasi.kecamatan, lokasi.kabupaten, row.lokasi || null, row.whatsapp || null,
    paket ? paket.id : null
  );
  const desaId = Number(infoDesa.lastInsertRowid);

  const infoGolongan = db.prepare(`INSERT INTO golongan_tarif
    (desa_id, kode, nama, abonemen, min_pemakaian_m3, denda_persen, denda_maks_persen)
    VALUES (?, 'RT', 'Rumah Tangga', 5000, 10, 0, 0)`).run(desaId);
  const blok = [[1, 0, 10, 1500], [2, 10, 20, 2000], [3, 20, null, 2500]];
  blok.forEach(([ke, dari, sampai, harga]) => {
    db.prepare(`INSERT INTO tarif_blok (golongan_id, blok_ke, dari_m3, sampai_m3, harga_per_m3)
      VALUES (?,?,?,?,?)`).run(infoGolongan.lastInsertRowid, ke, dari, sampai, harga);
  });

  const infoDusun = db.prepare('INSERT INTO dusun (desa_id, kode, nama) VALUES (?,?,?)')
    .run(desaId, kodeDusun(), namaDusun || namaDesa);

  // Gudang bahan standar agar pengelola baru bisa langsung mencatat stok/pembelian.
  seedBahanDesa(desaId);

  return { desaId, dusunId: Number(infoDusun.lastInsertRowid) };
}

router.get('/superadmin', requireRole('superadmin'), (req, res) => {
  const stat = {
    pengguna: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
    penggunaAktif: db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_active = 1').get().n,
    dusun: db.prepare('SELECT COUNT(*) AS n FROM dusun WHERE is_active = 1').get().n,
    sumur: db.prepare('SELECT COUNT(*) AS n FROM sumur').get().n,
    pelanggan: db.prepare("SELECT COUNT(*) AS n FROM pelanggan WHERE status = 'aktif'").get().n,
    pendaftaran: db.prepare("SELECT COUNT(*) AS n FROM pendaftaran_pengelola WHERE status = 'baru'").get().n,
    reset: db.prepare("SELECT COUNT(*) AS n FROM permintaan_reset WHERE status = 'baru'").get().n,
  };
  const perRole = db.prepare('SELECT role, COUNT(*) AS n FROM users GROUP BY role').all();
  const permintaanReset = db.prepare(`SELECT * FROM permintaan_reset
    ORDER BY created_at DESC, id DESC LIMIT 5`).all()
    .map((p) => ({ ...p, wa: waLink(p.whatsapp) }));
  const penggunaTerbaru = db.prepare(`
    SELECT u.id, u.nama, u.username, u.role, u.is_active, u.created_at,
           d.nama AS dusun, ds.jenis AS desa_jenis
    FROM users u
    LEFT JOIN dusun d ON d.id = u.dusun_id
    LEFT JOIN desa ds ON ds.id = u.desa_id
    ORDER BY u.id DESC LIMIT 6
  `).all();

  // Ringkasan komersial: pengelola aktif, sebaran paket, estimasi pendapatan.
  const langganan = ringkasanSemuaDesa();
  const komersial = {
    pengelola: langganan.length,
    paket: db.prepare('SELECT COUNT(*) AS n FROM paket WHERE is_active = 1').get().n,
    pendapatan: langganan
      .filter((l) => l.paket && l.desa.status_langganan === 'aktif')
      .reduce((a, l) => a + Number(l.paket.harga), 0),
    perluPerhatian: langganan.filter((l) => l.peringatan.length > 0).length,
  };

  res.render('superadmin/index', {
    title: 'Panel Superadmin',
    stat,
    perRole,
    penggunaTerbaru,
    pendaftaranTerbaru: pendaftaranTerbaru(),
    permintaanReset,
    komersial,
    statusLabel: LABEL_PENDAFTARAN,
    statusReset: LABEL_RESET,
    jenisLabel: LABEL_JENIS,
  });
});

// Profil desa bukan wewenang superadmin; dikelola admin desa di /profil-desa.
router.get('/superadmin/desa', requireRole('superadmin'), (req, res) => res.redirect('/superadmin'));

// ---------------------------------------------------------------------------
// PENDAFTARAN PENGELOLA SUMUR BOR (dari halaman publik /gabung)
// ---------------------------------------------------------------------------

router.get('/superadmin/pendaftaran', requireRole('superadmin'), (req, res) => {
  const filter = STATUS_PENDAFTARAN.includes(req.query.status) ? req.query.status : '';
  const dasar = `SELECT p.*, u.username AS akun_username, u.role AS akun_role, pk.nama AS paket_nama
    FROM pendaftaran_pengelola p LEFT JOIN users u ON u.id = p.user_id
    LEFT JOIN paket pk ON pk.id = p.paket_id`;
  const rows = (filter
    ? db.prepare(`${dasar} WHERE p.status = ? ORDER BY p.created_at DESC, p.id DESC`).all(filter)
    : db.prepare(`${dasar} ORDER BY p.created_at DESC, p.id DESC`).all())
    .map((p) => ({
      ...p,
      wa: waLink(p.whatsapp),
      saran_username: p.user_id ? null : usernameOtomatis(p.nama),
      saran_password: p.user_id ? null : sandiSementara(),
      saran_role: ROLE_DARI_JENIS[p.jenis] || 'admin_desa',
    }));

  const hitung = {};
  STATUS_PENDAFTARAN.forEach((status) => {
    hitung[status] = db.prepare('SELECT COUNT(*) AS n FROM pendaftaran_pengelola WHERE status = ?').get(status).n;
  });
  const total = db.prepare('SELECT COUNT(*) AS n FROM pendaftaran_pengelola').get().n;

  res.render('superadmin/pendaftaran', {
    title: 'Pendaftaran Pengelola',
    rows,
    filter,
    hitung,
    total,
    statusLabel: LABEL_PENDAFTARAN,
    statusOptions: STATUS_PENDAFTARAN,
    jenisLabel: LABEL_JENIS,
    roleAkunOptions: ROLE_AKUN_PENDAFTAR,
    roleLabel: ROLE_LABEL,
    paketList: daftarPaket({ hanyaAktif: true }),
    dusunList: db.prepare('SELECT id, kode, nama FROM dusun ORDER BY kode').all(),
  });
});

router.post('/superadmin/pendaftaran/:id/status', requireRole('superadmin'), (req, res) => {
  const id = Number(req.params.id);
  const status = String(req.body.status || '');
  const row = db.prepare('SELECT * FROM pendaftaran_pengelola WHERE id = ?').get(id);
  if (!row) {
    req.flash('error', 'Pendaftaran tidak ditemukan.');
    return res.redirect('/superadmin/pendaftaran');
  }
  if (!STATUS_PENDAFTARAN.includes(status)) {
    req.flash('error', 'Status pendaftaran tidak valid.');
    return res.redirect('/superadmin/pendaftaran');
  }
  db.prepare('UPDATE pendaftaran_pengelola SET status = ? WHERE id = ?').run(status, id);
  audit(req, 'update', 'pendaftaran_pengelola', id, `${row.usaha} → ${status}`);
  req.flash('success', `Status pendaftaran ${row.nama} diubah menjadi ${LABEL_PENDAFTARAN[status]}.`);
  res.redirect('/superadmin/pendaftaran');
});

// Buat akun pengelola langsung dari data pendaftaran (tanpa isi ulang manual).
router.post('/superadmin/pendaftaran/:id/akun', requireRole('superadmin'), (req, res) => {
  const id = Number(req.params.id);
  const kembali = '/superadmin/pendaftaran';
  const row = db.prepare('SELECT * FROM pendaftaran_pengelola WHERE id = ?').get(id);
  if (!row) {
    req.flash('error', 'Pendaftaran tidak ditemukan.');
    return res.redirect(kembali);
  }
  if (row.user_id) {
    req.flash('error', `Akun untuk ${row.nama} sudah dibuat sebelumnya.`);
    return res.redirect(kembali);
  }

  const nama = String(req.body.nama || '').trim();
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const role = String(req.body.role || '');

  if (!nama || !username || !password) {
    req.flash('error', 'Nama, username, dan kata sandi wajib diisi.');
    return res.redirect(kembali);
  }
  const salahSandi = validasiSandi(password, { username, nama });
  if (salahSandi) {
    req.flash('error', salahSandi);
    return res.redirect(kembali);
  }
  if (!/^[a-z0-9][a-z0-9._-]{2,29}$/.test(username)) {
    req.flash('error', 'Username hanya boleh huruf kecil, angka, titik, garis bawah, atau strip (3–30 karakter).');
    return res.redirect(kembali);
  }
  if (!ROLE_AKUN_PENDAFTAR.includes(role)) {
    req.flash('error', 'Peran akun pendaftar tidak valid.');
    return res.redirect(kembali);
  }
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
    req.flash('error', `Username ${username} sudah dipakai. Silakan ubah.`);
    return res.redirect(kembali);
  }

  const desa = db.prepare('SELECT id FROM desa ORDER BY id LIMIT 1').get();
  if (!desa) {
    req.flash('error', 'Data desa belum ada. Jalankan ulang aplikasi untuk menyiapkan data awal.');
    return res.redirect(kembali);
  }

  // Paket langganan: dari form (bisa diubah superadmin) atau pilihan pendaftar.
  const paketDiminta = Number(req.body.paket_id) || Number(row.paket_id) || null;
  const paket = paketDiminta ? paketById(paketDiminta) : daftarPaket({ hanyaAktif: true })[0];
  if (!paket) {
    req.flash('error', 'Paket langganan belum tersedia. Buat paket dulu di menu Paket Langganan.');
    return res.redirect(kembali);
  }

  try {
    // Setiap pendaftar mendapat ruang kerja sendiri (desa/tenant baru) agar
    // datanya terpisah dari pengelola lain dan dimulai dari kosong.
    const namaDusun = role === 'admin_dusun'
      ? (String(req.body.dusun_baru || '').trim() || row.usaha || nama)
      : 'Dusun Utama';
    const tenant = buatTenant(row, namaDusun, paket.id);
    audit(req, 'create', 'desa', tenant.desaId, `Ruang kerja ${row.nama} (pendaftaran #${id}) · paket ${paket.kode}`);
    audit(req, 'create', 'dusun', tenant.dusunId, `${namaDusun} (pendaftaran #${id})`);

    const info = db.prepare(`INSERT INTO users (desa_id, dusun_id, nama, username, password_hash, role, must_change_password)
      VALUES (?,?,?,?,?,?, 1)`).run(
      tenant.desaId, tenant.dusunId, nama, username, hashSandi(password), role
    );
    db.prepare("UPDATE pendaftaran_pengelola SET status = 'diterima', user_id = ? WHERE id = ?")
      .run(info.lastInsertRowid, id);
    audit(req, 'create', 'users', info.lastInsertRowid, `${username} (${role}) dari pendaftaran #${id}`);
    req.flash('success', `Akun ${username} (${ROLE_LABEL[role]}) untuk ${nama} berhasil dibuat dengan ruang kerja baru (data kosong) dan paket ${paket.nama}. Kata sandi sementara: ${password} — pengelola wajib menggantinya saat masuk pertama.`);
  } catch (err) {
    console.error('Gagal membuat akun:', err.message);
    req.flash('error', 'Gagal membuat akun. Periksa kembali data yang diisi.');
  }
  res.redirect(kembali);
});

// ---------------------------------------------------------------------------
// PAKET LANGGANAN
// ---------------------------------------------------------------------------

const angkaBatas = (v) => Math.max(0, Math.floor(Number(v) || 0));

function kodePaketDari(nama) {
  const dasar = String(nama || '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'PAKET';
  let kode = dasar;
  let urut = 1;
  while (db.prepare('SELECT 1 FROM paket WHERE kode = ?').get(kode)) {
    urut += 1;
    kode = `${dasar}-${urut}`;
  }
  return kode;
}

router.get('/superadmin/paket', requireRole('superadmin'), (req, res) => {
  const rows = db.prepare(`
    SELECT p.*, (SELECT COUNT(*) FROM desa d WHERE d.paket_id = p.id) AS pengelola
    FROM paket p ORDER BY p.urutan, p.harga, p.id
  `).all();
  res.render('superadmin/paket', {
    title: 'Paket Langganan',
    rows,
    totalAktif: rows.filter((p) => p.is_active).length,
    pendapatanPotensial: rows.filter((p) => p.is_active)
      .reduce((a, p) => a + Number(p.harga) * Number(p.pengelola), 0),
  });
});

router.post('/superadmin/paket', requireRole('superadmin'), (req, res) => {
  const nama = String(req.body.nama || '').trim();
  if (!nama) {
    req.flash('error', 'Nama paket wajib diisi.');
    return res.redirect('/superadmin/paket');
  }
  const kode = String(req.body.kode || '').trim().toUpperCase()
    || kodePaketDari(nama);
  try {
    const info = db.prepare(`INSERT INTO paket
      (kode, nama, deskripsi, harga, maks_pelanggan, maks_sumur, maks_dusun, urutan)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      kode, nama, String(req.body.deskripsi || '').trim() || null,
      angkaBatas(req.body.harga), angkaBatas(req.body.maks_pelanggan),
      angkaBatas(req.body.maks_sumur), angkaBatas(req.body.maks_dusun),
      angkaBatas(req.body.urutan) || 1
    );
    audit(req, 'create', 'paket', info.lastInsertRowid, `${kode} - ${nama}`);
    req.flash('success', `Paket ${nama} ditambahkan.`);
  } catch (err) {
    req.flash('error', `Gagal menambah paket: ${err.message}`);
  }
  res.redirect('/superadmin/paket');
});

router.post('/superadmin/paket/:id', requireRole('superadmin'), (req, res) => {
  const row = db.prepare('SELECT * FROM paket WHERE id = ?').get(Number(req.params.id));
  if (!row) {
    req.flash('error', 'Paket tidak ditemukan.');
    return res.redirect('/superadmin/paket');
  }
  const nama = String(req.body.nama || '').trim();
  if (!nama) {
    req.flash('error', 'Nama paket wajib diisi.');
    return res.redirect('/superadmin/paket');
  }
  const kode = String(req.body.kode || row.kode).trim().toUpperCase();
  try {
    db.prepare(`UPDATE paket SET kode = ?, nama = ?, deskripsi = ?, harga = ?,
      maks_pelanggan = ?, maks_sumur = ?, maks_dusun = ?, urutan = ? WHERE id = ?`).run(
      kode, nama, String(req.body.deskripsi || '').trim() || null,
      angkaBatas(req.body.harga), angkaBatas(req.body.maks_pelanggan),
      angkaBatas(req.body.maks_sumur), angkaBatas(req.body.maks_dusun),
      angkaBatas(req.body.urutan) || row.urutan, row.id
    );
    audit(req, 'update', 'paket', row.id, `${kode} - ${nama}`);
    req.flash('success', `Paket ${nama} diperbarui.`);
  } catch (err) {
    req.flash('error', `Gagal memperbarui paket: ${err.message}`);
  }
  res.redirect('/superadmin/paket');
});

router.post('/superadmin/paket/:id/toggle', requireRole('superadmin'), (req, res) => {
  const row = db.prepare('SELECT * FROM paket WHERE id = ?').get(Number(req.params.id));
  if (!row) {
    req.flash('error', 'Paket tidak ditemukan.');
    return res.redirect('/superadmin/paket');
  }
  const aktif = row.is_active ? 0 : 1;
  db.prepare('UPDATE paket SET is_active = ? WHERE id = ?').run(aktif, row.id);
  audit(req, 'update', 'paket', row.id, `${row.kode} → ${aktif ? 'aktif' : 'nonaktif'}`);
  req.flash('success', `Paket ${row.nama} ${aktif ? 'diaktifkan' : 'dinonaktifkan'}.`);
  res.redirect('/superadmin/paket');
});

// ---------------------------------------------------------------------------
// LANGGANAN PENGELOLA (paket tiap desa/tenant)
// ---------------------------------------------------------------------------

const STATUS_LANGGANAN = ['aktif', 'trial', 'ditangguhkan'];

/**
 * Hitung data operasional sebuah ruang kerja. Dipakai untuk memastikan
 * ruang kerja yang dihapus benar-benar kosong (hanya untuk membatalkan
 * pendaftaran ganda / salah buat).
 */
function jumlahDataOperasional(desaId) {
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM pelanggan WHERE desa_id = ?) +
      (SELECT COUNT(*) FROM periode_tagihan WHERE desa_id = ?) +
      (SELECT COUNT(*) FROM pendaftaran_pasang WHERE desa_id = ?) +
      (SELECT COUNT(*) FROM pembelian WHERE desa_id = ?) +
      (SELECT COUNT(*) FROM tagihan t JOIN dusun d ON d.id = t.dusun_id WHERE d.desa_id = ?) +
      (SELECT COUNT(*) FROM keluhan k JOIN dusun d ON d.id = k.dusun_id WHERE d.desa_id = ?) +
      (SELECT COUNT(*) FROM sumur s JOIN dusun d ON d.id = s.dusun_id WHERE d.desa_id = ?)
    AS total`).get(desaId, desaId, desaId, desaId, desaId, desaId, desaId);
  return row ? Number(row.total) : 0;
}

router.get('/superadmin/langganan', requireRole('superadmin'), (req, res) => {
  const rows = ringkasanSemuaDesa()
    .map((r) => ({ ...r, dataOperasional: jumlahDataOperasional(r.desa.id) }));
  // Setiap pengelola berbayar otomatis punya tagihan siklus berikutnya.
  rows.forEach((r) => tagihanLgn.pastikan(r.desa.id));
  res.render('superadmin/langganan', {
    title: 'Langganan Pengelola',
    rows,
    paketList: daftarPaket(),
    statusList: STATUS_LANGGANAN,
    tagihanTerbuka: tagihanLgn.daftarTerbuka(),
    ringkasTagihan: tagihanLgn.ringkas(),
    labelStatusTagihan: tagihanLgn.LABEL_STATUS,
    ringkas: {
      pengelola: rows.length,
      pendapatan: rows.filter((r) => r.paket && r.desa.status_langganan === 'aktif')
        .reduce((a, r) => a + Number(r.paket.harga), 0),
      perhatian: rows.filter((r) => r.peringatan.length > 0).length,
    },
  });
});

// Hapus ruang kerja ganda/kosong (mis. pendaftaran yang terkirim dua kali).
router.post('/superadmin/langganan/:desaId/hapus', requireRole('superadmin'), (req, res) => {
  const desa = db.prepare('SELECT * FROM desa WHERE id = ?').get(Number(req.params.desaId));
  if (!desa) {
    req.flash('error', 'Pengelola tidak ditemukan.');
    return res.redirect('/superadmin/langganan');
  }
  const total = jumlahDataOperasional(desa.id);
  if (total > 0) {
    req.flash('error', `Ruang kerja ${desa.nama} masih memiliki ${total} data operasional `
      + '(pelanggan/tagihan/sumur/dsb) sehingga tidak bisa dihapus. Nonaktifkan saja langganannya.');
    return res.redirect('/superadmin/langganan');
  }

  try {
    db.transaction(() => {
      const userIds = db.prepare('SELECT id FROM users WHERE desa_id = ?').all(desa.id).map((u) => u.id);
      if (userIds.length) {
        const tanda = userIds.map(() => '?').join(',');
        // Pendaftaran asal dilepas agar bisa diproses ulang bila perlu.
        db.prepare(`UPDATE pendaftaran_pengelola SET user_id = NULL WHERE user_id IN (${tanda})`)
          .run(...userIds);
        db.prepare(`DELETE FROM audit_log WHERE user_id IN (${tanda})`).run(...userIds);
        db.prepare(`DELETE FROM users WHERE id IN (${tanda})`).run(...userIds);
      }
      db.prepare('DELETE FROM tagihan_langganan WHERE desa_id = ?').run(desa.id);
      db.prepare(`DELETE FROM bahan_mutasi WHERE bahan_id IN
        (SELECT id FROM bahan WHERE desa_id = ?)`).run(desa.id);
      db.prepare('DELETE FROM bahan WHERE desa_id = ?').run(desa.id);
      db.prepare(`DELETE FROM tarif_blok WHERE golongan_id IN
        (SELECT id FROM golongan_tarif WHERE desa_id = ?)`).run(desa.id);
      db.prepare('DELETE FROM golongan_tarif WHERE desa_id = ?').run(desa.id);
      db.prepare('DELETE FROM dusun WHERE desa_id = ?').run(desa.id);
      db.prepare('DELETE FROM desa WHERE id = ?').run(desa.id);
    })();
    audit(req, 'delete', 'desa', desa.id, `Hapus ruang kerja ${desa.nama} (kosong)`);
    req.flash('success', `Ruang kerja ${desa.nama} dihapus.`);
  } catch (err) {
    req.flash('error', `Gagal menghapus ruang kerja: ${err.message}`);
  }
  res.redirect('/superadmin/langganan');
});

// Verifikasi / tolak pembayaran tagihan langganan yang dikirim pengelola.
router.post('/superadmin/langganan/tagihan/:id/verifikasi', requireRole('superadmin'), (req, res) => {
  const hasil = tagihanLgn.verifikasi(req.params.id, req.user.id, req.body.catatan_admin);
  if (hasil.ok) {
    audit(req, 'update', 'tagihan_langganan', Number(req.params.id), hasil.pesan);
    req.flash('success', `${hasil.pesan} Tagihan siklus berikutnya sudah disiapkan.`);
  } else {
    req.flash('error', hasil.pesan);
  }
  res.redirect('/superadmin/langganan');
});

router.post('/superadmin/langganan/tagihan/:id/tolak', requireRole('superadmin'), (req, res) => {
  const hasil = tagihanLgn.tolak(req.params.id, req.user.id, req.body.catatan_admin);
  if (hasil.ok) {
    audit(req, 'update', 'tagihan_langganan', Number(req.params.id), hasil.pesan);
    req.flash('success', hasil.pesan);
  } else {
    req.flash('error', hasil.pesan);
  }
  res.redirect('/superadmin/langganan');
});

router.post('/superadmin/langganan/:desaId', requireRole('superadmin'), (req, res) => {
  const desa = db.prepare('SELECT * FROM desa WHERE id = ?').get(Number(req.params.desaId));
  if (!desa) {
    req.flash('error', 'Pengelola tidak ditemukan.');
    return res.redirect('/superadmin/langganan');
  }
  const paketId = Number(req.body.paket_id) || null;
  if (paketId && !paketById(paketId)) {
    req.flash('error', 'Paket tidak valid.');
    return res.redirect('/superadmin/langganan');
  }
  const status = STATUS_LANGGANAN.includes(req.body.status_langganan)
    ? req.body.status_langganan : (desa.status_langganan || 'aktif');

  /**
   * Mode masa aktif (harga paket berlaku per bulan):
   * - reset   : mulai siklus baru 1 bulan dari hari ini
   * - 1/3/6/12: perpanjang N bulan dari tanggal berakhir (atau hari ini bila lewat)
   * - tetap   : pertahankan tanggal yang ada
   * Ganti paket tanpa memilih mode = otomatis reset 1 bulan.
   */
  const modeMentah = String(req.body.mode_masa_aktif || '').trim().toLowerCase();
  const gantiPaket = Number(paketId) !== Number(desa.paket_id);
  let mode = ['reset', 'tetap', '1', '3', '6', '12'].includes(modeMentah) ? modeMentah : '';
  if (!mode) {
    // Kompatibilitas dengan kiriman lama (perpanjang_bulan).
    const bulanLama = Math.floor(Number(req.body.perpanjang_bulan) || 0);
    mode = bulanLama > 0 ? String(bulanLama) : 'tetap';
  }
  if (gantiPaket && mode === 'tetap') mode = 'reset';

  const hariIni = new Date();
  let mulai = desa.langganan_mulai || formatISO(hariIni);
  let sampai = String(req.body.langganan_sampai || '').trim() || desa.langganan_sampai || null;
  let catatanMode = '';

  if (mode === 'reset') {
    const dasar = new Date(hariIni);
    dasar.setMonth(dasar.getMonth() + 1);
    mulai = formatISO(hariIni);
    sampai = formatISO(dasar);
    catatanMode = ' · siklus baru 1 bulan';
  } else if (mode !== 'tetap') {
    const bulan = Number(mode);
    const dasar = desa.langganan_sampai && new Date(`${desa.langganan_sampai}T00:00:00`) > hariIni
      ? new Date(`${desa.langganan_sampai}T00:00:00`)
      : new Date(hariIni);
    dasar.setMonth(dasar.getMonth() + bulan);
    sampai = formatISO(dasar);
    catatanMode = ` · +${bulan} bulan`;
  }

  if (sampai && !/^\d{4}-\d{2}-\d{2}$/.test(sampai)) {
    req.flash('error', 'Tanggal berakhir langganan tidak valid.');
    return res.redirect('/superadmin/langganan');
  }

  db.prepare(`UPDATE desa SET paket_id = ?, status_langganan = ?, langganan_mulai = ?, langganan_sampai = ?
    WHERE id = ?`).run(paketId, status, mulai, sampai, desa.id);
  // Siklus diperbarui manual → tagihan terbuka yang belum dibayar disegarkan.
  if (mode !== 'tetap') {
    tagihanLgn.batalkanTerbuka(desa.id, 'Dibatalkan otomatis: siklus diperbarui superadmin');
    tagihanLgn.pastikan(desa.id);
  }
  audit(req, 'update', 'desa', desa.id,
    `Langganan: paket ${paketId || '-'} · ${status}${catatanMode} · sampai ${sampai || '-'}`);
  req.flash('success', `Langganan ${desa.nama} diperbarui${catatanMode}.`);
  res.redirect('/superadmin/langganan');
});

// ---------------------------------------------------------------------------
// PERMINTAAN RESET PASSWORD (dari halaman /lupa-password)
// ---------------------------------------------------------------------------

router.get('/superadmin/reset-password', requireRole('superadmin'), (req, res) => {
  const filter = STATUS_RESET.includes(req.query.status) ? req.query.status : '';
  const rows = (filter
    ? db.prepare(`SELECT * FROM permintaan_reset WHERE status = ?
        ORDER BY created_at DESC, id DESC`).all(filter)
    : db.prepare('SELECT * FROM permintaan_reset ORDER BY created_at DESC, id DESC').all())
    .map((p) => ({ ...p, wa: waLink(p.whatsapp) }));

  const hitung = {};
  STATUS_RESET.forEach((status) => {
    hitung[status] = db.prepare('SELECT COUNT(*) AS n FROM permintaan_reset WHERE status = ?').get(status).n;
  });
  const total = db.prepare('SELECT COUNT(*) AS n FROM permintaan_reset').get().n;

  res.render('superadmin/reset-password', {
    title: 'Reset Password',
    rows,
    filter,
    hitung,
    total,
    statusReset: LABEL_RESET,
    statusOptions: STATUS_RESET,
  });
});

router.post('/superadmin/reset-password/:id/status', requireRole('superadmin'), (req, res) => {
  const id = Number(req.params.id);
  const status = String(req.body.status || '');
  const row = db.prepare('SELECT * FROM permintaan_reset WHERE id = ?').get(id);
  if (!row) {
    req.flash('error', 'Permintaan reset tidak ditemukan.');
    return res.redirect('/superadmin/reset-password');
  }
  if (!STATUS_RESET.includes(status)) {
    req.flash('error', 'Status permintaan tidak valid.');
    return res.redirect('/superadmin/reset-password');
  }
  db.prepare('UPDATE permintaan_reset SET status = ? WHERE id = ?').run(status, id);
  audit(req, 'update', 'permintaan_reset', id, `${row.username} → ${status}`);
  req.flash('success', `Permintaan reset ${row.username} ditandai ${LABEL_RESET[status]}.`);
  res.redirect('/superadmin/reset-password');
});

module.exports = router;
