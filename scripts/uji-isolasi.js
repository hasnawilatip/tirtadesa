'use strict';

/**
 * Uji isolasi data antar pengelola (tenant) dan antar dusun.
 * Menyiapkan tenant kedua di database UJI, lalu memastikan tenant itu TIDAK
 * bisa membaca/mengubah data tenant pertama lewat URL berbasis ID.
 *
 * Cara pakai (JANGAN dijalankan di database demo/produksi):
 *   1) terminal A:
 *        $env:DB_PATH='G:\aplikasi PDAM\data\uji-isolasi.db'; $env:PORT='3100'; node server.js
 *   2) terminal B:
 *        node scripts/uji-isolasi.js
 */

process.env.DB_PATH = 'G:\\aplikasi PDAM\\data\\uji-isolasi.db';
const bcrypt = require('bcryptjs');
const { db, seedBahanDesa, DB_PATH } = require('../src/db');

if (/pdam\.db$/i.test(DB_PATH)) {
  console.error('Uji isolasi menolak berjalan di database utama (pdam.db). Gunakan database uji terpisah.');
  process.exit(1);
}
console.log('DB dipakai:', DB_PATH);

const BASE = 'http://localhost:3100';
let gagal = 0;
const hasil = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) gagal += 1;
};

const { buatKlien } = require('./klien-uji');

const H = { 'content-type': 'application/x-www-form-urlencoded' };
const badan = (obj) => {
  const p = new URLSearchParams();
  Object.entries(obj).forEach(([k, v]) => {
    if (Array.isArray(v)) v.forEach((x) => p.append(k, String(x)));
    else p.append(k, String(v));
  });
  return p.toString();
};

function siapkanTenantKedua() {
  const ada = db.prepare("SELECT desa_id FROM users WHERE username = 'admin2'").get();
  if (ada) return ada.desa_id;
  const desa = db.prepare(`INSERT INTO desa (nama, kecamatan, kabupaten, alamat, telepon)
    VALUES ('Desa Uji Kedua','Kec Uji','Kab Uji','Jl. Uji 2','0800')`).run();
  const desaId = Number(desa.lastInsertRowid);
  const gol = db.prepare(`INSERT INTO golongan_tarif
    (desa_id, kode, nama, abonemen, min_pemakaian_m3, denda_persen, denda_maks_persen)
    VALUES (?, 'RT', 'Rumah Tangga', 5000, 10, 0, 0)`).run(desaId);
  db.prepare(`INSERT INTO tarif_blok (golongan_id, blok_ke, dari_m3, sampai_m3, harga_per_m3)
    VALUES (?,1,0,10,1500)`).run(Number(gol.lastInsertRowid));
  const dusun = db.prepare('INSERT INTO dusun (desa_id, kode, nama) VALUES (?,?,?)')
    .run(desaId, 'D90', 'Dusun Uji Kedua');
  db.prepare(`INSERT INTO users (desa_id, dusun_id, nama, username, password_hash, role)
    VALUES (?,?,?,?,?, 'admin_desa')`).run(
    desaId, Number(dusun.lastInsertRowid), 'Admin Desa Kedua', 'admin2', bcrypt.hashSync('admin2123', 10)
  );
  seedBahanDesa(desaId);
  return desaId;
}

async function main() {
  const admin1 = buatKlien();
  if (!(await admin1.login('admin', 'admin123'))) throw new Error('login admin gagal');

  // Siapkan data milik desa 1: keluhan, produksi, pendaftaran pasang, pembelian draf.
  const setup = [
    ['/keluhan', { dusun_id: 1, kategori: 'kebocoran', deskripsi: 'Uji isolasi kebocoran pipa' }],
    ['/produksi', { sumur_id: 1, tanggal: '2026-10-19', meter_awal: 10, meter_akhir: 20 }],
    ['/pasang', { nama: 'Uji Isolasi', dusun_id: 1, tanggal_survei: '2026-10-19', aksi: 'draf' }],
    ['/pembelian', { tanggal: '2026-10-19', supplier: 'Toko Isolasi', 'bahan_id[]': 1, 'jumlah[]': 1, 'harga[]': 1000, aksi: 'draf' }],
  ];
  for (const [url, isi] of setup) {
    const res = await admin1.ambil(url, { method: 'POST', headers: H, body: badan(isi) });
    console.log(`setup POST ${url} → ${res.status} ${res.headers.get('location') || ''}`);
  }

  const ids = {
    pelanggan: db.prepare('SELECT id FROM pelanggan ORDER BY id LIMIT 1').get().id,
    sumur: db.prepare('SELECT id FROM sumur ORDER BY id LIMIT 1').get().id,
    bahan: db.prepare('SELECT id FROM bahan ORDER BY id LIMIT 1').get().id,
    tagihan: db.prepare('SELECT id FROM tagihan ORDER BY id LIMIT 1').get(),
    pembayaran: db.prepare('SELECT id FROM pembayaran ORDER BY id LIMIT 1').get(),
    pembacaan: db.prepare('SELECT id FROM pembacaan_meter ORDER BY id LIMIT 1').get(),
    keluhan: db.prepare('SELECT id FROM keluhan ORDER BY id DESC LIMIT 1').get().id,
    produksi: db.prepare('SELECT id FROM produksi_air ORDER BY id DESC LIMIT 1').get().id,
    pasang: db.prepare('SELECT id FROM pendaftaran_pasang ORDER BY id DESC LIMIT 1').get().id,
    pembelian: db.prepare('SELECT id FROM pembelian ORDER BY id DESC LIMIT 1').get().id,
    petugas: db.prepare("SELECT id FROM users WHERE username = 'petugas'").get().id,
    periode: db.prepare('SELECT id FROM periode_tagihan ORDER BY id LIMIT 1').get().id,
  };

  const desa2 = siapkanTenantKedua();
  hasil(desa2 > 0, 'Tenant kedua disiapkan', `desa ${desa2}`);

  const admin2 = buatKlien();
  hasil(await admin2.login('admin2', 'admin2123'), 'Login admin tenant kedua');

  const tolak = [
    ['GET', `/pelanggan/${ids.pelanggan}`, `/pelanggan/${ids.pelanggan}`],
    ['GET', `/pelanggan/${ids.pelanggan}/edit`, `/pelanggan/${ids.pelanggan}/edit`],
    ['POST', `/pelanggan/${ids.pelanggan}`, `/pelanggan/${ids.pelanggan}`],
    ['GET', `/sumur/${ids.sumur}/edit`, `/sumur/${ids.sumur}/edit`],
    ['POST', `/sumur/${ids.sumur}`, `/sumur/${ids.sumur}`],
    ['GET', `/tagihan/${ids.tagihan.id}`, `/tagihan/${ids.tagihan.id}`],
    ['GET', `/tagihan/${ids.tagihan.id}/cetak`, `/tagihan/${ids.tagihan.id}/cetak`],
    ['GET', `/kwitansi/${ids.pembayaran.id}`, `/kwitansi/${ids.pembayaran.id}`],
    ['POST', `/tagihan/${ids.tagihan.id}/bayar`, `/tagihan/${ids.tagihan.id}/bayar`],
    ['POST', `/pembayaran/${ids.pembayaran.id}/batal`, `/pembayaran/${ids.pembayaran.id}/batal`],
    ['POST', `/keluhan/${ids.keluhan}/status`, `/keluhan/${ids.keluhan}/status`],
    ['POST', `/produksi/${ids.produksi}/hapus`, `/produksi/${ids.produksi}/hapus`],
    ['GET', `/pasang/${ids.pasang}`, `/pasang/${ids.pasang}`],
  ];
  for (const [metode, url] of tolak) {
    const res = metode === 'GET'
      ? await admin2.ambil(url)
      : await admin2.ambil(url, { method: metode, headers: H, body: badan({}) });
    hasil(res.status === 403, `Tenant lain ditolak ${metode} ${url}`, `status ${res.status}`);
  }

  // Endpoint yang "tidak ditemukan" (redirect) karena filter desa.
  const dialihkan = [
    ['POST', `/pelanggan/${ids.pelanggan}/ganti-meter`],
    ['GET', `/bahan/${ids.bahan}`],
    ['POST', `/bahan/${ids.bahan}/stok`],
    ['GET', `/pembelian/${ids.pembelian}`],
    ['POST', `/pasang/${ids.pasang}/setujui`],
    ['POST', `/pengguna/${ids.petugas}/toggle`],
    ['POST', `/periode/${ids.periode}/verifikasi/${ids.pembacaan.id}`],
  ];
  for (const [metode, url] of dialihkan) {
    const res = metode === 'GET'
      ? await admin2.ambil(url)
      : await admin2.ambil(url, { method: metode, headers: H, body: badan({}) });
    hasil(res.status === 302, `Data tenant lain tidak ditemukan ${metode} ${url}`, `status ${res.status}`);
  }

  // Daftar & laporan tidak boleh memuat penanda data tenant pertama.
  await admin1.ambil('/bahan', {
    method: 'POST', headers: H,
    body: badan({ nama: 'Bahan Khusus Tenant Satu', kategori: 'alat', satuan: 'unit', stok: 1, stok_minimum: 1, harga_satuan: 1000 }),
  });
  const cek = async (url, penanda) => {
    const html = await (await admin2.ambil(url)).text();
    hasil(!html.includes(penanda), `Daftar ${url} tidak memuat data tenant lain`, `penanda "${penanda}"`);
  };
  await cek('/pelanggan', 'D01-0001');
  await cek('/bahan', 'Bahan Khusus Tenant Satu');
  await cek('/tagihan', 'D01-0001');
  await cek('/pembelian', 'Toko Isolasi');
  await cek('/pasang', 'Uji Isolasi');
  await cek('/keluhan', 'Uji isolasi kebocoran');
  await cek('/laporan', 'D01-');

  // Tenant kedua tetap bisa memakai datanya sendiri.
  const buatBahan = await admin2.ambil('/bahan', {
    method: 'POST', headers: H,
    body: badan({ nama: 'Bahan Tenant Dua', kategori: 'alat', satuan: 'unit', stok: 2, stok_minimum: 1, harga_satuan: 1000 }),
  });
  const daftar2 = await (await admin2.ambil('/bahan')).text();
  const daftar1 = await (await admin1.ambil('/bahan')).text();
  hasil(buatBahan.status === 302 && daftar2.includes('Bahan Tenant Dua'), 'Tenant kedua bisa menambah bahan sendiri');
  hasil(!daftar1.includes('Bahan Tenant Dua'), 'Bahan tenant kedua tidak terlihat oleh tenant pertama');

  // Warga tenant 1 tidak bisa membuka data pelanggan lain.
  const warga = buatKlien();
  await warga.login('warga', 'warga123');
  const wargaTagihan = await (await warga.ambil('/warga/tagihan')).text();
  const pelangganLain = db.prepare('SELECT nomor_pelanggan FROM pelanggan WHERE id <> (SELECT pelanggan_id FROM users WHERE username = \'warga\') LIMIT 1').get();
  hasil(!wargaTagihan.includes(pelangganLain.nomor_pelanggan), 'Warga hanya melihat tagihannya sendiri',
    `tidak memuat ${pelangganLain.nomor_pelanggan}`);

  console.log(`\n${gagal === 0 ? 'Semua uji isolasi LULUS.' : `${gagal} uji isolasi GAGAL.`}`);
  process.exit(gagal === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
