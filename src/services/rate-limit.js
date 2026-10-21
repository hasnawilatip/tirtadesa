'use strict';

/**
 * Pembatas laju (rate limit) berbasis SQLite agar bertahan setelah restart
 * dan konsisten bila aplikasi dijalankan lebih dari satu proses.
 *
 * Dipakai untuk:
 * - login (per pasangan IP+username, per akun, dan per IP),
 * - formulir publik (/gabung, /lupa-password),
 * - unggahan berkas.
 */

const { db } = require('../db');

const MAKS_GAGAL = 5;
const JEDA_MS = 15 * 60 * 1000;
const MAKS_AKUN = 10;
const MAKS_IP = 30;

let tabelSiap = false;

function pastikanTabel() {
  if (tabelSiap) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS rate_limit (
      kunci TEXT PRIMARY KEY,
      jumlah INTEGER NOT NULL DEFAULT 0,
      reset_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rate_limit_reset ON rate_limit(reset_at);
  `);
  tabelSiap = true;
}

function bersihkanKedaluwarsa() {
  pastikanTabel();
  db.prepare('DELETE FROM rate_limit WHERE reset_at <= ?').run(Date.now());
}

function lihat(kunci, batas, sekarang = Date.now()) {
  pastikanTabel();
  const baris = db.prepare('SELECT jumlah, reset_at FROM rate_limit WHERE kunci = ?').get(kunci);
  if (!baris || baris.reset_at <= sekarang) return { terpakai: 0, sisa: batas, detik: 0, diblokir: false };
  const terpakai = Number(baris.jumlah) || 0;
  return {
    terpakai,
    sisa: Math.max(0, batas - terpakai),
    detik: Math.ceil((baris.reset_at - sekarang) / 1000),
    diblokir: terpakai >= batas,
  };
}

function tambah(kunci, batas, jendelaMs, sekarang = Date.now()) {
  pastikanTabel();
  const baris = db.prepare('SELECT jumlah, reset_at FROM rate_limit WHERE kunci = ?').get(kunci);
  if (!baris || baris.reset_at <= sekarang) {
    db.prepare(`INSERT INTO rate_limit (kunci, jumlah, reset_at) VALUES (?, 1, ?)
      ON CONFLICT(kunci) DO UPDATE SET jumlah = 1, reset_at = excluded.reset_at`)
      .run(kunci, sekarang + jendelaMs);
    return { terpakai: 1, sisa: Math.max(0, batas - 1), detik: Math.ceil(jendelaMs / 1000), diblokir: false };
  }
  const terpakai = Math.min(Number(baris.jumlah) + 1, 999999);
  db.prepare('UPDATE rate_limit SET jumlah = ? WHERE kunci = ?').run(terpakai, kunci);
  return {
    terpakai,
    sisa: Math.max(0, batas - terpakai),
    detik: Math.ceil((baris.reset_at - sekarang) / 1000),
    diblokir: terpakai >= batas,
  };
}

function kosongkan(kunci) {
  pastikanTabel();
  db.prepare('DELETE FROM rate_limit WHERE kunci = ?').run(kunci);
}

function kunciPasangan(ip, username) {
  return `login:pasangan:${ip || '-'}|${String(username || '').trim().toLowerCase()}`;
}

function kunciAkun(username) {
  return `login:akun:${String(username || '').trim().toLowerCase()}`;
}

function kunciIp(ip) {
  return `login:ip:${ip || '-'}`;
}

function cekLogin(ip, username) {
  const status = [
    lihat(kunciPasangan(ip, username), MAKS_GAGAL),
    lihat(kunciAkun(username), MAKS_AKUN),
    lihat(kunciIp(ip), MAKS_IP),
  ];
  const diblokir = status.find((s) => s.diblokir);
  return {
    diblokir: Boolean(diblokir),
    sisaDetik: diblokir ? diblokir.detik : 0,
    sisaPercobaan: status[0].sisa,
  };
}

function gagalLogin(ip, username) {
  const pair = tambah(kunciPasangan(ip, username), MAKS_GAGAL, JEDA_MS);
  tambah(kunciAkun(username), MAKS_AKUN, JEDA_MS);
  tambah(kunciIp(ip), MAKS_IP, JEDA_MS);
  return {
    gagal: pair.terpakai,
    sisaPercobaan: pair.sisa,
    diblokir: pair.diblokir,
  };
}

function berhasilLogin(ip, username) {
  kosongkan(kunciPasangan(ip, username));
  kosongkan(kunciAkun(username));
}

/**
 * Middleware umum untuk membatasi endpoint tertentu.
 * @param {object} opsi
 * @param {(req:import('express').Request)=>string} opsi.kunci
 * @param {number} opsi.batas
 * @param {number} opsi.jendelaMs
 */
function middleware({ kunci, batas, jendelaMs, pesan }) {
  return (req, res, next) => {
    const hasil = tambah(kunci(req), batas, jendelaMs);
    if (!hasil.diblokir) return next();
    const menit = Math.max(1, Math.ceil(hasil.detik / 60));
    const teks = pesan || `Terlalu banyak permintaan. Coba lagi dalam ${menit} menit.`;
    if (req.accepts(['html', 'json']) === 'json') {
      return res.status(429).json({ error: teks });
    }
    if (!req.user) return res.status(429).type('text/plain').send(teks);
    return res.status(429).render('error', { title: 'Terlalu banyak permintaan', message: teks });
  };
}

module.exports = {
  MAKS_GAGAL,
  JEDA_MS,
  cekLogin,
  gagalLogin,
  berhasilLogin,
  lihat,
  tambah,
  kosongkan,
  middleware,
  bersihkanKedaluwarsa,
};
