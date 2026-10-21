'use strict';

/**
 * Konfigurasi lingkungan terpusat.
 * - Membaca berkas `.env` bila ada (Node 20.12+).
 * - Secret sesi wajib eksplisit di produksi; di pengembangan dibuat sekali dan
 *   disimpan di `data/.session-secret` (mode 0600) agar sesi tetap hidup saat restart.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const STORAGE_DIR = path.join(ROOT_DIR, 'storage');
const ENV_PATH = path.join(ROOT_DIR, '.env');

if (typeof process.loadEnvFile === 'function' && fs.existsSync(ENV_PATH)) {
  try {
    process.loadEnvFile(ENV_PATH);
  } catch (err) {
    console.error(`Gagal membaca .env: ${err.message}`);
  }
}

const PRODUKSI = process.env.NODE_ENV === 'production';

function booleanEnv(nama, bawaan) {
  const nilai = process.env[nama];
  if (nilai === undefined || nilai === '') return bawaan;
  return ['1', 'true', 'yes', 'on'].includes(String(nilai).toLowerCase());
}

function ambilSessionSecret() {
  const dariEnv = String(process.env.SESSION_SECRET || '').trim();
  if (dariEnv) {
    if (dariEnv.length < 32) {
      throw new Error('SESSION_SECRET minimal 32 karakter. Buat nilai acak, mis. `openssl rand -hex 48`.');
    }
    return dariEnv;
  }

  if (PRODUKSI) {
    throw new Error(
      'SESSION_SECRET wajib diisi di NODE_ENV=production. '
      + 'Salin `.env.example` menjadi `.env` lalu isi SESSION_SECRET dengan nilai acak.',
    );
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const berkas = path.join(DATA_DIR, '.session-secret');
  try {
    const lama = fs.readFileSync(berkas, 'utf8').trim();
    if (lama.length >= 32) return lama;
  } catch (err) {
    // belum ada — buat baru di bawah
  }
  const baru = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(berkas, `${baru}\n`, { mode: 0o600 });
  return baru;
}

function trustProxy() {
  const mentah = String(process.env.TRUST_PROXY || '').trim();
  if (!mentah || mentah === '0' || mentah.toLowerCase() === 'false') return false;
  if (['1', 'true', 'yes', 'on'].includes(mentah.toLowerCase())) return 1;
  const angka = Number(mentah);
  return Number.isFinite(angka) ? angka : mentah;
}

const BCRYPT_ROUNDS = Math.min(14, Math.max(10, Number(process.env.BCRYPT_ROUNDS) || 12));

module.exports = {
  ROOT_DIR,
  DATA_DIR,
  STORAGE_DIR,
  ENV_PATH,
  PRODUKSI,
  SESSION_SECRET: ambilSessionSecret(),
  COOKIE_SECURE: booleanEnv('COOKIE_SECURE', PRODUKSI),
  TRUST_PROXY: trustProxy(),
  WAJIB_2FA: booleanEnv('WAJIB_2FA_SUPERADMIN', PRODUKSI),
  SEED_DEMO: booleanEnv('SEED_DEMO', !PRODUKSI),
  BCRYPT_ROUNDS,
};
