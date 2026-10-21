'use strict';

/**
 * Uji tagihan langganan (iuran bulanan pengelola):
 * tagihan otomatis → admin desa klik Bayar & unggah bukti →
 * superadmin verifikasi → masa aktif bertambah & tagihan siklus berikutnya dibuat.
 *
 * Jalankan server uji lebih dulu:
 *   $env:DB_PATH='G:\aplikasi PDAM\data\uji-langganan.db'; $env:PORT='3100'; node server.js
 * lalu:
 *   node scripts/uji-langganan-tagihan.js
 */

process.env.DB_PATH = 'G:\\aplikasi PDAM\\data\\uji-langganan.db';
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

async function main() {
  const desa = db.prepare('SELECT * FROM desa ORDER BY id LIMIT 1').get();
  const superadmin = buatKlien();
  hasil(await superadmin.login('superadmin', 'superadmin123'), 'Login superadmin');

  // Siapkan saluran pembayaran untuk tagihan langganan.
  db.prepare('DELETE FROM tagihan_langganan').run();
  db.prepare('DELETE FROM saluran_bayar').run();
  await superadmin.ambil('/superadmin/pembayaran/setelan', {
    method: 'POST', headers: H, body: badan({ bayar_online_aktif: '1' }),
  });
  await superadmin.ambil('/superadmin/pembayaran/saluran', {
    method: 'POST', headers: H,
    body: badan({
      nama: 'Transfer Langganan', jenis: 'transfer', penyedia: 'Bank BCA',
      nomor_tujuan: '9876543210', atas_nama: 'Penyedia Layanan', urutan: 1, is_active: '1',
    }),
  });
  const saluran = db.prepare("SELECT * FROM saluran_bayar WHERE nama = 'Transfer Langganan'").get();
  hasil(!!saluran, 'Saluran pembayaran siap dipakai tagihan langganan');

  // 1) Admin desa membuka menu Langganan → tagihan otomatis dibuat.
  const admin = buatKlien();
  hasil(await admin.login('admin', 'admin123'), 'Login admin desa');
  const halaman = await admin.ambil('/langganan');
  const html = await halaman.text();
  const tagihan = db.prepare('SELECT * FROM tagihan_langganan WHERE desa_id = ? ORDER BY id DESC LIMIT 1').get(desa.id);
  hasil(halaman.status === 200 && !!tagihan, 'Tagihan langganan dibuat otomatis',
    tagihan ? `${tagihan.nomor} Rp ${tagihan.jumlah}` : '-');
  hasil(html.includes('Bayar sekarang') && html.includes(tagihan.nomor),
    'Tombol Bayar tampil saat tagihan belum dibayar');
  hasil(!!tagihan && tagihan.periode_mulai === desa.langganan_sampai,
    'Periode tagihan dimulai dari akhir masa aktif', tagihan ? `${tagihan.periode_mulai} → ${tagihan.periode_sampai}` : '-');
  const harapanSampai = (() => {
    const d = new Date(`${desa.langganan_sampai}T00:00:00`);
    d.setMonth(d.getMonth() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();
  hasil(!!tagihan && tagihan.periode_sampai === harapanSampai,
    'Tanggal selesai = tepat 1 bulan (tanpa geser zona waktu)', tagihan ? tagihan.periode_sampai : '-');

  // 2) Halaman tagihan menampilkan kanal pembayaran dari superadmin.
  const detail = await admin.ambil(`/langganan/tagihan/${tagihan.id}`);
  const htmlDetail = await detail.text();
  hasil(detail.status === 200 && htmlDetail.includes('Transfer Langganan') && htmlDetail.includes('9876543210'),
    'Halaman tagihan menampilkan saluran pembayaran');

  // 3) Admin mengajukan pembayaran + unggah bukti.
  const ajukan = await admin.ambil(`/langganan/tagihan/${tagihan.id}/bayar`, {
    method: 'POST', headers: H, body: badan({ saluran_id: saluran.id, catatan: 'Transfer dari kas desa' }),
  });
  const setelahAjukan = db.prepare('SELECT * FROM tagihan_langganan WHERE id = ?').get(tagihan.id);
  hasil(ajukan.status === 302 && setelahAjukan.status === 'menunggu',
    'Pengajuan pembayaran mengubah status menjadi menunggu');

  const form = new FormData();
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  form.append('bukti', new Blob([png], { type: 'image/png' }), 'bukti.png');
  const unggah = await admin.ambil(`/langganan/tagihan/${tagihan.id}/bukti`, { method: 'POST', body: form });
  const setelahUnggah = db.prepare('SELECT * FROM tagihan_langganan WHERE id = ?').get(tagihan.id);
  hasil(unggah.status === 302 && !!setelahUnggah.bukti_path, 'Bukti pembayaran tersimpan',
    setelahUnggah.bukti_path || '-');

  // 4) Superadmin melihat & memverifikasi.
  const halamanSuper = await superadmin.ambil('/superadmin/langganan');
  const htmlSuper = await halamanSuper.text();
  hasil(halamanSuper.status === 200 && htmlSuper.includes(tagihan.nomor) && htmlSuper.includes('Tagihan langganan'),
    'Superadmin melihat tagihan langganan pengelola');
  const verifikasi = await superadmin.ambil(`/superadmin/langganan/tagihan/${tagihan.id}/verifikasi`, {
    method: 'POST', headers: H, body: badan({ catatan_admin: 'Dana masuk sesuai mutasi' }),
  });
  const setelahVerifikasi = db.prepare('SELECT * FROM tagihan_langganan WHERE id = ?').get(tagihan.id);
  const desaBaru = db.prepare('SELECT * FROM desa WHERE id = ?').get(desa.id);
  hasil(verifikasi.status === 302 && setelahVerifikasi.status === 'lunas', 'Superadmin memverifikasi tagihan langganan');
  hasil(desaBaru.langganan_sampai === harapanSampai, 'Masa aktif bertambah 1 bulan setelah verifikasi',
    `${desa.langganan_sampai} → ${desaBaru.langganan_sampai}`);
  const tagihanBaru = db.prepare(`SELECT * FROM tagihan_langganan
    WHERE desa_id = ? AND status = 'belum_bayar' ORDER BY id DESC LIMIT 1`).get(desa.id);
  hasil(!!tagihanBaru && tagihanBaru.periode_mulai === harapanSampai,
    'Tagihan siklus berikutnya dibuat otomatis', tagihanBaru ? tagihanBaru.nomor : '-');

  // 5) Penolakan bukti mengembalikan status ke belum dibayar.
  await admin.ambil(`/langganan/tagihan/${tagihanBaru.id}/bayar`, {
    method: 'POST', headers: H, body: badan({ saluran_id: saluran.id }),
  });
  await superadmin.ambil(`/superadmin/langganan/tagihan/${tagihanBaru.id}/tolak`, {
    method: 'POST', headers: H, body: badan({ catatan_admin: 'Nominal tidak sesuai' }),
  });
  const setelahTolak = db.prepare('SELECT * FROM tagihan_langganan WHERE id = ?').get(tagihanBaru.id);
  hasil(setelahTolak.status === 'belum_bayar' && /nominal tidak sesuai/i.test(setelahTolak.catatan_admin || ''),
    'Bukti yang ditolak kembali ke belum dibayar', setelahTolak.catatan_admin || '-');

  // 6) Isolasi: admin pengelola lain tidak bisa membuka tagihan desa ini.
  if (!db.prepare('SELECT id FROM desa WHERE id = 2').get()) {
    db.prepare("INSERT INTO desa (nama) VALUES ('Desa Uji Lain')").run();
  }
  if (!db.prepare("SELECT id FROM users WHERE username = 'adminlain'").get()) {
    db.prepare(`INSERT INTO users (desa_id, nama, username, password_hash, role, is_active)
      SELECT 2, 'Admin Desa Lain', 'adminlain', password_hash, 'admin_desa', 1
      FROM users WHERE username = 'admin'`).run();
  }
  const lain = buatKlien();
  await lain.login('adminlain', 'admin123');
  const coba = await lain.ambil(`/langganan/tagihan/${tagihanBaru.id}`);
  hasil(coba.status === 302, 'Admin pengelola lain tidak bisa membuka tagihan ini', `status ${coba.status}`);

  console.log(gagal === 0 ? '\nSemua uji tagihan langganan LULUS.' : `\n${gagal} uji GAGAL.`);
  process.exit(gagal === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
