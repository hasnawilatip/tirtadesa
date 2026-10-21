'use strict';

/**
 * Pencatatan pembayaran tagihan (kwitansi) yang dipakai bersama oleh
 * kasir (form tunai/transfer) dan verifikasi pembayaran online warga.
 */

const { db } = require('../db');
const { todayISO } = require('../helpers');

const METODE = ['tunai', 'transfer', 'qris', 'lain'];

function statusDari(total, terbayar, jatuhTempo) {
  if (terbayar >= total - 0.005) return 'lunas';
  if (terbayar > 0.005) return 'sebagian';
  if (jatuhTempo && jatuhTempo < todayISO()) return 'tunggakan';
  return 'belum_bayar';
}

function nomorKwitansiBerikutnya() {
  const tahun = new Date().getFullYear();
  const prefix = `KW/${tahun}/`;
  const row = db.prepare('SELECT nomor_kwitansi FROM pembayaran WHERE nomor_kwitansi LIKE ? ORDER BY id DESC LIMIT 1')
    .get(`${prefix}%`);
  let seq = row ? Number(row.nomor_kwitansi.slice(prefix.length)) + 1 : 1;
  let nomor = `${prefix}${String(seq).padStart(5, '0')}`;
  while (db.prepare('SELECT 1 FROM pembayaran WHERE nomor_kwitansi = ?').get(nomor)) {
    seq += 1;
    nomor = `${prefix}${String(seq).padStart(5, '0')}`;
  }
  return nomor;
}

/**
 * Simpan satu pembayaran valid ke sebuah tagihan.
 * @returns {number} id pembayaran (untuk kwitansi)
 */
function catatPembayaran({ tagihan, jumlah, metode = 'tunai', tanggal, userId, catatan }) {
  const nominal = Math.round((Number(jumlah) || 0) * 100) / 100;
  const cara = METODE.includes(metode) ? metode : 'tunai';
  return db.transaction(() => {
    const nomor = nomorKwitansiBerikutnya();
    const info = db.prepare(`INSERT INTO pembayaran
      (tagihan_id, nomor_kwitansi, tanggal_bayar, jumlah, metode, kasir_id, catatan, status)
      VALUES (?,?,?,?,?,?,?, 'valid')`).run(
      tagihan.id, nomor, String(tanggal || '').trim() || todayISO(), nominal, cara, userId || null,
      String(catatan || '').trim() || null
    );
    const terbayarBaru = Math.round((tagihan.terbayar + nominal) * 100) / 100;
    db.prepare('UPDATE tagihan SET terbayar = ?, status = ? WHERE id = ?')
      .run(terbayarBaru, terbayarBaru >= tagihan.total - 0.005 ? 'lunas' : 'sebagian', tagihan.id);
    return info.lastInsertRowid;
  })();
}

module.exports = { METODE, statusDari, nomorKwitansiBerikutnya, catatPembayaran };
