'use strict';

const { db } = require('../db');

const DEFAULT = {
  nama_aplikasi: 'TirtaDesa',
  tagline: 'Platform Pengelolaan Sumur Bor',
  logo_path: null,
  bayar_online_aktif: 1,
  bayar_online_info: null,
};

function ambilPengaturan() {
  const row = db.prepare('SELECT * FROM pengaturan WHERE id = 1').get();
  return row ? { ...DEFAULT, ...row } : { ...DEFAULT };
}

function simpanPengaturan(data = {}) {
  const gabung = { ...ambilPengaturan(), ...data };
  const aktif = Number(gabung.bayar_online_aktif) === 0 ? 0 : 1;
  db.prepare(`INSERT INTO pengaturan
      (id, nama_aplikasi, tagline, logo_path, bayar_online_aktif, bayar_online_info, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, datetime('now','localtime'))
    ON CONFLICT(id) DO UPDATE SET
      nama_aplikasi = excluded.nama_aplikasi,
      tagline = excluded.tagline,
      logo_path = excluded.logo_path,
      bayar_online_aktif = excluded.bayar_online_aktif,
      bayar_online_info = excluded.bayar_online_info,
      updated_at = excluded.updated_at`)
    .run(
      gabung.nama_aplikasi || DEFAULT.nama_aplikasi,
      gabung.tagline || DEFAULT.tagline,
      gabung.logo_path || null,
      aktif,
      gabung.bayar_online_info || null
    );
}

/** Inisial dari nama aplikasi, mis. "TirtaDesa" → "TD". */
function inisial(nama) {
  const kata = String(nama || '').trim().split(/\s+/).filter(Boolean);
  if (!kata.length) return 'TD';
  return (kata[0][0] + (kata[1] ? kata[1][0] : '')).toUpperCase();
}

module.exports = { DEFAULT, ambilPengaturan, simpanPengaturan, inisial };
