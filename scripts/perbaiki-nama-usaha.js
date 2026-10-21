'use strict';
/**
 * Perbaikan data: ruang kerja dari pendaftaran jenis "individu/usaha" sebelumnya
 * dinamai dari wilayah ("Desa X"), seharusnya memakai nama usaha pendaftar.
 * Jalankan sekali: node scripts/perbaiki-nama-usaha.js
 */
const { db } = require('../src/db');

const daftar = db.prepare(`
  SELECT p.id, p.usaha, p.jenis, u.desa_id, d.nama AS nama_desa
  FROM pendaftaran_pengelola p
  JOIN users u ON u.id = p.user_id
  JOIN desa d ON d.id = u.desa_id
  WHERE p.jenis = 'individu' AND p.usaha IS NOT NULL AND p.usaha <> ''
`).all();

let diubah = 0;
daftar.forEach((r) => {
  if (!/^desa\s/i.test(r.nama_desa)) return; // sudah benar / bukan hasil wilayah
  db.prepare('UPDATE desa SET nama = ? WHERE id = ?').run(r.usaha, r.desa_id);
  console.log(`desa #${r.desa_id}: "${r.nama_desa}" → "${r.usaha}"`);
  diubah += 1;
});
console.log(diubah ? `${diubah} nama ruang kerja diperbaiki.` : 'Tidak ada yang perlu diperbaiki.');

const ringkas = db.prepare(`
  SELECT d.id, d.nama,
    (SELECT COUNT(*) FROM pelanggan WHERE desa_id = d.id) AS pelanggan,
    (SELECT COUNT(*) FROM tagihan t JOIN dusun du ON du.id = t.dusun_id WHERE du.desa_id = d.id) AS tagihan,
    (SELECT COUNT(*) FROM users WHERE desa_id = d.id) AS users
  FROM desa d ORDER BY d.id
`).all();
console.log(ringkas);
