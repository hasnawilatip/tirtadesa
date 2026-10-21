'use strict';

/**
 * Cadangkan database SQLite dan seluruh berkas unggahan ke folder `backups/`.
 * Contoh pemakaian:
 *   node scripts/backup.js
 *   node scripts/backup.js --simpan 14
 * Jadwalkan lewat Task Scheduler / cron harian.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../src/config');

const DB_PATH = process.env.DB_PATH || path.join(config.DATA_DIR, 'pdam.db');
const FOLDER_BACKUP = path.join(config.ROOT_DIR, 'backups');

function argumen(nama, cadangan) {
  const indeks = process.argv.indexOf(nama);
  if (indeks === -1) return cadangan;
  const nilai = Number(process.argv[indeks + 1]);
  return Number.isFinite(nilai) && nilai > 0 ? nilai : cadangan;
}

function stempelWaktu() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function rotasi(simpan) {
  const daftar = fs.readdirSync(FOLDER_BACKUP)
    .map((nama) => path.join(FOLDER_BACKUP, nama))
    .filter((lokasi) => fs.statSync(lokasi).isDirectory())
    .sort()
    .reverse();
  daftar.slice(simpan).forEach((lokasi) => {
    fs.rmSync(lokasi, { recursive: true, force: true });
    console.log(`Backup lama dihapus: ${path.basename(lokasi)}`);
  });
}

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`Database tidak ditemukan: ${DB_PATH}`);
  }
  const simpan = argumen('--simpan', 7);
  const tujuan = path.join(FOLDER_BACKUP, stempelWaktu());
  fs.mkdirSync(tujuan, { recursive: true });

  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    await db.backup(path.join(tujuan, 'pdam.db'));
  } finally {
    db.close();
  }

  const unggah = path.join(config.STORAGE_DIR, 'uploads');
  if (fs.existsSync(unggah)) {
    fs.cpSync(unggah, path.join(tujuan, 'uploads'), { recursive: true });
  }

  rotasi(simpan);
  console.log(`Backup selesai: ${tujuan}`);
}

main().catch((err) => {
  console.error(`Backup gagal: ${err.message}`);
  process.exit(1);
});
