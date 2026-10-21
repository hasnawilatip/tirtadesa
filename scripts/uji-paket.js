'use strict';

/**
 * Uji paket langganan & kuota pada server uji terpisah.
 * Jalankan: $env:DB_PATH='...\uji-paket.db'; $env:PORT='3100'; node server.js
 * lalu:      node scripts/uji-paket.js
 */

process.env.DB_PATH = 'G:\\aplikasi PDAM\\data\\uji-paket.db';
const { db, DB_PATH } = require('../src/db');

if (/pdam\.db$/i.test(DB_PATH)) {
  console.error('Uji paket menolak berjalan di database utama (pdam.db). Gunakan database uji terpisah.');
  process.exit(1);
}
const BASE = 'http://localhost:3100';
let gagal = 0;
const hasil = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) gagal += 1;
};

const { buatKlien } = require('./klien-uji');

const H = { 'content-type': 'application/x-www-form-urlencoded' };
const badan = (obj) => new URLSearchParams(obj).toString();
const flash = (html) => {
  const m = /<div class="alert alert-([a-z]+)"[^>]*>([\s\S]*?)<\/div>/.exec(html);
  return m ? m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
};

async function main() {
  // 1) Halaman pendaftaran publik memuat pilihan paket.
  const anonim = buatKlien();
  const gabung = await (await anonim.ambil('/gabung')).text();
  hasil(gabung.includes('Pilih paket langganan') && gabung.includes('paket-kartu'),
    'Halaman /gabung menampilkan pilihan paket');
  const paketIds = [...gabung.matchAll(/name="paket_id" value="(\d+)"/g)].map((m) => m[1]);
  hasil(paketIds.length >= 3, 'Paket tampil sebagai kartu pilihan', `${paketIds.length} paket`);

  // 2) Pendaftaran tanpa paket ditolak.
  const tanpaPaket = await anonim.ambil('/gabung', {
    method: 'POST', headers: H,
    body: badan({
      jenis: 'individu', nama: 'Uji Tanpa Paket', whatsapp: '081200000001',
      nama_usaha: 'Usaha Uji', lokasi: 'Desa Uji',
    }),
  });
  hasil(tanpaPaket.status === 400, 'Pendaftaran tanpa paket ditolak', `status ${tanpaPaket.status}`);

  // 3) Pendaftaran dengan paket tersimpan.
  const paketGrowth = db.prepare("SELECT id FROM paket WHERE kode = 'GROWTH'").get();
  const daftar = await anonim.ambil('/gabung', {
    method: 'POST', headers: H,
    body: badan({
      jenis: 'individu', nama: 'Uji Paket Growth', whatsapp: '081200000002',
      nama_usaha: 'Sumur Uji Paket', lokasi: 'Desa Uji Paket', paket_id: paketGrowth.id,
    }),
  });
  const pendaftar = db.prepare("SELECT * FROM pendaftaran_pengelola WHERE whatsapp = '6281200000002'").get();
  hasil(daftar.status === 302 && pendaftar && pendaftar.paket_id === paketGrowth.id,
    'Paket pilihan pendaftar tersimpan', `paket ${pendaftar ? pendaftar.paket_id : '-'}`);

  // 4) Superadmin: kelola paket.
  const superadmin = buatKlien();
  hasil(await superadmin.login('superadmin', 'superadmin123'), 'Login superadmin');
  const halamanPaket = await superadmin.ambil('/superadmin/paket');
  const paketHtml = await halamanPaket.text();
  hasil(halamanPaket.status === 200 && paketHtml.includes('Paket Langganan') && paketHtml.includes('modalPaket'),
    'Superadmin punya menu paket dengan popup tambah');

  const buatPaket = await superadmin.ambil('/superadmin/paket', {
    method: 'POST', headers: H,
    body: badan({
      nama: 'Uji Kecil', kode: 'UJI', harga: 99000, urutan: 9,
      maks_pelanggan: 1, maks_sumur: 1, maks_dusun: 1, deskripsi: 'Paket uji kuota',
    }),
  });
  const paketUji = db.prepare("SELECT * FROM paket WHERE kode = 'UJI'").get();
  hasil(buatPaket.status === 302 && paketUji && paketUji.maks_pelanggan === 1,
    'Superadmin bisa menambah paket');

  const ubahPaket = await superadmin.ambil(`/superadmin/paket/${paketUji.id}`, {
    method: 'POST', headers: H,
    body: badan({
      nama: 'Uji Kecil', kode: 'UJI', harga: 120000, urutan: 9,
      maks_pelanggan: 1, maks_sumur: 1, maks_dusun: 1,
    }),
  });
  const paketUji2 = db.prepare('SELECT * FROM paket WHERE id = ?').get(paketUji.id);
  hasil(ubahPaket.status === 302 && paketUji2.harga === 120000, 'Superadmin bisa mengubah harga paket');

  // 5) Buat akun dari pendaftaran dengan paket pilihan pendaftar & paket custom.
  const akun = await superadmin.ambil(`/superadmin/pendaftaran/${pendaftar.id}/akun`, {
    method: 'POST', headers: H,
    body: badan({
      nama: 'Admin Paket Uji', username: 'adminpaket', password: 'rahasia123',
      role: 'admin_desa', paket_id: paketUji.id,
    }),
  });
  const desaBaru = db.prepare(`SELECT d.* FROM desa d JOIN users u ON u.desa_id = d.id
    WHERE u.username = 'adminpaket'`).get();
  hasil(akun.status === 302 && desaBaru && desaBaru.paket_id === paketUji.id,
    'Akun baru mendapat paket yang dipilih superadmin', `desa ${desaBaru ? desaBaru.id : '-'}`);
  hasil(Boolean(desaBaru && desaBaru.langganan_sampai), 'Masa langganan awal terisi',
    desaBaru ? desaBaru.langganan_sampai : '-');

  // 6) Panel langganan pengelola.
  const halamanLangganan = await superadmin.ambil('/superadmin/langganan');
  const langgananHtml = await halamanLangganan.text();
  hasil(halamanLangganan.status === 200 && langgananHtml.includes('Langganan Pengelola')
    && langgananHtml.includes('Admin Paket Uji'), 'Superadmin bisa memantau langganan pengelola');

  // 7) Kuota berlaku untuk admin baru (paket UJI: 1 sumur, 1 dusun, 1 pelanggan).
  const adminBaru = buatKlien();
  hasil(await adminBaru.login('adminpaket', 'rahasia123'), 'Login admin pengelola baru');
  const dusunId = db.prepare('SELECT id FROM dusun WHERE desa_id = ?').get(desaBaru.id).id;
  const golonganId = db.prepare('SELECT id FROM golongan_tarif WHERE desa_id = ?').get(desaBaru.id).id;

  const sumur1 = await adminBaru.ambil('/sumur', {
    method: 'POST', headers: H,
    body: badan({ dusun_id: dusunId, kode: 'SB-01', nama: 'Sumur Uji Satu' }),
  });
  const sumur2 = await adminBaru.ambil('/sumur', {
    method: 'POST', headers: H,
    body: badan({ dusun_id: dusunId, kode: 'SB-02', nama: 'Sumur Uji Dua' }),
  });
  const daftarSumur = await (await adminBaru.ambil('/sumur')).text();
  hasil(sumur1.status === 302 && daftarSumur.includes('Sumur Uji Satu'), 'Sumur pertama tersimpan');
  hasil(!daftarSumur.includes('Sumur Uji Dua') && flash(daftarSumur).includes('Kuota sumur'),
    'Sumur kedua ditolak karena kuota paket', flash(daftarSumur).slice(0, 90));

  const dusun2 = await adminBaru.ambil('/dusun', {
    method: 'POST', headers: H,
    body: badan({ nama: 'Dusun Kedua', kode: 'D02' }),
  });
  const daftarDusun = await (await adminBaru.ambil('/dusun')).text();
  hasil(dusun2.status === 302 && !daftarDusun.includes('Dusun Kedua'),
    'Dusun kedua ditolak karena kuota paket', flash(daftarDusun).slice(0, 90));

  // Pasang pelanggan pertama lolos, kedua kena kuota pelanggan.
  const buatPasang = async (nama) => {
    const res = await adminBaru.ambil('/pasang', {
      method: 'POST', headers: H,
      body: badan({
        nama, dusun_id: dusunId, golongan_id: golonganId, tanggal_survei: '2026-10-20', aksi: 'ajukan',
      }),
    });
    return Number((res.headers.get('location') || '').split('/').pop());
  };
  const idP1 = await buatPasang('Pelanggan Uji Satu');
  await adminBaru.ambil(`/pasang/${idP1}/setujui`, { method: 'POST', headers: H, body: badan({}) });
  await adminBaru.ambil(`/pasang/${idP1}/terpasang`, {
    method: 'POST', headers: H, body: badan({ tanggal_pasang: '2026-10-20' }),
  });
  const jumlahPelanggan = db.prepare('SELECT COUNT(*) AS n FROM pelanggan WHERE desa_id = ?').get(desaBaru.id).n;
  hasil(jumlahPelanggan === 1, 'Pelanggan pertama berhasil dipasang', `${jumlahPelanggan} pelanggan`);

  const idP2 = await buatPasang('Pelanggan Uji Dua');
  await adminBaru.ambil(`/pasang/${idP2}/setujui`, { method: 'POST', headers: H, body: badan({}) });
  await adminBaru.ambil(`/pasang/${idP2}/terpasang`, {
    method: 'POST', headers: H, body: badan({ tanggal_pasang: '2026-10-20' }),
  });
  const detail2 = await (await adminBaru.ambil(`/pasang/${idP2}`)).text();
  const jumlahSetelah = db.prepare('SELECT COUNT(*) AS n FROM pelanggan WHERE desa_id = ?').get(desaBaru.id).n;
  hasil(jumlahSetelah === 1 && flash(detail2).includes('Kuota pelanggan'),
    'Pelanggan kedua ditolak karena kuota paket', flash(detail2).slice(0, 90));

  // 8) Dashboard menampilkan kuota; peringatan kuota penuh hanya muncul saat aksi ditolak.
  const dash = await (await adminBaru.ambil('/')).text();
  hasil(dash.includes('Langganan &amp; kuota') || dash.includes('Langganan & kuota'),
    'Dashboard pengelola menampilkan kuota langganan');
  hasil(!dash.includes('Kuota pelanggan sudah penuh') && !dash.includes('Kuota sumur sudah penuh'),
    'Dashboard tidak menampilkan peringatan kuota penuh secara menetap');

  // 9) Perpanjangan & siklus bulanan saat ganti paket.
  const perpanjang = await superadmin.ambil(`/superadmin/langganan/${desaBaru.id}`, {
    method: 'POST', headers: H,
    body: badan({ paket_id: paketUji.id, status_langganan: 'aktif', mode_masa_aktif: '3' }),
  });
  const desaSetelah = db.prepare('SELECT * FROM desa WHERE id = ?').get(desaBaru.id);
  const selisih = Math.round((new Date(`${desaSetelah.langganan_sampai}T00:00:00`) - new Date()) / 86400000);
  hasil(perpanjang.status === 302 && selisih > 60,
    'Perpanjangan langganan menambah masa aktif', `${desaSetelah.langganan_sampai}`);

  // Ganti paket tanpa memilih mode → otomatis siklus baru 1 bulan.
  const paketGanti = db.prepare("SELECT id FROM paket WHERE kode = 'STARTER' AND id <> ?").get(paketUji.id)
    || db.prepare('SELECT id FROM paket WHERE id <> ? ORDER BY harga_bulanan DESC LIMIT 1').get(paketUji.id);
  await superadmin.ambil(`/superadmin/langganan/${desaBaru.id}`, {
    method: 'POST', headers: H,
    body: badan({ paket_id: paketGanti.id, status_langganan: 'aktif', mode_masa_aktif: 'tetap' }),
  });
  const desaGanti = db.prepare('SELECT * FROM desa WHERE id = ?').get(desaBaru.id);
  const selisihGanti = Math.round((new Date(`${desaGanti.langganan_sampai}T00:00:00`) - new Date()) / 86400000);
  hasil(desaGanti.paket_id === paketGanti.id && selisihGanti >= 27 && selisihGanti <= 32,
    'Ganti paket memulai siklus baru 1 bulan', `${desaGanti.langganan_sampai} (${selisihGanti} hari)`);

  console.log(`\n${gagal === 0 ? 'Semua uji paket LULUS.' : `${gagal} uji paket GAGAL.`}`);
  process.exit(gagal === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
