'use strict';

/**
 * Pembayaran online warga.
 *
 * Alur:
 * 1. Superadmin mengatur **saluran bayar** (rekening transfer, QRIS, atau link
 *    halaman pembayaran milik penyedia/gateway) di menu Pembayaran Online.
 * 2. Warga menekan tombol **Bayar** pada tagihannya → memilih saluran →
 *    diarahkan ke instruksi/kanal pembayaran yang disediakan superadmin.
 * 3. Warga menekan "Saya sudah bayar" (opsional mengunggah bukti). Permintaan
 *    berstatus `menunggu` dengan kode referensi.
 * 4. Kasir/admin desa memverifikasi → otomatis menjadi kwitansi resmi
 *    (`pembayaran` valid) dan status tagihan diperbarui.
 */

const { db } = require('../db');
const { ambilPengaturan } = require('./pengaturan');

const JENIS_SALURAN = {
  transfer: 'Transfer Bank',
  qris: 'QRIS',
  link: 'Link Pembayaran',
};

const STATUS_ONLINE = {
  menunggu: 'Menunggu verifikasi',
  dikonfirmasi: 'Terkonfirmasi',
  ditolak: 'Ditolak',
};

const METODE_DARI_JENIS = { transfer: 'transfer', qris: 'qris', link: 'lain' };

/** Setelan global pembayaran online. */
function infoBayar() {
  const p = ambilPengaturan();
  return {
    aktif: Number(p.bayar_online_aktif) !== 0,
    catatan: p.bayar_online_info || '',
  };
}

function daftarSaluran({ semua = false } = {}) {
  const sql = semua
    ? 'SELECT * FROM saluran_bayar ORDER BY urutan, id'
    : 'SELECT * FROM saluran_bayar WHERE is_active = 1 ORDER BY urutan, id';
  return db.prepare(sql).all();
}

function saluranById(id) {
  if (!id) return null;
  return db.prepare('SELECT * FROM saluran_bayar WHERE id = ?').get(Number(id)) || null;
}

/** Kode referensi unik untuk warga, mis. BYR-2026-00012. */
function kodeBerikutnya() {
  const tahun = new Date().getFullYear();
  const prefix = `BYR-${tahun}-`;
  const row = db.prepare('SELECT kode FROM pembayaran_online WHERE kode LIKE ? ORDER BY id DESC LIMIT 1')
    .get(`${prefix}%`);
  let seq = row ? Number(row.kode.slice(prefix.length)) + 1 : 1;
  let kode = `${prefix}${String(seq).padStart(5, '0')}`;
  while (db.prepare('SELECT 1 FROM pembayaran_online WHERE kode = ?').get(kode)) {
    seq += 1;
    kode = `${prefix}${String(seq).padStart(5, '0')}`;
  }
  return kode;
}

/**
 * Isi placeholder pada link pembayaran milik superadmin.
 * Tersedia: {kode} {total} {tagihan} {pelanggan}
 */
function isiTemplate(teks, konteks = {}) {
  return String(teks || '')
    .replace(/\{kode\}/g, encodeURIComponent(konteks.kode || ''))
    .replace(/\{total\}/g, String(Math.round(Number(konteks.total) || 0)))
    .replace(/\{tagihan\}/g, encodeURIComponent(konteks.tagihan || ''))
    .replace(/\{pelanggan\}/g, encodeURIComponent(konteks.pelanggan || ''));
}

/** URL tujuan bila saluran berupa link (mis. checkout gateway). */
function urlPembayaran(saluran, konteks = {}) {
  if (!saluran || !saluran.url_bayar) return null;
  const url = isiTemplate(saluran.url_bayar, konteks);
  return /^https?:\/\//i.test(url) ? url : null;
}

/** Permintaan pembayaran yang masih menunggu verifikasi untuk satu tagihan. */
function menungguUntuk(tagihanId) {
  return db.prepare(`SELECT * FROM pembayaran_online
    WHERE tagihan_id = ? AND status = 'menunggu' ORDER BY id DESC LIMIT 1`)
    .get(Number(tagihanId)) || null;
}

/** Peta tagihan_id → permintaan menunggu, untuk penanda di daftar tagihan warga. */
function petaMenunggu(pelangganId) {
  const rows = db.prepare(`SELECT * FROM pembayaran_online
    WHERE pelanggan_id = ? AND status = 'menunggu' ORDER BY id DESC`).all(Number(pelangganId));
  const peta = {};
  rows.forEach((r) => { if (!peta[r.tagihan_id]) peta[r.tagihan_id] = r; });
  return peta;
}

/**
 * Buat (atau pakai ulang) permintaan pembayaran online.
 * @returns {{baru:boolean, row:object}}
 */
function buatPermintaan({ tagihan, pelanggan, saluran, jumlah, catatan }) {
  const ada = menungguUntuk(tagihan.id);
  if (ada) {
    db.prepare(`UPDATE pembayaran_online
      SET saluran_id = ?, jumlah = ?, catatan_warga = ?, updated_at = datetime('now','localtime')
      WHERE id = ?`).run(
      saluran ? saluran.id : null,
      Math.round((Number(jumlah) || 0) * 100) / 100,
      String(catatan || '').trim() || null,
      ada.id
    );
    return { baru: false, row: ambilByKode(ada.kode) };
  }
  const kode = kodeBerikutnya();
  const info = db.prepare(`INSERT INTO pembayaran_online
    (kode, tagihan_id, pelanggan_id, desa_id, dusun_id, saluran_id, jumlah, status, catatan_warga)
    VALUES (?,?,?,?,?,?,?, 'menunggu', ?)`).run(
    kode, tagihan.id, pelanggan.id, pelanggan.desa_id, tagihan.dusun_id || pelanggan.dusun_id,
    saluran ? saluran.id : null,
    Math.round((Number(jumlah) || 0) * 100) / 100,
    String(catatan || '').trim() || null
  );
  return { baru: true, row: ambilById(info.lastInsertRowid) };
}

function ambilById(id) {
  return db.prepare('SELECT * FROM pembayaran_online WHERE id = ?').get(Number(id)) || null;
}

function ambilByKode(kode) {
  return db.prepare('SELECT * FROM pembayaran_online WHERE kode = ?').get(String(kode)) || null;
}

/** Ringkasan untuk badge menu / dasbor. */
function ringkas({ desaId = null, dusunId = null } = {}) {
  let where = 'WHERE 1=1';
  const params = [];
  if (desaId) { where += ' AND desa_id = ?'; params.push(desaId); }
  if (dusunId) { where += ' AND dusun_id = ?'; params.push(dusunId); }
  const row = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status = 'menunggu' THEN 1 ELSE 0 END), 0) AS menunggu,
      COALESCE(SUM(CASE WHEN status = 'menunggu' THEN jumlah ELSE 0 END), 0) AS nilai_menunggu,
      COALESCE(SUM(CASE WHEN status = 'dikonfirmasi' THEN 1 ELSE 0 END), 0) AS dikonfirmasi,
      COUNT(*) AS total
    FROM pembayaran_online ${where}`).get(...params);
  return row;
}

module.exports = {
  JENIS_SALURAN,
  STATUS_ONLINE,
  METODE_DARI_JENIS,
  infoBayar,
  daftarSaluran,
  saluranById,
  kodeBerikutnya,
  isiTemplate,
  urlPembayaran,
  menungguUntuk,
  petaMenunggu,
  buatPermintaan,
  ambilById,
  ambilByKode,
  ringkas,
};
