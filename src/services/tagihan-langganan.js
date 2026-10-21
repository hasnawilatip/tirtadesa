'use strict';

/**
 * Tagihan langganan (iuran bulanan pengelola ke penyedia layanan).
 *
 * Alur:
 * 1. Sistem membuat tagihan untuk **siklus berikutnya** (harga paket × 1 bulan)
 *    selama belum ada tagihan terbuka dan paketnya berbayar.
 * 2. Admin desa/dusun menekan **Bayar** di menu Langganan, memilih salah satu
 *    saluran pembayaran yang disediakan superadmin, lalu mengunggah bukti.
 * 3. Superadmin memverifikasi → tagihan lunas, masa aktif bertambah 1 bulan,
 *    dan tagihan siklus berikutnya dibuat otomatis.
 */

const { db } = require('../db');
const { todayISO, formatISO } = require('../helpers');
const { paketById } = require('./langganan');

const STATUS = ['belum_bayar', 'menunggu', 'lunas', 'batal'];

const LABEL_STATUS = {
  belum_bayar: 'Belum dibayar',
  menunggu: 'Menunggu verifikasi',
  lunas: 'Lunas',
  batal: 'Dibatalkan',
};

/** Tambah bulan dengan aman (mis. 31 Jan + 1 bulan → akhir Februari). */
function tambahBulan(tanggal, bulan = 1) {
  const d = new Date(`${String(tanggal).slice(0, 10)}T00:00:00`);
  const hari = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + bulan);
  const maks = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(hari, maks));
  return formatISO(d);
}

function nomorBerikutnya() {
  const tahun = new Date().getFullYear();
  const prefix = `LGN/${tahun}/`;
  const row = db.prepare('SELECT nomor FROM tagihan_langganan WHERE nomor LIKE ? ORDER BY id DESC LIMIT 1')
    .get(`${prefix}%`);
  let seq = row ? Number(row.nomor.slice(prefix.length)) + 1 : 1;
  let nomor = `${prefix}${String(seq).padStart(5, '0')}`;
  while (db.prepare('SELECT 1 FROM tagihan_langganan WHERE nomor = ?').get(nomor)) {
    seq += 1;
    nomor = `${prefix}${String(seq).padStart(5, '0')}`;
  }
  return nomor;
}

/** Siklus berikutnya dari sebuah desa: [akhir masa aktif, +1 bulan]. */
function siklusBerikutnya(desa) {
  const hariIni = todayISO();
  const dasar = desa.langganan_sampai && desa.langganan_sampai >= hariIni
    ? desa.langganan_sampai
    : hariIni;
  return { mulai: dasar, sampai: tambahBulan(dasar, 1) };
}

function terbukaUntuk(desaId) {
  return db.prepare(`SELECT * FROM tagihan_langganan
    WHERE desa_id = ? AND status IN ('belum_bayar','menunggu')
    ORDER BY id DESC LIMIT 1`).get(Number(desaId)) || null;
}

function byId(id) {
  return db.prepare(`SELECT tl.*, d.nama AS desa_nama
    FROM tagihan_langganan tl JOIN desa d ON d.id = tl.desa_id
    WHERE tl.id = ?`).get(Number(id)) || null;
}

function daftarUntuk(desaId, batas = 12) {
  return db.prepare(`SELECT * FROM tagihan_langganan WHERE desa_id = ?
    ORDER BY id DESC LIMIT ?`).all(Number(desaId), batas);
}

function daftarTerbuka(batas = 100) {
  return db.prepare(`SELECT tl.*, d.nama AS desa_nama
    FROM tagihan_langganan tl JOIN desa d ON d.id = tl.desa_id
    WHERE tl.status IN ('belum_bayar','menunggu')
    ORDER BY CASE tl.status WHEN 'menunggu' THEN 0 ELSE 1 END, tl.id DESC
    LIMIT ?`).all(batas);
}

/**
 * Pastikan ada tagihan terbuka untuk siklus berikutnya.
 * Tidak membuat tagihan bila paket gratis (harga 0) atau pengelola belum punya paket.
 */
function pastikan(desaId) {
  const desa = db.prepare('SELECT * FROM desa WHERE id = ?').get(Number(desaId));
  if (!desa || !desa.paket_id) return null;
  const paket = paketById(desa.paket_id);
  if (!paket) return null;

  const ada = terbukaUntuk(desa.id);
  if (ada) return ada;

  const jumlah = Number(paket.harga) || 0;
  if (jumlah <= 0) return null;

  const siklus = siklusBerikutnya(desa);
  const info = db.prepare(`INSERT INTO tagihan_langganan
    (desa_id, nomor, paket_id, paket_nama, periode_mulai, periode_sampai, jumlah, status)
    VALUES (?,?,?,?,?,?,?, 'belum_bayar')`).run(
    desa.id, nomorBerikutnya(), paket.id, paket.nama, siklus.mulai, siklus.sampai, jumlah
  );
  return byId(info.lastInsertRowid);
}

/** Bulatkan tagihan terbuka yang belum dibayar (mis. setelah ganti paket / perpanjangan manual). */
function batalkanTerbuka(desaId, alasan = 'Dibatalkan otomatis karena siklus diperbarui') {
  return db.prepare(`UPDATE tagihan_langganan SET status = 'batal', catatan_admin = ?
    WHERE desa_id = ? AND status = 'belum_bayar'`).run(alasan, Number(desaId)).changes;
}

/**
 * Tandai tagihan langganan lunas dan perpanjang masa aktif desa.
 * @returns {{ok:boolean, pesan:string, tagihan?:object, sampai?:string}}
 */
function verifikasi(id, userId, catatan) {
  const tag = byId(id);
  if (!tag) return { ok: false, pesan: 'Tagihan langganan tidak ditemukan.' };
  if (tag.status === 'lunas') return { ok: false, pesan: 'Tagihan ini sudah lunas.' };
  if (tag.status === 'batal') return { ok: false, pesan: 'Tagihan ini sudah dibatalkan.' };

  const desa = db.prepare('SELECT * FROM desa WHERE id = ?').get(tag.desa_id);
  let sampai = desa.langganan_sampai;
  if (!sampai || sampai < tag.periode_sampai) sampai = tag.periode_sampai;

  db.transaction(() => {
    db.prepare(`UPDATE tagihan_langganan
      SET status = 'lunas', divalidasi_oleh = ?, divalidasi_pada = datetime('now','localtime'),
          catatan_admin = COALESCE(?, catatan_admin)
      WHERE id = ?`).run(userId || null, String(catatan || '').trim() || null, tag.id);
    db.prepare(`UPDATE desa SET langganan_sampai = ?,
        status_langganan = CASE WHEN status_langganan = 'ditangguhkan' THEN 'aktif' ELSE status_langganan END
      WHERE id = ?`).run(sampai, desa.id);
  })();

  // Siapkan tagihan siklus berikutnya.
  pastikan(desa.id);
  return { ok: true, pesan: `Tagihan ${tag.nomor} lunas. Masa aktif sampai ${sampai}.`, tagihan: byId(tag.id), sampai };
}

/** Tolak bukti pembayaran: tagihan kembali berstatus belum dibayar. */
function tolak(id, userId, alasan) {
  const tag = byId(id);
  if (!tag) return { ok: false, pesan: 'Tagihan langganan tidak ditemukan.' };
  if (tag.status !== 'menunggu') {
    return { ok: false, pesan: 'Hanya pembayaran yang menunggu verifikasi yang bisa ditolak.' };
  }
  db.prepare(`UPDATE tagihan_langganan SET status = 'belum_bayar', divalidasi_oleh = ?,
      divalidasi_pada = datetime('now','localtime'), catatan_admin = ? WHERE id = ?`)
    .run(userId || null, String(alasan || '').trim() || 'Bukti pembayaran tidak sesuai', tag.id);
  return { ok: true, pesan: `Tagihan ${tag.nomor} dikembalikan ke belum dibayar.` };
}

/** Ringkasan untuk panel superadmin. */
function ringkas() {
  const row = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status = 'menunggu' THEN 1 ELSE 0 END), 0) AS menunggu,
      COALESCE(SUM(CASE WHEN status = 'belum_bayar' THEN 1 ELSE 0 END), 0) AS belum,
      COALESCE(SUM(CASE WHEN status = 'lunas' THEN jumlah ELSE 0 END), 0) AS diterima,
      COALESCE(SUM(CASE WHEN status IN ('belum_bayar','menunggu') THEN jumlah ELSE 0 END), 0) AS tertagih
    FROM tagihan_langganan`).get();
  return row;
}

module.exports = {
  STATUS,
  LABEL_STATUS,
  tambahBulan,
  siklusBerikutnya,
  terbukaUntuk,
  byId,
  daftarUntuk,
  daftarTerbuka,
  pastikan,
  batalkanTerbuka,
  verifikasi,
  tolak,
  ringkas,
};
