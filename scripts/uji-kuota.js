'use strict';

/**
 * Uji penegakan kuota paket langganan (pelanggan, sumur, dusun).
 * Fokus: batas paket tidak bisa dilewati, termasuk lewat aktif/nonaktif pelanggan.
 *
 * Jalankan server uji lebih dulu:
 *   $env:DB_PATH='G:\aplikasi PDAM\data\uji-kuota.db'; $env:PORT='3100'; node server.js
 * lalu:
 *   node scripts/uji-kuota.js
 */

process.env.DB_PATH = 'G:\\aplikasi PDAM\\data\\uji-kuota.db';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db, DB_PATH } = require('../src/db');

if (/pdam\.db$/i.test(DB_PATH)) {
  console.error('Uji ini menolak berjalan di database utama (pdam.db). Gunakan database uji terpisah.');
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
const pesanFlash = (html) => {
  const m = /<div class="alert alert-[a-z]+"[^>]*>([\s\S]*?)<\/div>/.exec(html);
  return m ? m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
};

/** Siapkan pengelola uji dengan paket berbatas 1 pelanggan / 1 sumur / 1 dusun. */
function siapkanTenant() {
  const paket = db.prepare("SELECT * FROM paket WHERE kode = 'KUJI'").get();
  const paketId = paket
    ? paket.id
    : db.prepare(`INSERT INTO paket (kode, nama, deskripsi, harga, maks_pelanggan, maks_sumur, maks_dusun, urutan)
        VALUES ('KUJI', 'Uji Kuota', 'Batas 1 untuk pengujian', 100000, 1, 1, 1, 9)`).run().lastInsertRowid;

  db.prepare("DELETE FROM users WHERE username = 'adminkuota'").run();
  db.prepare("DELETE FROM desa WHERE nama = 'Desa Kuota Uji'").run();

  const desaId = db.prepare(`INSERT INTO desa (nama, kecamatan, paket_id, langganan_mulai, langganan_sampai, status_langganan)
    VALUES ('Desa Kuota Uji', 'Kec. Uji', ?, date('now','localtime'), date('now','localtime','+30 day'), 'aktif')`)
    .run(paketId).lastInsertRowid;

  const dusunId = db.prepare("INSERT INTO dusun (desa_id, kode, nama) VALUES (?, 'K01', 'Dusun Satu')")
    .run(desaId).lastInsertRowid;
  const sumurId = db.prepare("INSERT INTO sumur (dusun_id, kode, nama, status) VALUES (?, 'SB-01', 'Sumur Satu', 'aktif')")
    .run(dusunId).lastInsertRowid;
  const golId = db.prepare(`INSERT INTO golongan_tarif (desa_id, kode, nama, abonemen)
    VALUES (?, 'RT', 'Rumah Tangga', 5000)`).run(desaId).lastInsertRowid;

  const hash = bcrypt.hashSync('kuota123', 10);
  db.prepare(`INSERT INTO users (desa_id, dusun_id, nama, username, password_hash, role, is_active)
    VALUES (?, ?, 'Admin Kuota', 'adminkuota', ?, 'admin_desa', 1)`).run(desaId, dusunId, hash);

  return { desaId, dusunId, sumurId, golId, paketId };
}

/** Buat pendaftaran pasang berstatus disetujui (langsung, tanpa lewat formulir). */
function pendaftaranDisetujui(env, nama) {
  const nomor = `PSR/2026/${crypto.randomInt(100000, 999999)}`;
  return db.prepare(`INSERT INTO pendaftaran_pasang
    (desa_id, nomor, dusun_id, sumur_id, golongan_id, nama, alamat, ukuran_pipa, status)
    VALUES (?,?,?,?,?,?, 'Alamat uji', '1/2 inci', 'disetujui')`)
    .run(env.desaId, nomor, env.dusunId, env.sumurId, env.golId, nama).lastInsertRowid;
}

async function terpasang(klien, id) {
  const res = await klien.ambil(`/pasang/${id}/terpasang`, {
    method: 'POST', headers: H,
    body: badan({ golongan_id: db.prepare('SELECT golongan_id FROM pendaftaran_pasang WHERE id = ?').get(id).golongan_id, sumur_id: '' }),
  });
  const html = res.status === 302 ? await (await klien.ambil('/pasang')).text() : await res.text();
  return { status: res.status, pesan: pesanFlash(html) };
}

async function main() {
  const env = siapkanTenant();

  const admin = buatKlien();
  hasil(await admin.login('adminkuota', 'kuota123'), 'Login admin pengelola uji');

  // 1) Pelanggan pertama boleh (kuota 1).
  const p1 = pendaftaranDisetujui(env, 'Pelanggan Satu');
  const r1 = await terpasang(admin, p1);
  const jumlah1 = db.prepare('SELECT COUNT(*) AS n FROM pelanggan WHERE desa_id = ?').get(env.desaId).n;
  hasil(r1.status === 302 && jumlah1 === 1, 'Pelanggan pertama masuk (kuota 1/1)', `${jumlah1} pelanggan`);

  // 2) Pelanggan kedua harus ditolak.
  const p2 = pendaftaranDisetujui(env, 'Pelanggan Dua');
  const r2 = await terpasang(admin, p2);
  const jumlah2 = db.prepare('SELECT COUNT(*) AS n FROM pelanggan WHERE desa_id = ?').get(env.desaId).n;
  hasil(jumlah2 === 1 && /kuota pelanggan/i.test(r2.pesan),
    'Pelanggan kedua ditolak karena kuota paket', r2.pesan || '(tanpa pesan)');
  const statusP2 = db.prepare('SELECT status FROM pendaftaran_pasang WHERE id = ?').get(p2).status;
  hasil(statusP2 === 'disetujui', 'Pendaftaran yang ditolak kuota tidak berubah status', statusP2);

  // 3) Longkang aktif/nonaktif: nonaktifkan pelanggan 1 lalu tambah pelanggan 2.
  const pelanggan1 = db.prepare('SELECT * FROM pelanggan WHERE desa_id = ?').get(env.desaId);
  const nonaktif = await admin.ambil(`/pelanggan/${pelanggan1.id}`, {
    method: 'POST', headers: H,
    body: badan({ nama: pelanggan1.nama, golongan_id: env.golId, status: 'nonaktif' }),
  });
  const statusSetelah = db.prepare('SELECT status FROM pelanggan WHERE id = ?').get(pelanggan1.id).status;
  hasil(nonaktif.status === 302 && statusSetelah === 'nonaktif', 'Pelanggan dapat dinonaktifkan');

  const r3 = await terpasang(admin, p2);
  const jumlah3 = db.prepare("SELECT COUNT(*) AS n FROM pelanggan WHERE desa_id = ? AND status <> 'nonaktif'")
    .get(env.desaId).n;
  hasil(jumlah3 === 1, 'Slot kuota terpakai setelah pelanggan lama dinonaktifkan', `${jumlah3} aktif`);

  // 4) Mengaktifkan kembali pelanggan lama harus ditolak (kuota penuh).
  const aktifkan = await admin.ambil(`/pelanggan/${pelanggan1.id}`, {
    method: 'POST', headers: H,
    body: badan({ nama: pelanggan1.nama, golongan_id: env.golId, status: 'aktif' }),
  });
  const halamanEdit = await (await admin.ambil('/pelanggan')).text();
  const statusAkhir = db.prepare('SELECT status FROM pelanggan WHERE id = ?').get(pelanggan1.id).status;
  hasil(aktifkan.status === 302 && statusAkhir === 'nonaktif' && /kuota pelanggan/i.test(pesanFlash(halamanEdit)),
    'Aktivasi ulang ditolak saat kuota penuh', statusAkhir);

  // 5) Kuota sumur & dusun juga ditegakkan.
  const sumurKedua = await admin.ambil('/sumur', {
    method: 'POST', headers: H,
    body: badan({ dusun_id: env.dusunId, nama: 'Sumur Dua', kapasitas_lps: 5, status: 'aktif' }),
  });
  const jumlahSumur = db.prepare(`SELECT COUNT(*) AS n FROM sumur s JOIN dusun d ON d.id = s.dusun_id
    WHERE d.desa_id = ?`).get(env.desaId).n;
  const htmlSumur = await (await admin.ambil('/sumur')).text();
  hasil(sumurKedua.status === 302 && jumlahSumur === 1 && /kuota sumur/i.test(pesanFlash(htmlSumur)),
    'Sumur kedua ditolak karena kuota paket');

  const dusunKedua = await admin.ambil('/dusun', {
    method: 'POST', headers: H,
    body: badan({ nama: 'Dusun Dua', kepala_dusun: 'Uji', is_active: '1' }),
  });
  const jumlahDusun = db.prepare('SELECT COUNT(*) AS n FROM dusun WHERE desa_id = ?').get(env.desaId).n;
  const htmlDusun = await (await admin.ambil('/dusun')).text();
  hasil(dusunKedua.status === 302 && jumlahDusun === 1 && /kuota dusun/i.test(pesanFlash(htmlDusun)),
    'Dusun kedua ditolak karena kuota paket');

  // 6) Setelah paket diperbesar superadmin, penambahan kembali diizinkan.
  const superadmin = buatKlien();
  await superadmin.login('superadmin', 'superadmin123');
  db.prepare('UPDATE paket SET maks_pelanggan = 3 WHERE id = ?').run(env.paketId);
  const p3 = pendaftaranDisetujui(env, 'Pelanggan Tiga');
  const r4 = await terpasang(admin, p3);
  const jumlah4 = db.prepare("SELECT COUNT(*) AS n FROM pelanggan WHERE desa_id = ? AND status <> 'nonaktif'")
    .get(env.desaId).n;
  const adaTiga = db.prepare("SELECT 1 FROM pelanggan WHERE desa_id = ? AND nama = 'Pelanggan Tiga'").get(env.desaId);
  hasil(r4.status === 302 && !!adaTiga && jumlah4 === 2,
    'Kuota diperbesar → pelanggan baru bisa ditambahkan', `${jumlah4} aktif`);

  // 7) Dashboard pengelola menampilkan pemakaian kuota terbaru.
  const dash = await (await admin.ambil('/')).text();
  hasil(dash.includes('Langganan') && dash.includes('kuota'), 'Dashboard menampilkan kartu langganan & kuota');

  console.log(gagal === 0 ? '\nSemua uji kuota langganan LULUS.' : `\n${gagal} uji GAGAL.`);
  process.exit(gagal === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
