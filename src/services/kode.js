'use strict';

/**
 * Pembuat kode otomatis untuk data master.
 * Pola menjamin kode unik tanpa menyuruh pengguna mengetik sendiri.
 */

const { db } = require('../db');

function berikut(daftar, pola, prefix, lebar = 2) {
  let maks = 0;
  const dipakai = new Set();
  daftar.forEach((kode) => {
    const teks = String(kode || '').toUpperCase();
    dipakai.add(teks);
    const cocok = pola.exec(teks);
    if (cocok) maks = Math.max(maks, Number(cocok[1]));
  });
  let urut = maks + 1;
  let kode = `${prefix}${String(urut).padStart(lebar, '0')}`;
  while (dipakai.has(kode)) {
    urut += 1;
    kode = `${prefix}${String(urut).padStart(lebar, '0')}`;
  }
  return kode;
}

/** Kode sumur per dusun, contoh SB-01, SB-02. */
function kodeSumur(dusunId) {
  const rows = db.prepare('SELECT kode FROM sumur WHERE dusun_id = ?').all(Number(dusunId) || 0);
  return berikut(rows.map((r) => r.kode), /^SB-(\d+)$/, 'SB-', 2);
}

/** Kode dusun unik, contoh D04. */
function kodeDusun() {
  const rows = db.prepare('SELECT kode FROM dusun').all();
  return berikut(rows.map((r) => r.kode), /^D(\d+)$/, 'D', 2);
}

/** Kode golongan tarif per desa, contoh G1, G2. */
function kodeGolongan(desaId) {
  const rows = db.prepare('SELECT kode FROM golongan_tarif WHERE desa_id = ?').all(Number(desaId) || 0);
  return berikut(rows.map((r) => r.kode), /^G(\d+)$/, 'G', 0);
}

module.exports = { kodeSumur, kodeDusun, kodeGolongan };
