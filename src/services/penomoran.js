'use strict';

/**
 * Pembuat nomor otomatis dokumen & pelanggan.
 * Dipakai bersama oleh master pelanggan dan pendaftaran pasang baru
 * agar polanya konsisten dan tidak ada duplikasi logika.
 */

const { buatSandiSementara } = require('./sandi');
const { db } = require('../db');

/** Nomor pelanggan berikutnya per dusun, contoh D01-0001. */
function nomorPelangganBaru(dusunId) {
  const dusun = db.prepare('SELECT kode FROM dusun WHERE id = ?').get(dusunId);
  const kode = dusun ? dusun.kode : 'D00';
  const rows = db.prepare(`
    SELECT nomor_pelanggan FROM pelanggan
    WHERE dusun_id = ? AND nomor_pelanggan LIKE ?
    ORDER BY id DESC LIMIT 1
  `).all(dusunId, `${kode}-%`);
  let seq = 1;
  if (rows.length) {
    const m = rows[0].nomor_pelanggan.match(/-(\d+)$/);
    if (m) seq = Number(m[1]) + 1;
  }
  let nomor = `${kode}-${String(seq).padStart(4, '0')}`;
  while (db.prepare(`SELECT 1 FROM pelanggan WHERE nomor_pelanggan = ?
    AND desa_id = (SELECT desa_id FROM dusun WHERE id = ?)`).get(nomor, dusunId)) {
    seq += 1;
    nomor = `${kode}-${String(seq).padStart(4, '0')}`;
  }
  return nomor;
}

/** Nomor meter berikutnya, format MTR-000001 (dibuat otomatis oleh sistem). */
function nomorMeterBaru() {
  const rows = db.prepare("SELECT nomor_meter FROM sambungan WHERE nomor_meter LIKE 'MTR-%'").all();
  let maks = 0;
  rows.forEach((r) => {
    const cocok = /^MTR-(\d+)$/.exec(r.nomor_meter);
    if (cocok) maks = Math.max(maks, Number(cocok[1]));
  });
  let urutan = maks + 1;
  let nomor = `MTR-${String(urutan).padStart(6, '0')}`;
  while (db.prepare('SELECT 1 FROM sambungan WHERE nomor_meter = ?').get(nomor)) {
    urutan += 1;
    nomor = `MTR-${String(urutan).padStart(6, '0')}`;
  }
  return nomor;
}

/** Nomor pendaftaran pasang baru per desa, contoh PSR-000001. */
function nomorPendaftaranBaru(desaId) {
  const rows = db.prepare('SELECT nomor FROM pendaftaran_pasang WHERE desa_id = ?').all(desaId);
  let maks = 0;
  rows.forEach((r) => {
    const cocok = /^PSR-(\d+)$/.exec(String(r.nomor || ''));
    if (cocok) maks = Math.max(maks, Number(cocok[1]));
  });
  let urutan = maks + 1;
  let nomor = `PSR-${String(urutan).padStart(6, '0')}`;
  while (db.prepare('SELECT 1 FROM pendaftaran_pasang WHERE nomor = ?').get(nomor)) {
    urutan += 1;
    nomor = `PSR-${String(urutan).padStart(6, '0')}`;
  }
  return nomor;
}

/** Nomor pembelian bahan per desa, contoh PB-000001. */
function nomorPembelianBaru(desaId) {
  const rows = db.prepare('SELECT nomor FROM pembelian WHERE desa_id = ?').all(desaId);
  let maks = 0;
  rows.forEach((r) => {
    const cocok = /^PB-(\d+)$/.exec(String(r.nomor || ''));
    if (cocok) maks = Math.max(maks, Number(cocok[1]));
  });
  let urutan = maks + 1;
  let nomor = `PB-${String(urutan).padStart(6, '0')}`;
  while (db.prepare('SELECT 1 FROM pembelian WHERE nomor = ?').get(nomor)) {
    urutan += 1;
    nomor = `PB-${String(urutan).padStart(6, '0')}`;
  }
  return nomor;
}

/** Nomor karyawan berikutnya per desa, contoh KRY-0001. */
function nomorKaryawanBaru(desaId) {
  const rows = db.prepare('SELECT nomor FROM karyawan WHERE desa_id = ?').all(desaId);
  let maks = 0;
  rows.forEach((r) => {
    const cocok = /^KRY-(\d+)$/.exec(String(r.nomor || ''));
    if (cocok) maks = Math.max(maks, Number(cocok[1]));
  });
  let urutan = maks + 1;
  let nomor = `KRY-${String(urutan).padStart(4, '0')}`;
  while (db.prepare('SELECT 1 FROM karyawan WHERE desa_id = ? AND nomor = ?').get(desaId, nomor)) {
    urutan += 1;
    nomor = `KRY-${String(urutan).padStart(4, '0')}`;
  }
  return nomor;
}

/** Nomor kasbon karyawan per desa, contoh KSB-0001. */
function nomorKasbonBaru(desaId) {
  const rows = db.prepare('SELECT nomor FROM kasbon WHERE desa_id = ?').all(desaId);
  let maks = 0;
  rows.forEach((r) => {
    const cocok = /^KSB-(\d+)$/.exec(String(r.nomor || ''));
    if (cocok) maks = Math.max(maks, Number(cocok[1]));
  });
  let urutan = maks + 1;
  let nomor = `KSB-${String(urutan).padStart(4, '0')}`;
  while (db.prepare('SELECT 1 FROM kasbon WHERE desa_id = ? AND nomor = ?').get(desaId, nomor)) {
    urutan += 1;
    nomor = `KSB-${String(urutan).padStart(4, '0')}`;
  }
  return nomor;
}

/** Nomor slip gaji per desa per tahun, contoh GJI-2026-0001. */
function nomorPenggajianBaru(desaId, tahun) {
  const rows = db.prepare('SELECT nomor FROM penggajian WHERE desa_id = ? AND tahun = ?').all(desaId, tahun);
  let maks = 0;
  rows.forEach((r) => {
    const cocok = new RegExp(`^GJI-${tahun}-(\\d+)$`).exec(String(r.nomor || ''));
    if (cocok) maks = Math.max(maks, Number(cocok[1]));
  });
  let urutan = maks + 1;
  let nomor = `GJI-${tahun}-${String(urutan).padStart(4, '0')}`;
  while (db.prepare('SELECT 1 FROM penggajian WHERE desa_id = ? AND nomor = ?').get(desaId, nomor)) {
    urutan += 1;
    nomor = `GJI-${tahun}-${String(urutan).padStart(4, '0')}`;
  }
  return nomor;
}

/** Kode bahan gudang berikutnya, contoh BHN-001. */
function kodeBahanBaru(desaId) {  const rows = db.prepare('SELECT kode FROM bahan WHERE desa_id = ?').all(desaId);
  let maks = 0;
  rows.forEach((r) => {
    const cocok = /^BHN-(\d+)$/.exec(String(r.kode || ''));
    if (cocok) maks = Math.max(maks, Number(cocok[1]));
  });
  let urutan = maks + 1;
  let kode = `BHN-${String(urutan).padStart(3, '0')}`;
  while (db.prepare('SELECT 1 FROM bahan WHERE desa_id = ? AND kode = ?').get(desaId, kode)) {
    urutan += 1;
    kode = `BHN-${String(urutan).padStart(3, '0')}`;
  }
  return kode;
}

/** Username akun warga: turunan nomor pelanggan (mis. D01-0001 → d010001), dijamin unik. */
function usernameAkunWarga(nomorPelanggan) {
  const dasar = String(nomorPelanggan || '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'warga';
  let calon = dasar;
  let urutan = 1;
  while (db.prepare('SELECT 1 FROM users WHERE username = ?').get(calon)) {
    urutan += 1;
    calon = `${dasar}${urutan}`;
  }
  return calon;
}

/** Kata sandi awal akun warga (12 karakter acak, huruf + angka). */
function passwordAkunWarga() {
  return buatSandiSementara(12);
}

module.exports = {
  nomorPelangganBaru,
  nomorMeterBaru,
  nomorPendaftaranBaru,
  nomorPembelianBaru,
  nomorKaryawanBaru,
  nomorKasbonBaru,
  nomorPenggajianBaru,
  kodeBahanBaru,
  usernameAkunWarga,
  passwordAkunWarga,
};
