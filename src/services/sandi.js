'use strict';

/**
 * Kebijakan & utilitas kata sandi.
 * - Minimal 8 karakter, memuat huruf dan angka.
 * - Menolak sandi umum, sandi yang sama dengan username, atau memuat nama akun.
 * - Hash bcrypt dengan biaya yang dapat diatur (default 12).
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { BCRYPT_ROUNDS } = require('../config');

const SANDI_UMUM = new Set([
  'password', 'password1', 'password123', 'passw0rd', 'qwerty123', 'qwertyuiop',
  '12345678', '123456789', '1234567890', 'admin123', 'admin1234', 'admin12345',
  'superadmin', 'superadmin123', 'warga123', 'petugas123', 'kasir123', 'krajan123',
  'tirtadesa', 'tirtadesa123', 'pdam1234', 'pdam2026', 'indonesia1', 'iloveyou1',
]);

function validasiSandi(sandi, { username = '', nama = '' } = {}) {
  const teks = String(sandi || '');
  if (teks.length < 8) return 'Kata sandi minimal 8 karakter.';
  if (teks.length > 72) return 'Kata sandi maksimal 72 karakter.';
  if (!/[A-Za-z]/.test(teks)) return 'Kata sandi harus memuat huruf.';
  if (!/[0-9]/.test(teks)) return 'Kata sandi harus memuat angka.';
  const kecil = teks.toLowerCase();
  if (SANDI_UMUM.has(kecil)) return 'Kata sandi terlalu mudah ditebak. Pilih kombinasi lain.';
  const user = String(username || '').trim().toLowerCase();
  if (user.length >= 3 && kecil.includes(user)) {
    return 'Kata sandi tidak boleh memuat username.';
  }
  const namaBersih = String(nama || '').trim().toLowerCase();
  if (namaBersih.length >= 4 && kecil.includes(namaBersih)) {
    return 'Kata sandi tidak boleh memuat nama akun.';
  }
  return null;
}

function hashSandi(sandi) {
  return bcrypt.hashSync(String(sandi), BCRYPT_ROUNDS);
}

function cocokSandi(sandi, hash) {
  try {
    return bcrypt.compareSync(String(sandi), String(hash || ''));
  } catch (err) {
    return false;
  }
}

/** Sandi sementara acak yang memenuhi kebijakan (12 karakter, ada huruf besar/kecil & angka). */
function buatSandiSementara(panjang = 12) {
  const huruf = 'abcdefghjkmnpqrstuvwxyz';
  const besar = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  const angka = '23456789';
  const semua = `${huruf}${besar}${angka}`;
  const hasil = [
    huruf[crypto.randomInt(huruf.length)],
    besar[crypto.randomInt(besar.length)],
    angka[crypto.randomInt(angka.length)],
  ];
  while (hasil.length < Math.max(10, panjang)) {
    hasil.push(semua[crypto.randomInt(semua.length)]);
  }
  for (let i = hasil.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [hasil[i], hasil[j]] = [hasil[j], hasil[i]];
  }
  return hasil.join('');
}

module.exports = {
  SANDI_UMUM,
  validasiSandi,
  hashSandi,
  cocokSandi,
  buatSandiSementara,
};
