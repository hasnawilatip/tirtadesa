'use strict';

/**
 * TOTP (RFC 6238) untuk autentikasi dua faktor, tanpa dependensi eksternal.
 * Kompatibel dengan Google Authenticator, Microsoft Authenticator, Authy, dll.
 */

const crypto = require('crypto');

const ALFABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const LANGKAH = 30;

function base32Encode(buffer) {
  let bit = 0;
  let nilai = 0;
  let hasil = '';
  for (const byte of buffer) {
    nilai = (nilai << 8) | byte;
    bit += 8;
    while (bit >= 5) {
      hasil += ALFABET[(nilai >>> (bit - 5)) & 31];
      bit -= 5;
    }
  }
  if (bit > 0) hasil += ALFABET[(nilai << (5 - bit)) & 31];
  return hasil;
}

function base32Decode(teks) {
  const bersih = String(teks || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bit = 0;
  let nilai = 0;
  const hasil = [];
  for (const huruf of bersih) {
    const indeks = ALFABET.indexOf(huruf);
    if (indeks < 0) continue;
    nilai = (nilai << 5) | indeks;
    bit += 5;
    if (bit >= 8) {
      hasil.push((nilai >>> (bit - 8)) & 255);
      bit -= 8;
    }
  }
  return Buffer.from(hasil);
}

function buatSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function kodePadaWaktu(secret, waktuMs = Date.now()) {
  const langkah = Math.floor(waktuMs / 1000 / LANGKAH);
  const penghitung = Buffer.alloc(8);
  penghitung.writeBigUInt64BE(BigInt(langkah));
  const kunci = base32Decode(secret);
  if (!kunci.length) return '';
  const hmac = crypto.createHmac('sha1', kunci).update(penghitung).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const biner = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return String(biner % 1000000).padStart(6, '0');
}

function samaAman(a, b) {
  const kiri = Buffer.from(String(a || ''));
  const kanan = Buffer.from(String(b || ''));
  if (kiri.length !== kanan.length || !kiri.length) return false;
  return crypto.timingSafeEqual(kiri, kanan);
}

function verifikasi(secret, masukan, jendela = 1) {
  const bersih = String(masukan || '').replace(/[\s-]/g, '');
  if (!/^\d{6}$/.test(bersih) || !secret) return false;
  for (let i = -jendela; i <= jendela; i += 1) {
    const kode = kodePadaWaktu(secret, Date.now() + (i * LANGKAH * 1000));
    if (kode && samaAman(kode, bersih)) return true;
  }
  return false;
}

function urlOtentikator(secret, akun, penerbit) {
  const issuer = String(penerbit || 'TirtaDesa');
  const label = `${issuer}:${akun}`;
  const parameter = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: String(LANGKAH),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${parameter.toString()}`;
}

/** Kode pemulihan sekali pakai: 8 kode format XXXXX-XXXXX. */
function buatKodePemulihan(jumlah = 8) {
  const daftar = [];
  while (daftar.length < jumlah) {
    const mentah = crypto.randomBytes(5).toString('hex').toUpperCase();
    daftar.push(`${mentah.slice(0, 5)}-${mentah.slice(5)}`);
  }
  return daftar;
}

function hashKodePemulihan(kode) {
  const bersih = String(kode || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return crypto.createHash('sha256').update(bersih).digest('hex');
}

/**
 * Cari kode pemulihan yang cocok.
 * @returns {number} indeks di daftar hash, atau -1 bila tidak ada
 */
function cocokKodePemulihan(daftarHash, kode) {
  const target = hashKodePemulihan(kode);
  if (!target) return -1;
  const daftar = Array.isArray(daftarHash) ? daftarHash : [];
  for (let i = 0; i < daftar.length; i += 1) {
    if (samaAman(target, String(daftar[i] || ''))) return i;
  }
  return -1;
}

module.exports = {
  LANGKAH,
  buatSecret,
  kodePadaWaktu,
  verifikasi,
  urlOtentikator,
  buatKodePemulihan,
  hashKodePemulihan,
  cocokKodePemulihan,
};
