'use strict';

/**
 * Migrasi satu kali: pindahkan akun hasil pendaftaran yang sebelumnya menempel
 * ke desa demo menjadi ruang kerja (desa) sendiri yang masih kosong.
 *
 * Pakai: node scripts/migrasi-tenant-pendaftar.js [username]
 * Default username: hasnawilatip
 */

const { db } = require('../src/db');
const { kodeDusun } = require('../src/services/kode');

const username = process.argv[2] || 'hasnawilatip';

function bagianLokasi(lokasi) {
  const bagian = String(lokasi || '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    desa: bagian[0] || null,
    kecamatan: (bagian.find((b) => /^kec\.?\s/i.test(b)) || '').replace(/^kec\.?\s*/i, '') || null,
    kabupaten: (bagian.find((b) => /^kab(upaten)?\.?\s/i.test(b)) || '').replace(/^kab(upaten)?\.?\s*/i, '') || null,
  };
}

const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
if (!user) {
  console.log(`Akun ${username} tidak ditemukan.`);
  process.exit(1);
}

const daftar = db.prepare('SELECT * FROM pendaftaran_pengelola WHERE user_id = ?').get(user.id);
if (!daftar) {
  console.log(`Akun ${username} tidak terhubung ke pendaftaran; tidak ada yang dimigrasikan.`);
  process.exit(0);
}

const jumlahDesa = db.prepare('SELECT COUNT(*) AS n FROM desa').get().n;
if (Number(user.desa_id) !== 1) {
  console.log(`Akun ${username} sudah berada di ruang kerja desa_id=${user.desa_id}. Tidak ada perubahan.`);
  process.exit(0);
}
console.log(`Menemukan ${jumlahDesa} desa; memindahkan ${username} ke ruang kerja baru.`);

const lokasi = bagianLokasi(daftar.lokasi);
const namaDesa = lokasi.desa || daftar.usaha || daftar.nama;

db.transaction(() => {
  const infoDesa = db.prepare(`INSERT INTO desa (nama, kecamatan, kabupaten, alamat, telepon)
    VALUES (?,?,?,?,?)`).run(
    namaDesa, lokasi.kecamatan, lokasi.kabupaten, daftar.lokasi || null, daftar.whatsapp || null
  );
  const desaId = Number(infoDesa.lastInsertRowid);

  const infoGolongan = db.prepare(`INSERT INTO golongan_tarif
    (desa_id, kode, nama, abonemen, min_pemakaian_m3, denda_persen, denda_maks_persen)
    VALUES (?, 'RT', 'Rumah Tangga', 5000, 10, 0, 0)`).run(desaId);
  [[1, 0, 10, 1500], [2, 10, 20, 2000], [3, 20, null, 2500]].forEach(([ke, dari, sampai, harga]) => {
    db.prepare(`INSERT INTO tarif_blok (golongan_id, blok_ke, dari_m3, sampai_m3, harga_per_m3)
      VALUES (?,?,?,?,?)`).run(infoGolongan.lastInsertRowid, ke, dari, sampai, harga);
  });

  const infoDusun = db.prepare('INSERT INTO dusun (desa_id, kode, nama) VALUES (?,?,?)')
    .run(desaId, kodeDusun(), daftar.usaha || namaDesa);

  db.prepare('UPDATE users SET desa_id = ?, dusun_id = ? WHERE id = ?')
    .run(desaId, Number(infoDusun.lastInsertRowid), user.id);

  console.log(`Akun ${username} dipindahkan ke desa_id=${desaId} (${namaDesa}) dengan dusun baru.`);
})();
