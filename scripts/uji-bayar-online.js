'use strict';

/**
 * Uji alur pembayaran online warga:
 * superadmin menyiapkan saluran bayar → warga klik Bayar & unggah bukti →
 * kasir memverifikasi menjadi kwitansi.
 *
 * Jalankan server uji lebih dulu:
 *   $env:DB_PATH='G:\aplikasi PDAM\data\uji-bayar.db'; $env:PORT='3100'; node server.js
 * lalu:
 *   node scripts/uji-bayar-online.js
 */

process.env.DB_PATH = 'G:\\aplikasi PDAM\\data\\uji-bayar.db';
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
  // Data demo: pelanggan milik akun warga + satu tagihan yang belum lunas.
  const tagihan = db.prepare(`
    SELECT t.id, t.total, t.terbayar
    FROM tagihan t JOIN users u ON u.pelanggan_id = t.pelanggan_id
    WHERE u.username = 'warga' AND t.status <> 'batal' AND t.total > t.terbayar + 0.5
      AND t.nomor_tagihan NOT LIKE 'TAG/UJI%'
    ORDER BY t.id DESC LIMIT 1
  `).get();

  const pelangganWarga = db.prepare("SELECT pelanggan_id FROM users WHERE username = 'warga'").get().pelanggan_id;
  const sambunganWarga = db.prepare('SELECT id FROM sambungan WHERE pelanggan_id = ? LIMIT 1').get(pelangganWarga);
  const dusunWarga = db.prepare('SELECT dusun_id FROM pelanggan WHERE id = ?').get(pelangganWarga).dusun_id;

  /** Periode + tagihan buatan sendiri supaya uji tidak bergantung sisa data demo. */
  function buatTagihanUji(tahun, bulan, nomor) {
    let periode = db.prepare('SELECT id FROM periode_tagihan WHERE desa_id = 1 AND tahun = ? AND bulan = ?')
      .get(tahun, bulan);
    if (!periode) {
      periode = {
        id: db.prepare(`INSERT INTO periode_tagihan (desa_id, tahun, bulan, tanggal_jatuh_tempo, status)
          VALUES (1, ?, ?, ?, 'tutup')`).run(tahun, bulan, `${tahun + 1}-01-20`).lastInsertRowid,
      };
    }
    const ada = db.prepare('SELECT id FROM tagihan WHERE periode_id = ? AND pelanggan_id = ?')
      .get(periode.id, pelangganWarga);
    if (ada) {
      // Pakai ulang tagihan uji: bersihkan pembayaran lamanya agar uji bisa diulang.
      db.prepare('DELETE FROM pembayaran_online WHERE tagihan_id = ?').run(ada.id);
      db.prepare('DELETE FROM pembayaran WHERE tagihan_id = ?').run(ada.id);
      db.prepare("UPDATE tagihan SET terbayar = 0, status = 'belum_bayar' WHERE id = ?").run(ada.id);
      return db.prepare('SELECT id, total, terbayar FROM tagihan WHERE id = ?').get(ada.id);
    }
    const id = db.prepare(`INSERT INTO tagihan (periode_id, pelanggan_id, sambungan_id, dusun_id, nomor_tagihan,
        pemakaian_m3, abonemen, biaya_pemakaian, total, terbayar, status, tanggal_terbit, jatuh_tempo)
      VALUES (?,?,?,?,?, 10, 5000, 15000, 20000, 0, 'belum_bayar', ?, ?)`).run(
      periode.id, pelangganWarga, sambunganWarga.id, dusunWarga, nomor,
      `${tahun}-12-21`, `${tahun + 1}-01-20`
    ).lastInsertRowid;
    return db.prepare('SELECT id, total, terbayar FROM tagihan WHERE id = ?').get(id);
  }

  const tagihanUtama = tagihan || buatTagihanUji(2025, 11, 'TAG/UJI/2025/11/01');
  const tagihanLain = buatTagihanUji(2025, 10, 'TAG/UJI/2025/10/01');
  const sisa = Math.round((tagihanUtama.total - tagihanUtama.terbayar) * 100) / 100;

  // 1) Superadmin membuka menu pembayaran online.
  const superadmin = buatKlien();
  hasil(await superadmin.login('superadmin', 'superadmin123'), 'Login superadmin');
  // Pastikan kondisi awal bersih & layanan aktif (uji bisa diulang).
  await superadmin.ambil('/superadmin/pembayaran/setelan', {
    method: 'POST', headers: H, body: badan({ bayar_online_aktif: '1' }),
  });
  db.prepare('DELETE FROM pembayaran_online WHERE desa_id = 1').run();
  db.prepare('DELETE FROM saluran_bayar').run();
  const halaman = await superadmin.ambil('/superadmin/pembayaran');
  const htmlSuper = await halaman.text();
  hasil(halaman.status === 200 && htmlSuper.includes('Saluran pembayaran') && htmlSuper.includes('modalSaluran'),
    'Superadmin punya menu Pembayaran Online dengan popup saluran');

  // 2) Tambah saluran transfer bank.
  const buatTransfer = await superadmin.ambil('/superadmin/pembayaran/saluran', {
    method: 'POST', headers: H,
    body: badan({
      nama: 'Transfer BCA Uji', jenis: 'transfer', penyedia: 'Bank BCA',
      nomor_tujuan: '1234567890', atas_nama: 'Tirta Desa Uji',
      instruksi: 'Transfer sesuai nominal lalu unggah bukti.', urutan: 1,
      is_active: '1',
    }),
  });
  const saluranTransfer = db.prepare("SELECT * FROM saluran_bayar WHERE nama = 'Transfer BCA Uji'").get();
  hasil(buatTransfer.status === 302 && saluranTransfer && saluranTransfer.is_active === 1,
    'Superadmin menambah saluran transfer', saluranTransfer ? saluranTransfer.nomor_tujuan : '-');

  // 3) Saluran link pembayaran dengan placeholder.
  await superadmin.ambil('/superadmin/pembayaran/saluran', {
    method: 'POST', headers: H,
    body: badan({
      nama: 'Gateway Uji', jenis: 'link', penyedia: 'Midtrans',
      url_bayar: 'https://pay.contoh.test/checkout?ref={kode}&amount={total}',
      urutan: 2, is_active: '1',
    }),
  });
  const saluranLink = db.prepare("SELECT * FROM saluran_bayar WHERE nama = 'Gateway Uji'").get();
  hasil(!!saluranLink && saluranLink.jenis === 'link', 'Superadmin menambah saluran link pembayaran');

  // 4) Saluran tanpa nomor rekening ditolak.
  const transferKosong = await superadmin.ambil('/superadmin/pembayaran/saluran', {
    method: 'POST', headers: H,
    body: badan({ nama: 'Transfer Tanpa Rekening', jenis: 'transfer', is_active: '1' }),
  });
  const kosong = db.prepare("SELECT id FROM saluran_bayar WHERE nama = 'Transfer Tanpa Rekening'").get();
  hasil(transferKosong.status === 302 && !kosong, 'Saluran transfer tanpa nomor rekening ditolak');

  // 5) Warga melihat tombol Bayar dan daftar saluran.
  const warga = buatKlien();
  hasil(await warga.login('warga', 'warga123'), 'Login warga');
  const daftarTagihan = await (await warga.ambil('/warga/tagihan')).text();
  hasil(daftarTagihan.includes(`/warga/tagihan/${tagihanUtama.id}/bayar`), 'Tombol Bayar muncul di daftar tagihan warga');

  const halamanBayar = await warga.ambil(`/warga/tagihan/${tagihanUtama.id}/bayar`);
  const htmlBayar = await halamanBayar.text();
  hasil(halamanBayar.status === 200
    && htmlBayar.includes('Transfer BCA Uji')
    && htmlBayar.includes('1234567890')
    && htmlBayar.includes('Gateway Uji'),
    'Halaman bayar menampilkan saluran dari superadmin');
  hasil(htmlBayar.includes(`Rp ${new Intl.NumberFormat('id-ID').format(Math.round(sisa))}`),
    'Nominal yang diminta sama dengan sisa tagihan', `Rp ${sisa}`);

  // 6) Warga mengajukan pembayaran (saluran transfer).
  const ajukan = await warga.ambil(`/warga/tagihan/${tagihanUtama.id}/bayar`, {
    method: 'POST', headers: H,
    body: badan({ saluran_id: saluranTransfer.id, catatan_warga: 'Transfer dari rekening istri' }),
  });
  const permintaan = db.prepare('SELECT * FROM pembayaran_online WHERE tagihan_id = ? ORDER BY id DESC LIMIT 1')
    .get(tagihanUtama.id);
  hasil(ajukan.status === 302 && permintaan && permintaan.status === 'menunggu',
    'Warga membuat permintaan pembayaran', permintaan ? permintaan.kode : '-');
  hasil(!!permintaan && Math.abs(permintaan.jumlah - sisa) < 0.01,
    'Jumlah permintaan = sisa tagihan', permintaan ? `Rp ${permintaan.jumlah}` : '-');
  hasil(ajukan.headers.get('location') === `/warga/bayar/${permintaan.kode}`,
    'Warga diarahkan ke halaman instruksi pembayaran');

  // 7) Unggah bukti transfer.
  const form = new FormData();
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  form.append('bukti', new Blob([png], { type: 'image/png' }), 'bukti.png');
  form.append('catatan_warga', 'Sudah transfer');
  const unggah = await warga.ambil(`/warga/bayar/${permintaan.kode}/bukti`, { method: 'POST', body: form });
  const setelahUnggah = db.prepare('SELECT * FROM pembayaran_online WHERE id = ?').get(permintaan.id);
  hasil(unggah.status === 302 && !!setelahUnggah.bukti_path, 'Bukti pembayaran tersimpan',
    setelahUnggah.bukti_path || '-');

  // 8) Kasir melihat permintaan & memverifikasi.
  const kasir = buatKlien();
  hasil(await kasir.login('kasir', 'kasir123'), 'Login kasir');
  const halamanKasir = await kasir.ambil('/pembayaran-online');
  const htmlKasir = await halamanKasir.text();
  hasil(halamanKasir.status === 200 && htmlKasir.includes(permintaan.kode),
    'Kasir melihat permintaan pembayaran warga');

  const verifikasi = await kasir.ambil(`/pembayaran-online/${permintaan.id}/verifikasi`, {
    method: 'POST', headers: H,
    body: badan({ jumlah: sisa, tanggal_bayar: '2026-10-20', catatan_admin: 'Dana masuk sesuai mutasi' }),
  });
  const setelahVerifikasi = db.prepare('SELECT * FROM pembayaran_online WHERE id = ?').get(permintaan.id);
  const kwitansi = setelahVerifikasi.pembayaran_id
    ? db.prepare('SELECT * FROM pembayaran WHERE id = ?').get(setelahVerifikasi.pembayaran_id)
    : null;
  const tagihanBaru = db.prepare('SELECT * FROM tagihan WHERE id = ?').get(tagihanUtama.id);
  hasil(verifikasi.status === 302 && setelahVerifikasi.status === 'dikonfirmasi',
    'Kasir memverifikasi pembayaran online');
  hasil(!!kwitansi && kwitansi.status === 'valid' && Math.abs(kwitansi.jumlah - sisa) < 0.01,
    'Kwitansi resmi terbit dari verifikasi', kwitansi ? kwitansi.nomor_kwitansi : '-');
  hasil(tagihanBaru.status === 'lunas', 'Status tagihan menjadi lunas', tagihanBaru.status);

  // 9) Warga melihat status terkonfirmasi.
  const statusWarga = await (await warga.ambil(`/warga/bayar/${permintaan.kode}`)).text();
  hasil(statusWarga.includes('sudah diverifikasi'), 'Warga melihat status pembayaran terkonfirmasi');

  // 10) Saluran nonaktif tidak muncul lagi di portal warga.
  await superadmin.ambil(`/superadmin/pembayaran/saluran/${saluranTransfer.id}/toggle`, { method: 'POST', headers: H });
  const saluranMati = db.prepare('SELECT is_active FROM saluran_bayar WHERE id = ?').get(saluranTransfer.id);
  hasil(saluranMati.is_active === 0, 'Superadmin dapat menonaktifkan saluran');
  const htmlLagi = await (await warga.ambil(`/warga/tagihan/${tagihanLain.id}/bayar`)).text();
  hasil(!htmlLagi.includes('1234567890'), 'Saluran nonaktif tidak tampil untuk warga');

  // 11) Layanan dimatikan total → warga diberi tahu.
  await superadmin.ambil('/superadmin/pembayaran/setelan', {
    method: 'POST', headers: H,
    body: badan({ bayar_online_aktif: '0', bayar_online_info: 'Verifikasi 1x24 jam' }),
  });
  const setelanMati = db.prepare('SELECT bayar_online_aktif FROM pengaturan WHERE id = 1').get();
  hasil(setelanMati.bayar_online_aktif === 0, 'Superadmin dapat menonaktifkan pembayaran online');
  const htmlMati = await (await warga.ambil(`/warga/tagihan/${tagihanLain.id}/bayar`)).text();
  hasil(htmlMati.includes('dinonaktifkan'), 'Warga diberi tahu saat layanan nonaktif');

  // 12) Isolasi: admin pengelola lain tidak boleh melihat permintaan desa ini.
  const desaLain = buatKlien();
  if (!db.prepare('SELECT id FROM desa WHERE id = 2').get()) {
    db.prepare("INSERT INTO desa (nama) VALUES ('Desa Uji Lain')").run();
  }
  if (!db.prepare("SELECT id FROM users WHERE username = 'adminlain'").get()) {
    db.prepare(`INSERT INTO users (desa_id, nama, username, password_hash, role, is_active)
      SELECT 2, 'Admin Desa Lain', 'adminlain', password_hash, 'admin_desa', 1
      FROM users WHERE username = 'admin'`).run();
  }
  const loginLain = await desaLain.login('adminlain', 'admin123');
  const halamanLain = loginLain ? await desaLain.ambil('/pembayaran-online') : null;
  const htmlLain = halamanLain ? await halamanLain.text() : '';
  hasil(loginLain && halamanLain.status === 200 && !htmlLain.includes(permintaan.kode),
    'Admin pengelola lain tidak melihat permintaan desa ini');

  console.log(gagal === 0 ? '\nSemua uji pembayaran online LULUS.' : `\n${gagal} uji GAGAL.`);
  process.exit(gagal === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
