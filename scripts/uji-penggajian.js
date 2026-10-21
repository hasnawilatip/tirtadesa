'use strict';

/**
 * Uji regresi modul kepegawaian & penggajian (HTTP + pemeriksaan database).
 *
 * Jalankan server lebih dulu, lalu:
 *   node scripts/uji-penggajian.js
 *
 * Uji memakai akun admin desa (admin/admin123) dan membuat satu karyawan uji
 * sementara yang dihapus kembali di akhir. Slip gaji yang dibuat saat uji juga
 * ikut dihapus, sehingga data asli tidak berubah.
 */

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const { db } = require('../src/db');
const { todayISO } = require('../src/helpers');

let gagal = 0;
function hasil(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) gagal += 1;
}

function buatKlien() {
  let cookie = '';
  let token = '';
  let jalurToken = '/login';

  async function segarkanToken() {
    const headers = cookie ? { cookie } : {};
    const res = await fetch(`${BASE}${jalurToken}`, { headers, redirect: 'manual' });
    let daftar = [];
    if (typeof res.headers.getSetCookie === 'function') daftar = res.headers.getSetCookie();
    if (!daftar.length) {
      const satu = res.headers.get('set-cookie');
      if (satu) daftar = [satu];
    }
    if (daftar.length) cookie = daftar.map((c) => c.split(';')[0]).join('; ');
    const html = await res.text();
    const cocok = html.match(/<meta name="csrf-token" content="([^"]*)"/);
    token = cocok ? cocok[1] : '';
  }

  return {
    reset() { cookie = ''; token = ''; jalurToken = '/login'; },
    async ambil(path, opsi = {}) {
      const metode = String(opsi.method || 'GET').toUpperCase();
      if (metode !== 'GET' && !token) await segarkanToken();
      const headers = { ...(opsi.headers || {}) };
      if (cookie) headers.cookie = cookie;
      if (token && metode !== 'GET') headers['x-csrf-token'] = token;
      const res = await fetch(`${BASE}${path}`, { ...opsi, headers, redirect: 'manual' });

      let daftar = [];
      if (typeof res.headers.getSetCookie === 'function') daftar = res.headers.getSetCookie();
      if (!daftar.length) {
        const satu = res.headers.get('set-cookie');
        if (satu) daftar = [satu];
      }
      if (daftar.length) cookie = daftar.map((c) => c.split(';')[0]).join('; ');
      if (metode !== 'GET' && path === '/login' && res.status === 302) {
        token = '';
        jalurToken = '/';
      }
      return res;
    },
  };
}

async function login(jar, username, password) {
  const res = await jar.ambil('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password }).toString(),
  });
  return res.status === 302;
}

async function kirim(jar, path, data) {
  return jar.ambil(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(data).toString(),
  });
}

function angkaRupiah(n) {
  return Math.round(Number(n) || 0);
}

function bersihkan(karyawanId) {
  if (!karyawanId) return;
  const hapus = db.transaction(() => {
    db.prepare('DELETE FROM penggajian WHERE karyawan_id = ?').run(karyawanId);
    db.prepare(`DELETE FROM kasbon_bayar WHERE kasbon_id IN (SELECT id FROM kasbon WHERE karyawan_id = ?)`)
      .run(karyawanId);
    db.prepare('DELETE FROM kasbon WHERE karyawan_id = ?').run(karyawanId);
    db.prepare('DELETE FROM absensi WHERE karyawan_id = ?').run(karyawanId);
    db.prepare('DELETE FROM karyawan WHERE id = ?').run(karyawanId);
  });
  hapus();
}

async function main() {
  try {
    await fetch(`${BASE}/login`);
  } catch (err) {
    console.error(`Server tidak dapat dihubungi di ${BASE}. Jalankan "npm start" lebih dulu.`);
    process.exit(1);
  }

  const jar = buatKlien();
  const masuk = await login(jar, 'admin', 'admin123');
  hasil(masuk, 'Login admin desa');

  // Halaman utama modul dapat dibuka.
  for (const [path, teks] of [
    ['/karyawan', 'Karyawan'],
    ['/absensi', 'Absensi Karyawan'],
    ['/penggajian', 'Penggajian'],
    ['/kasbon', 'Kasbon Karyawan'],
  ]) {
    const res = await jar.ambil(path);
    const html = await res.text();
    hasil(res.status === 200 && html.includes(teks), `GET ${path}`, `status ${res.status}`);
  }

  const desa = db.prepare("SELECT id FROM desa ORDER BY id LIMIT 1").get();
  // Pakai dusun milik akun krajan agar uji isolasi bisa memakai admin dusun lain.
  const akunKrajan = db.prepare("SELECT dusun_id FROM users WHERE username = 'krajan'").get();
  const dusun = akunKrajan && akunKrajan.dusun_id
    ? db.prepare('SELECT id FROM dusun WHERE id = ? AND desa_id = ?').get(akunKrajan.dusun_id, desa.id)
    : db.prepare('SELECT id FROM dusun WHERE desa_id = ? ORDER BY id LIMIT 1').get(desa.id);
  const namaUji = `Karyawan Uji ${Date.now()}`;
  let karyawanId = null;

  try {
    // 1. Tambah karyawan.
    const resKaryawan = await kirim(jar, '/karyawan', {
      nama: namaUji,
      dusun_id: String(dusun.id),
      jabatan: 'Petugas Uji',
      status: 'aktif',
      gaji_pokok: '5000000',
      tunjangan_tetap: '500000',
      potongan_tetap: '100000',
      tarif_lembur: '50000',
      potongan_alpa: '200000',
    });
    hasil(resKaryawan.status === 302, 'POST /karyawan', `status ${resKaryawan.status}`);

    const karyawan = db.prepare('SELECT * FROM karyawan WHERE nama = ? ORDER BY id DESC').get(namaUji);
    karyawanId = karyawan ? karyawan.id : null;
    hasil(!!karyawan && /^KRY-\d{4}$/.test(karyawan.nomor), 'Nomor karyawan otomatis KRY-0001',
      karyawan ? karyawan.nomor : 'tidak ada');

    // 2. Absensi: 2 hari hadir (lembur 2 jam di salah satu hari) + 1 hari alpa.
    //    Tanggal 10–12 bulan berjalan agar selalu satu periode.
    const sekarang = new Date();
    const bulanUji = `${sekarang.getFullYear()}-${String(sekarang.getMonth() + 1).padStart(2, '0')}`;
    const tahunUji = Number(bulanUji.slice(0, 4));
    const bulanAngka = Number(bulanUji.slice(5, 7));
    const tanggal = ['10', '11', '12'].map((hari) => `${bulanUji}-${hari}`);

    const absen = [
      { tanggal: tanggal[0], status: 'hadir', lembur_jam: '2' },
      { tanggal: tanggal[1], status: 'hadir', lembur_jam: '0' },
      { tanggal: tanggal[2], status: 'alpa', lembur_jam: '0' },
    ];
    for (const a of absen) {
      const r = await kirim(jar, '/absensi', {
        karyawan_id: String(karyawanId), tanggal: a.tanggal, status: a.status, lembur_jam: a.lembur_jam,
      });
      hasil(r.status === 302, `POST /absensi ${a.status} ${a.tanggal}`, `status ${r.status}`);
    }

    const jumlahAbsen = db.prepare('SELECT COUNT(*) AS n FROM absensi WHERE karyawan_id = ?').get(karyawanId).n;
    hasil(jumlahAbsen === 3, 'Tiga catatan absensi tersimpan', `tercatat ${jumlahAbsen}`);

    // 3. Kasbon 1.000.000.
    const rKasbon = await kirim(jar, '/kasbon', {
      karyawan_id: String(karyawanId), tanggal: tanggal[0], jumlah: '1000000', keterangan: 'Kasbon uji',
    });
    hasil(rKasbon.status === 302, 'POST /kasbon', `status ${rKasbon.status}`);
    const kasbon = db.prepare("SELECT * FROM kasbon WHERE karyawan_id = ? AND status = 'terbuka'").get(karyawanId);
    hasil(!!kasbon && /^KSB-\d{4}$/.test(kasbon.nomor), 'Nomor kasbon otomatis KSB-0001',
      kasbon ? kasbon.nomor : 'tidak ada');

    // 4. Buat slip gaji periode berjalan.
    const rBuat = await kirim(jar, '/penggajian/buat', { bulan: bulanUji });
    hasil(rBuat.status === 302, 'POST /penggajian/buat', `status ${rBuat.status}`);

    const slip = db.prepare('SELECT * FROM penggajian WHERE karyawan_id = ? AND tahun = ? AND bulan = ?')
      .get(karyawanId, tahunUji, bulanAngka);
    hasil(!!slip, 'Slip gaji terbentuk', slip ? slip.nomor : 'tidak ada');
    if (!slip) throw new Error('Slip gaji tidak terbentuk, pengujian dihentikan.');

    const harapan = {
      pokok: 5000000,
      tunjangan: 500000,
      lembur: 100000,
      potonganAlpa: 200000,
      potonganTetap: 100000,
      potonganKasbon: 1000000,
      pendapatan: 5600000,
      potongan: 1300000,
      bersih: 4300000,
    };
    hasil(angkaRupiah(slip.gaji_pokok) === harapan.pokok, 'Gaji pokok pada slip', `${slip.gaji_pokok}`);
    hasil(angkaRupiah(slip.tunjangan) === harapan.tunjangan, 'Tunjangan pada slip', `${slip.tunjangan}`);
    hasil(angkaRupiah(slip.upah_lembur) === harapan.lembur, 'Upah lembur 2 jam × Rp 50.000', `${slip.upah_lembur}`);
    hasil(angkaRupiah(slip.potongan_alpa) === harapan.potonganAlpa, 'Potongan 1 hari alpa', `${slip.potongan_alpa}`);
    hasil(angkaRupiah(slip.potongan_tetap) === harapan.potonganTetap, 'Potongan tetap', `${slip.potongan_tetap}`);
    hasil(angkaRupiah(slip.potongan_kasbon) === harapan.potonganKasbon, 'Potongan kasbon (maks. 50% gaji)', `${slip.potongan_kasbon}`);
    hasil(angkaRupiah(slip.total_pendapatan) === harapan.pendapatan, 'Total pendapatan', `${slip.total_pendapatan}`);
    hasil(angkaRupiah(slip.total_potongan) === harapan.potongan, 'Total potongan', `${slip.total_potongan}`);
    hasil(angkaRupiah(slip.gaji_bersih) === harapan.bersih, 'Gaji bersih', `${slip.gaji_bersih}`);
    hasil(slip.status === 'draf', 'Slip baru berstatus draf', slip.status);

    // 5. Cetak slip.
    const cetak = await jar.ambil(`/penggajian/${slip.id}/cetak`);
    const htmlCetak = await cetak.text();
    hasil(cetak.status === 200 && htmlCetak.includes('GAJI BERSIH') && htmlCetak.includes(namaUji),
      'Halaman slip siap cetak', `status ${cetak.status}`);

    // 6. Bayar slip → kasbon otomatis terpotong.
    const rBayar = await kirim(jar, `/penggajian/${slip.id}/bayar`, {
      tanggal_bayar: todayISO(), metode: 'transfer', catatan: 'Uji bayar',
    });
    hasil(rBayar.status === 302, 'POST /penggajian/:id/bayar', `status ${rBayar.status}`);

    const slipBayar = db.prepare('SELECT * FROM penggajian WHERE id = ?').get(slip.id);
    hasil(slipBayar.status === 'dibayar', 'Slip menjadi dibayar', slipBayar.status);
    const kasbonAkhir = db.prepare('SELECT * FROM kasbon WHERE id = ?').get(kasbon.id);
    hasil(kasbonAkhir.status === 'lunas', 'Kasbon otomatis lunas', kasbonAkhir.status);
    const totalCicilan = db.prepare('SELECT COALESCE(SUM(jumlah),0) AS n FROM kasbon_bayar WHERE kasbon_id = ?')
      .get(kasbon.id).n;
    hasil(angkaRupiah(totalCicilan) === 1000000, 'Pembayaran kasbon tercatat dari potongan gaji', `${totalCicilan}`);

    // 7. Slip yang sudah dibayar tidak bisa dihapus.
    const rHapus = await kirim(jar, `/penggajian/${slip.id}/hapus`, {});
    const masihAda = db.prepare('SELECT 1 FROM penggajian WHERE id = ?').get(slip.id);
    hasil(rHapus.status === 302 && !!masihAda, 'Slip dibayar dilindungi dari penghapusan');

    // 8. Laporan memuat pengeluaran gaji.
    const periode = db.prepare('SELECT id FROM periode_tagihan WHERE desa_id = ? AND tahun = ? AND bulan = ?')
      .get(desa.id, tahunUji, bulanAngka);
    if (periode) {
      const lap = await jar.ambil(`/laporan?periode=${periode.id}`);
      const htmlLap = await lap.text();
      hasil(lap.status === 200 && htmlLap.includes('Gaji karyawan') && htmlLap.includes('Total gaji dibayar'),
        'Laporan menampilkan pengeluaran gaji', `status ${lap.status}`);
      hasil(htmlLap.includes('Sisa kas setelah pembelian &amp; gaji'), 'Laporan menghitung sisa kas setelah gaji');
    } else {
      console.log('SKIP  Laporan — belum ada periode tagihan untuk bulan ini');
    }

    // 9. Isolasi: admin dusun lain tidak boleh melihat slip karyawan ini (404).
    const kandidat = [
      { username: 'ngemplak', sandi: 'ngemplak123' },
      { username: 'sumber', sandi: 'sumber123' },
    ];
    for (const akun of kandidat) {
      const info = db.prepare('SELECT dusun_id FROM users WHERE username = ?').get(akun.username);
      if (!info || Number(info.dusun_id) === Number(dusun.id)) continue;
      const jarDusun = buatKlien();
      if (!(await login(jarDusun, akun.username, akun.sandi))) continue;
      const r = await jarDusun.ambil(`/penggajian/${slip.id}/cetak`);
      hasil(r.status === 404, `Admin dusun ${akun.username} tidak dapat melihat slip dusun lain`, `status ${r.status}`);
      break;
    }
  } finally {
    bersihkan(karyawanId);
  }

  console.log(gagal ? `\n${gagal} pemeriksaan GAGAL.` : '\nSemua pemeriksaan penggajian LULUS.');
  process.exit(gagal ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
