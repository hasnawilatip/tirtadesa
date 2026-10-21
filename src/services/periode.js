'use strict';

/**
 * Pengelolaan periode tagihan otomatis.
 * Periode bulan berjalan dibuat sendiri saat pengelola membuka aplikasi,
 * asalkan tidak ada periode lain yang masih terbuka.
 */

const { db } = require('../db');

function dua(n) {
  return String(n).padStart(2, '0');
}

/** Tanggal jatuh tempo tagihan setiap bulan (bulan berikutnya). */
const TANGGAL_JATUH_TEMPO = 20;

/** Tanggal terbit tagihan setiap bulan (bulan periode). */
const TANGGAL_TERBIT = 21;

/** Jatuh tempo bawaan: tanggal 20 bulan berikutnya. */
function jatuhTempoBawaan(tahun, bulan) {
  const berikut = bulan === 12 ? { tahun: tahun + 1, bulan: 1 } : { tahun, bulan: bulan + 1 };
  return `${berikut.tahun}-${dua(berikut.bulan)}-${dua(TANGGAL_JATUH_TEMPO)}`;
}

/**
 * Tanggal terbit tagihan: tanggal 21 bulan periode.
 * Bila tagihan diterbitkan sebelum tanggal tersebut, dipakai tanggal hari ini
 * agar tidak ada tagihan bertanggal masa depan.
 */
function tanggalTerbitBawaan(tahun, bulan, hariIni = new Date()) {
  const target = `${tahun}-${dua(bulan)}-${dua(TANGGAL_TERBIT)}`;
  const hari = `${hariIni.getFullYear()}-${dua(hariIni.getMonth() + 1)}-${dua(hariIni.getDate())}`;
  return target <= hari ? target : hari;
}

function periodeTerbuka(desaId) {
  return db.prepare(`SELECT * FROM periode_tagihan
    WHERE desa_id = ? AND status <> 'tutup'
    ORDER BY tahun DESC, bulan DESC LIMIT 1`).get(desaId);
}

/**
 * Pastikan desa punya periode berjalan.
 * - Belum punya periode sama sekali → buat periode bulan ini.
 * - Periode terakhir sudah ditutup → buat periode bulan berjalan.
 * - Bulan berjalan sudah pernah dibuat (walau sudah ditutup) → tidak membuat ulang.
 * - Masih ada periode terbuka dari bulan lalu → tidak membuat baru,
 *   hanya ditandai `usang` agar pengelola menutupnya dulu.
 */
function pastikanPeriodeBerjalan(desaId) {
  const sekarang = new Date();
  const tahun = sekarang.getFullYear();
  const bulan = sekarang.getMonth() + 1;

  const terbuka = periodeTerbuka(desaId);
  if (terbuka) {
    const usang = terbuka.tahun < tahun || (terbuka.tahun === tahun && terbuka.bulan < bulan);
    return { periode: terbuka, dibuat: false, usang };
  }

  const sudah = db.prepare('SELECT * FROM periode_tagihan WHERE desa_id = ? AND tahun = ? AND bulan = ?')
    .get(desaId, tahun, bulan);
  if (sudah) return { periode: sudah, dibuat: false, usang: false };

  const info = db.prepare(`INSERT INTO periode_tagihan (desa_id, tahun, bulan, tanggal_jatuh_tempo, status)
    VALUES (?,?,?,?, 'baca_meter')`).run(desaId, tahun, bulan, jatuhTempoBawaan(tahun, bulan));
  const periode = db.prepare('SELECT * FROM periode_tagihan WHERE id = ?').get(info.lastInsertRowid);
  return { periode, dibuat: true, usang: false };
}

module.exports = {
  pastikanPeriodeBerjalan,
  jatuhTempoBawaan,
  tanggalTerbitBawaan,
  periodeTerbuka,
  TANGGAL_JATUH_TEMPO,
  TANGGAL_TERBIT,
};
