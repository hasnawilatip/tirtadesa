'use strict';

/**
 * Smoke test HTTP tanpa dependensi tambahan.
 * Jalankan server lebih dulu, lalu: npm run test:smoke
 */

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const bcrypt = require('bcryptjs');
const { db } = require('../src/db');

const SUPER_UJI = { username: 'uji_smoke_super', sandi: 'UjiSmoke12345' };

/** Buat akun superadmin sementara agar uji tidak menyentuh kata sandi akun asli. */
function siapkanSuperUji() {
  bersihkanSuperUji();
  const desa = db.prepare('SELECT id FROM desa ORDER BY id LIMIT 1').get();
  if (!desa) throw new Error('Belum ada data desa untuk uji.');
  db.prepare(`INSERT INTO users (desa_id, dusun_id, nama, username, password_hash, role, is_active)
    VALUES (?, NULL, 'Superadmin Uji', ?, ?, 'superadmin', 1)`)
    .run(desa.id, SUPER_UJI.username, bcrypt.hashSync(SUPER_UJI.sandi, 10));
}

function bersihkanSuperUji() {
  db.prepare('DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE username = ?)')
    .run(SUPER_UJI.username);
  db.prepare('DELETE FROM users WHERE username = ?').run(SUPER_UJI.username);
}

let gagal = 0;

function hasil(ok, label, detail = '') {
  const tanda = ok ? 'PASS' : 'FAIL';
  console.log(`${tanda}  ${label}${detail ? ` — ${detail}` : ''}`);
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
      if (metode !== 'GET' && path === '/logout' && res.status === 302) {
        token = '';
        jalurToken = '/login';
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

async function cekHalaman(jar, path, statusHarapan, teksHarapan = null) {
  const res = await jar.ambil(path);
  const body = await res.text();
  const statusOk = res.status === statusHarapan;
  const isiOk = teksHarapan == null || body.includes(teksHarapan);
  hasil(statusOk && isiOk, `GET ${path}`, `status ${res.status}${isiOk ? '' : ` · teks "${teksHarapan}" tidak ditemukan`}`);
}

async function main() {
  try {
    await fetch(`${BASE}/login`);
  } catch (err) {
    console.error(`Server tidak dapat dihubungi di ${BASE}. Jalankan "npm start" lebih dulu.`);
    process.exit(1);
  }

  const anonim = buatKlien();
  await cekHalaman(anonim, '/', 200, 'pemasukan yang terukur');
  const homeHtml = await (await anonim.ambil('/')).text();
  hasil(homeHtml.includes('id="paket"') && homeHtml.includes('home-paket-grid')
    && /home-paket-harga/.test(homeHtml), 'Beranda publik menampilkan paket langganan');
  hasil((homeHtml.match(/\/gabung\?paket=\d+/g) || []).length >= 3,
    'Paket di beranda bisa dipilih langsung ke formulir pendaftaran');
  await cekHalaman(anonim, '/gabung', 200, 'Formulir pendaftaran');
  const gabungHtml = await (await anonim.ambil('/gabung')).text();
  hasil(gabungHtml.includes('data-jenis-panel="desa"') && gabungHtml.includes('data-jenis-panel="dusun"')
    && gabungHtml.includes('data-jenis-panel="individu"'), 'Form pendaftaran memiliki 3 jenis');
  hasil(gabungHtml.includes('id="desa_provinsi"') && gabungHtml.includes('Kabupaten/Kota')
    && gabungHtml.includes('Desa/Kelurahan'), 'Form pendaftaran desa memakai dropdown wilayah');
  hasil(gabungHtml.includes('id="dusun_provinsi"') && gabungHtml.includes('id="dusun_desa"')
    && gabungHtml.includes('Desa induk'), 'Pendaftaran dusun juga memakai dropdown wilayah');
  hasil(gabungHtml.includes('id="usaha_provinsi"') && gabungHtml.includes('id="usaha_desa"')
    && gabungHtml.includes('alamat usaha'), 'Pendaftaran individu/usaha memakai dropdown wilayah sebagai alamat usaha');
  hasil(gabungHtml.includes('Pilih paket langganan') && gabungHtml.includes('paket-kartu')
    && /name="paket_id" value="\d+"/.test(gabungHtml),
    'Pendaftaran memilih paket langganan sebelum mendaftar');

  const gabungKosong = await anonim.ambil('/gabung', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ nama: '', usaha: '', lokasi: '', whatsapp: '' }).toString(),
  });
  hasil(gabungKosong.status === 400, 'Pendaftaran tidak lengkap ditolak', `status ${gabungKosong.status}`);
  const gabungJenisSalah = await anonim.ambil('/gabung', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ jenis: 'lainnya', nama: 'Uji', whatsapp: '081234567890' }).toString(),
  });
  hasil(gabungJenisSalah.status === 400, 'Jenis pendaftaran tidak valid ditolak', `status ${gabungJenisSalah.status}`);

  // Pendaftaran dusun wajib memilih wilayah lengkap (dropdown provinsi–desa induk).
  const paketPertama = (gabungHtml.match(/name="paket_id" value="(\d+)"/) || [])[1];
  const gabungDusunKurang = await anonim.ambil('/gabung', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      jenis: 'dusun', nama: 'Uji Dusun', whatsapp: '081200000099',
      nama_dusun: 'Krajan', desa_induk: '', kecamatan: '', kabupaten: '', provinsi: '',
      paket_id: paketPertama || '',
    }).toString(),
  });
  hasil(gabungDusunKurang.status === 400, 'Pendaftaran dusun tanpa wilayah ditolak',
    `status ${gabungDusunKurang.status}`);

  const gabungUsahaKurang = await anonim.ambil('/gabung', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      jenis: 'individu', nama: 'Uji Usaha', whatsapp: '081200000098',
      nama_usaha: 'Sumur Bor Uji', provinsi: '', kabupaten: '', kecamatan: '', nama_desa: '',
      paket_id: paketPertama || '',
    }).toString(),
  });
  hasil(gabungUsahaKurang.status === 400, 'Pendaftaran usaha tanpa alamat wilayah ditolak',
    `status ${gabungUsahaKurang.status}`);
  await cekHalaman(anonim, '/tagihan', 302, null);
  await cekHalaman(anonim, '/login', 200, 'Masuk ke aplikasi');
  const loginHtml = await (await anonim.ambil('/login')).text();
  hasil(loginHtml.includes('Lupa password?') && loginHtml.includes('Ingat saya')
    && /name="_csrf" value="[^"]+"/.test(loginHtml),
    'Halaman login memiliki lupa password, ingat saya, dan token CSRF');

  const tanpaToken = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: 'admin123' }).toString(),
    redirect: 'manual',
  });
  hasil(tanpaToken.status === 403, 'POST tanpa token CSRF ditolak', `status ${tanpaToken.status}`);

  const halamanLogin = await anonim.ambil('/login');
  hasil(halamanLogin.headers.get('x-content-type-options') === 'nosniff'
    && (halamanLogin.headers.get('content-security-policy') || '').includes("default-src 'self'")
    && !halamanLogin.headers.get('x-powered-by'),
    'Header keamanan (CSP, nosniff, tanpa X-Powered-By) aktif');

  const meterAnonim = await anonim.ambil('/uploads/meter/tidak-ada.png');
  hasil([302, 403, 404].includes(meterAnonim.status),
    'Foto meter tidak dapat diakses anonim', `status ${meterAnonim.status}`);

  const logoCocok = loginHtml.match(/\/uploads\/logo\/[A-Za-z0-9._-]+/);
  if (logoCocok) {
    const logo = await anonim.ambil(logoCocok[0]);
    hasil(logo.status === 200 && logo.headers.get('x-content-type-options') === 'nosniff',
      'Logo publik tetap tampil dengan header nosniff', `status ${logo.status}`);
  }

  await cekHalaman(anonim, '/lupa-password', 200, 'Formulir pemulihan');
  const lupaKosong = await anonim.ambil('/lupa-password', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: '', whatsapp: '' }).toString(),
  });
  hasil(lupaKosong.status === 400, 'Permintaan reset tidak lengkap ditolak', `status ${lupaKosong.status}`);

  // Rate limit: 6 kali gagal login dengan username fiktif harus dikunci sementara
  const akunFiktif = 'user_tidak_ada_uji';
  for (let i = 0; i < 6; i += 1) {
    await anonim.ambil('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: akunFiktif, password: 'salah' }).toString(),
    });
  }
  const kenaLimit = await anonim.ambil('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: akunFiktif, password: 'salah' }).toString(),
  });
  hasil(kenaLimit.status === 429, 'Rate limit login aktif', `status ${kenaLimit.status}`);

  const admin = buatKlien();
  hasil(await login(admin, 'admin', 'admin123'), 'Login admin desa');
  const halamanAdmin = [
    '/', '/dusun', '/sumur', '/pelanggan', '/tarif', '/periode', '/bahan', '/pembelian',
    '/pasang', '/tagihan', '/produksi', '/keluhan', '/laporan', '/pengguna', '/profil-desa', '/audit',
  ];
  for (const path of halamanAdmin) {
    const res = await admin.ambil(path);
    const body = await res.text();
    hasil(res.status === 200 && !body.includes('Terjadi kesalahan'), `Admin GET ${path}`, `status ${res.status}`);
  }
  const daftarStafDesa = await (await admin.ambil('/pengguna')).text();
  hasil(daftarStafDesa.includes('Kasir Desa') && !daftarStafDesa.includes('Superadmin'),
    'Admin desa hanya melihat akun staf');

  const dashHtml = await (await admin.ambil('/')).text();
  hasil(dashHtml.includes('id="collapseBtn"'), 'Topbar memiliki tombol kecilkan sidebar');
  hasil(dashHtml.includes('dash-hero') && dashHtml.includes('kpi-icon'), 'Dashboard admin memakai hero & kartu KPI berikon');
  hasil(dashHtml.includes('Langganan &amp; kuota') || dashHtml.includes('Langganan & kuota'),
    'Dashboard pengelola menampilkan kartu langganan & kuota');
  const cssHtml = await (await anonim.ambil('/css/style.css')).text();
  hasil(cssHtml.includes('.sidebar-mini .sidebar') && cssHtml.includes('.dash-hero'),
    'CSS sidebar mini & hero dashboard tersedia');
  const jsApp = await (await anonim.ambil('/js/app.js')).text();
  hasil(jsApp.includes('_isianBerubah') && !jsApp.includes('modal-hint'),
    'Popup tidak menutup saat isian belum disimpan (tanpa notifikasi)');
  hasil(jsApp.includes("querySelectorAll('form.filters')") && jsApp.includes('prosesFilter')
    && jsApp.includes('[data-hasil]'),
    'Filter otomatis memuat sebagian halaman tanpa reload');

  const modalPerHalaman = [
    ['/pengguna', 'modalDaftarAkun'],
    ['/dusun', 'modalDusun'],
    ['/sumur', 'modalSumur'],
    ['/tarif', 'modalGolongan'],
    ['/produksi', 'modalProduksi'],
    ['/keluhan', 'modalKeluhan'],
  ];
  for (const [path, modal] of modalPerHalaman) {
    const body = await (await admin.ambil(path)).text();
    hasil(body.includes(`data-modal-open="${modal}"`) && body.includes(`id="${modal}"`),
      `Popup tambah ${path} tersedia`);
  }
  const pelangganHtml = await (await admin.ambil('/pelanggan')).text();
  hasil(!pelangganHtml.includes('id="modalPelanggan"') && !pelangganHtml.includes('>Tambah pelanggan<')
    && pelangganHtml.includes('Pasang pelanggan baru'),
    'Pelanggan baru hanya lewat menu Pasang Baru (tanpa form tambah langsung)');
  const baruPelanggan = await admin.ambil('/pelanggan/baru');
  hasil(baruPelanggan.status === 302 && baruPelanggan.headers.get('location') === '/pasang?buka=modalPasang',
    'Alamat lama /pelanggan/baru dialihkan ke popup Pasang Baru', `status ${baruPelanggan.status}`);
  const tambahLama = await admin.ambil('/pelanggan', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ nama: 'Uji Tambah Langsung', dusun_id: '1', golongan_id: '1' }).toString(),
  });
  hasil(tambahLama.status === 302 && tambahLama.headers.get('location') === '/pasang?buka=modalPasang',
    'POST /pelanggan lama dialihkan ke popup Pasang Baru', `status ${tambahLama.status}`);
  hasil(pelangganHtml.includes('data-modal-open="modalAkun')
    && /data-modal-open="modalAkun\d+"/.test(pelangganHtml)
    && pelangganHtml.includes('>Buat akun<'),
    'Daftar pelanggan punya aksi buat akun per baris');
  const idDetail = (/href="\/pelanggan\/(\d+)"/.exec(pelangganHtml) || [])[1];
  if (idDetail) {
    const detailHtml = await (await admin.ambil(`/pelanggan/${idDetail}`)).text();
    hasil(detailHtml.includes('Riwayat meter') && detailHtml.includes('Nomor seri meter'),
      'Detail pelanggan menampilkan nomor seri & riwayat meter');
    hasil(detailHtml.includes('data-modal-open="modalGantiMeter"')
      && detailHtml.includes(`/pelanggan/${idDetail}/ganti-meter`),
      'Detail pelanggan punya popup ganti meter');
    const editHtml = await (await admin.ambil(`/pelanggan/${idDetail}/edit`)).text();
    hasil(editHtml.includes('name="nomor_seri"') && editHtml.includes('name="merk"')
      && editHtml.includes('name="tipe"') && editHtml.includes('name="nomor_meter"'),
      'Form ubah pelanggan mencatat nomor seri, merk & tipe meter');
  }

  const halamanKode = [
    ['/sumur', 'data-kode-sumur', /value="SB-\d+"/],
    ['/dusun', 'name="kode"', /name="kode" value="D\d+"/],
    ['/tarif', 'name="kode"', /name="kode" value="G\d+"/],
  ];
  for (const [path, penanda, pola] of halamanKode) {
    const body = await (await admin.ambil(path)).text();
    hasil(body.includes(penanda) && pola.test(body), `Kode otomatis tampil di ${path}`);
  }
  const tarifHtml = await (await admin.ambil('/tarif')).text();
  hasil(tarifHtml.includes('id="modalEditBlok"') && tarifHtml.includes('data-blok-harga'),
    'Blok tarif punya tombol edit per baris');
  hasil(tarifHtml.includes('data-modal-open="modalEditGolongan') && tarifHtml.includes('Abonemen bulanan (Rp)'),
    'Abonemen bulanan bisa diatur lewat popup golongan');

  const gudangHtml = await (await admin.ambil('/bahan')).text();
  hasil(gudangHtml.includes('/pembelian?buka=modalPembelian&bahan=') && gudangHtml.includes('Buat pembelian'),
    'Gudang punya tautan beli & buat pembelian');
  const pembelianHtml = await (await admin.ambil('/pembelian')).text();
  hasil(pembelianHtml.includes('Pembelian Bahan') && pembelianHtml.includes('Catat pembelian'),
    'Menu pembelian bahan tersedia untuk admin');
  const formBeli = await (await admin.ambil('/pembelian')).text();
  hasil(formBeli.includes('barisItem') && formBeli.includes('harga[]') && formBeli.includes('terima barang')
    && formBeli.includes('id="modalPembelian"'),
    'Form pembelian memakai popup dengan isian harga nota & aksi terima barang');
  const lamaBeli = await admin.ambil('/pembelian/baru');
  hasil(lamaBeli.status === 302 && (lamaBeli.headers.get('location') || '').startsWith('/pembelian?buka=modalPembelian'),
    'Alamat lama /pembelian/baru dialihkan ke popup pembelian', `status ${lamaBeli.status}`);
  const beliDraf = await admin.ambil('/pembelian', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      tanggal: '2026-01-05', supplier: 'Uji Supplier', metode: 'tunai', aksi: 'draf',
      'bahan_id[]': '1', 'jumlah[]': '1', 'harga[]': '1000',
    }).toString(),
  });
  const lokasiBeli = beliDraf.headers.get('location') || '';
  const detailBeli = lokasiBeli ? await (await admin.ambil(lokasiBeli)).text() : '';
  hasil(beliDraf.status === 302 && detailBeli.includes('Draf') && detailBeli.includes('Uji Supplier'),
    'Admin bisa mencatat draf pembelian bahan');
  const idBeli = lokasiBeli.split('/').pop();
  if (idBeli) {
    const editBeli = await (await admin.ambil(`/pembelian/${idBeli}/edit`)).text();
    hasil(editBeli.includes('Ubah PB-') && editBeli.includes('barisItem') && editBeli.includes('Catat Pembelian Bahan') === false,
      'Halaman ubah pembelian tetap berupa halaman penuh');
    // Bersihkan nota uji (draf tidak mengubah stok).
    await admin.ambil(`/pembelian/${idBeli}/hapus`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: '',
    });
  }
  const laporanHtml = await (await admin.ambil('/laporan')).text();
  hasil(laporanHtml.includes('Pengeluaran bahan'), 'Laporan memuat pengeluaran pembelian bahan');

  const tagihanHtml = await (await admin.ambil('/tagihan')).text();
  const cetakCocok = /\/tagihan\/(\d+)\/cetak/.exec(tagihanHtml);
  hasil(tagihanHtml.includes('/cetak') && Boolean(cetakCocok), 'Daftar tagihan punya aksi cetak struk');
  if (cetakCocok) {
    const cetakRes = await admin.ambil(`/tagihan/${cetakCocok[1]}/cetak`);
    const cetakHtml = await cetakRes.text();
    hasil(cetakRes.status === 200 && cetakHtml.includes('Struk Tagihan Air')
      && cetakHtml.includes('window.print()'), 'Halaman cetak struk tagihan tersedia');
    const profilHtml = await (await admin.ambil('/profil-desa')).text();
    const namaDesa = (/name="nama"[^>]*value="([^"]+)"/.exec(profilHtml) || [])[1] || '';
    hasil(!namaDesa || cetakHtml.toLowerCase().includes(namaDesa.toLowerCase()),
      'Struk memakai nama desa/pengelola terdaftar');
    // Logo hanya muncul bila pengelola/aplikasi sudah mengunggah logo.
    const adaLogo = profilHtml.includes('Hapus logo usaha saat menyimpan');
    hasil(adaLogo ? cetakHtml.includes('kwitansi-logo') : cetakHtml.includes('kwitansi-head'),
      'Struk memakai identitas & logo usaha (bila diunggah)');
    const pelakuDesa = (/name="pelaku_usaha"[^>]*value="([^"]*)"/.exec(profilHtml) || [])[1] || '';
    hasil(!pelakuDesa || cetakHtml.includes(pelakuDesa), 'Pelaku usaha tampil di struk tagihan');
    hasil(/Tanggal terbit<\/td><td>21\s+(Januari|Februari|Maret|April|Mei|Juni|Juli|Agustus|September|Oktober|November|Desember)/.test(cetakHtml),
      'Tanggal terbit tagihan otomatis tanggal 21');
    hasil(profilHtml.includes('name="pelaku_usaha"') && profilHtml.includes('name="logo"')
      && profilHtml.includes('enctype="multipart/form-data"')
      && profilHtml.includes('profile-logo-preview'),
      'Profil pengelola punya pelaku usaha + unggah logo sendiri');
    await cekHalaman(admin, '/profil-pengelola', 200, 'Profil Pengelola');
    hasil(profilHtml.includes('Profil Pengelola'), 'Menu memakai label Profil Pengelola');
  }
  const barisTagihan = tagihanHtml.split('<dialog')[0]
    .split('<tr').filter((b) => b.includes('class="badge badge-'));
  const barisLunas = barisTagihan.filter((b) => b.includes('>Lunas<'));
  const barisBelum = barisTagihan.filter((b) => !b.includes('>Lunas<') && !b.includes('>Batal<'));
  hasil(barisLunas.length > 0 && barisLunas.every((b) => b.includes('/cetak') && !b.includes('modalBayar')),
    'Tagihan lunas memakai aksi cetak struk', `${barisLunas.length} baris`);
  hasil(barisBelum.length > 0 && barisBelum.every((b) => b.includes('modalBayar') && !b.includes('/cetak')),
    'Tagihan belum bayar memakai aksi bayar (popup)', `${barisBelum.length} baris`);
  const cariPelanggan = await admin.ambil('/tagihan/cari?q=MTR');
  const jsonCari = cariPelanggan.status === 200 ? await cariPelanggan.json() : {};
  hasil(cariPelanggan.status === 200 && Array.isArray(jsonCari.data)
    && jsonCari.data.some((p) => p.nomor_meter),
    'Pencarian pelanggan tagihan memakai nomor meter');
  hasil(Array.isArray(jsonCari.data) && jsonCari.data.every((p) => 'nomor_seri' in p),
    'Pencarian pelanggan tagihan menyertakan nomor seri meter');
  hasil(tagihanHtml.includes('id="cariPelangganTagihan"') && tagihanHtml.includes('name="pelanggan"'),
    'Filter tagihan punya pencarian nomor meter + pilihan pelanggan');
  const namaBulan = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli',
    'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  const sekarang = new Date();
  const labelBulanIni = `${namaBulan[sekarang.getMonth()]} ${sekarang.getFullYear()}`;
  const periodeHtml = await (await admin.ambil('/periode')).text();
  hasil(periodeHtml.includes(labelBulanIni) || periodeHtml.includes('masih terbuka'),
    'Halaman periode menampilkan periode berjalan / peringatan tutup');
  const barisPeriode = periodeHtml.split('<tr').filter((b) => b.includes('class="badge badge-'));
  const barisTerbuka = barisPeriode.find((b) => /class="badge badge-[a-z]+">(Baca Meter|Draf|Verifikasi|Tagihan Terbit)/.test(b));
  const tanggalPeriode = barisTerbuka
    ? (/(\d{1,2})\s+(Januari|Februari|Maret|April|Mei|Juni|Juli|Agustus|September|Oktober|November|Desember)\s+\d{4}/.exec(barisTerbuka) || [])[1]
    : null;
  hasil(!barisTerbuka || tanggalPeriode === '20',
    'Jatuh tempo periode otomatis tanggal 20', tanggalPeriode ? `tanggal ${tanggalPeriode}` : 'tidak ada periode terbuka');

  const bacaHtml = await (await admin.ambil('/periode/4/baca')).text();
  hasil(bacaHtml.includes('id="modalCatatMeter"') && bacaHtml.includes('id="pilihPelangganCatat"'),
    'Halaman baca meter punya popup catat meter');
  hasil(bacaHtml.includes('id="daftarPelangganCatat"') && bacaHtml.includes('class="combo"'),
    'Popup catat meter memakai dropdown pelanggan yang bisa dicari');
  const angkaRes = await admin.ambil('/periode/4/angka/9');
  const angkaJson = angkaRes.status === 200 ? await angkaRes.json() : {};
  hasil(angkaRes.status === 200 && Number.isFinite(Number(angkaJson.angka_lalu))
    && Boolean(angkaJson.pelanggan && angkaJson.pelanggan.nomor), 'API angka meter lalu mengembalikan data');
  const verifHtml = await (await admin.ambil('/periode/4/verifikasi')).text();
  const adaCentang = verifHtml.includes('class="pilih-baca"');
  hasil(!adaCentang || (verifHtml.includes('id="formMassal"')
    && verifHtml.includes('form="formMassal"')
    && verifHtml.includes('class="bulk-bar" hidden')),
    'Verifikasi punya multi-select & aksi massal (bar muncul saat dipilih)');
  const verifFinal = await (await admin.ambil('/periode/4/verifikasi?status=final')).text();
  hasil(!verifFinal.includes('class="pilih-baca"') && !verifFinal.includes('id="formMassal"'),
    'Tab Final tidak menampilkan aksi massal');
  const krajan = buatKlien();
  hasil(await login(krajan, 'krajan', 'krajan123'), 'Login admin dusun Krajan');
  await cekHalaman(krajan, '/', 200, 'Dusun Krajan');
  await cekHalaman(krajan, '/pelanggan', 200, 'Data dibatasi sesuai dusun Anda');
  await cekHalaman(krajan, '/dusun', 403, 'Akses ditolak');
  await cekHalaman(krajan, '/pengguna', 200, 'Akun staf');
  await cekHalaman(krajan, '/profil-desa', 403, 'Akses ditolak');
  await cekHalaman(krajan, '/profil-pengelola', 403, 'Akses ditolak');
  const daftarStafKrajan = await (await krajan.ambil('/pengguna')).text();
  hasil(daftarStafKrajan.includes('Petugas Catat Krajan') && !daftarStafKrajan.includes('Kasir Desa'),
    'Admin dusun hanya melihat staf dusunnya');
  await cekHalaman(krajan, '/pelanggan/45', 403, 'Akses ditolak');
  await cekHalaman(krajan, '/periode/4/baca/45', 403, 'Akses ditolak');

  const kasir = buatKlien();
  hasil(await login(kasir, 'kasir', 'kasir123'), 'Login kasir');
  await cekHalaman(kasir, '/tagihan', 200, 'Tagihan');
  await cekHalaman(kasir, '/laporan', 200, 'Laporan');
  await cekHalaman(kasir, '/periode/4/baca/6', 403, 'Akses ditolak');
  await cekHalaman(kasir, '/bahan', 200, 'Gudang Bahan');
  await cekHalaman(kasir, '/pembelian', 200, 'Pembelian Bahan');
  await cekHalaman(kasir, '/pasang', 200, 'Pendaftaran Pasang Baru');

  const petugas = buatKlien();
  hasil(await login(petugas, 'petugas', 'petugas123'), 'Login petugas');
  await cekHalaman(petugas, '/periode', 200, 'Periode');
  await cekHalaman(petugas, '/pelanggan/baru', 302, null);
  const formPasangPetugas = await petugas.ambil('/pelanggan/baru');
  hasil(formPasangPetugas.headers.get('location') === '/pasang?buka=modalPasang',
    'Petugas yang membuka form pelanggan lama diarahkan ke popup Pasang Baru',
    `redirect ${formPasangPetugas.headers.get('location')}`);
  await cekHalaman(petugas, '/sumur', 200, 'Sumur Bor');
  await cekHalaman(petugas, '/sumur/baru', 403, 'Akses ditolak');
  await cekHalaman(petugas, '/sumur/1/edit', 403, 'Akses ditolak');
  const gudangPetugas = await (await petugas.ambil('/bahan')).text();
  hasil(gudangPetugas.includes('Gudang Bahan') && !gudangPetugas.includes('Tambah bahan'),
    'Petugas hanya melihat stok gudang (tanpa tombol kelola)');
  await cekHalaman(petugas, '/pembelian', 403, 'Akses ditolak');
  const tambahBahanPetugas = await petugas.ambil('/bahan', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ nama: 'Bahan Uji Petugas' }).toString(),
  });
  hasil(tambahBahanPetugas.status === 403, 'Petugas tidak bisa mengubah gudang',
    `status ${tambahBahanPetugas.status}`);
  const formPasang = await (await petugas.ambil('/pasang')).text();
  hasil(formPasang.includes('Perhitungan pipa') && formPasang.includes('Simpan &amp; ajukan ke admin')
    && formPasang.includes('barisBahan') && formPasang.includes('id="modalPasang"'),
    'Petugas bisa menghitung bahan lewat popup pendaftaran pasang baru');
  hasil(formPasang.includes('id="tambahBahanBawah"') && formPasang.includes('Tambah baris bahan')
    && formPasang.includes('id="tambahBahan"') && formPasang.includes('pastikanBarisKosong'),
    'Form pasang baru punya tombol tambah baris bahan (otomatis saat baris terakhir dipakai)');
  const dusunPasang = (/<select name="dusun_id" id="dusunPasang"[\s\S]*?<option value="(\d+)"/.exec(formPasang) || [])[1];
  if (dusunPasang) {
    const buatPasang = await petugas.ambil('/pasang', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        nama: 'Uji Pasang Baru', dusun_id: dusunPasang, tanggal_survei: '2026-01-05', aksi: 'draf',
      }).toString(),
    });
    const lokasiPasang = buatPasang.headers.get('location') || '';
    const detailPasang = lokasiPasang ? await (await petugas.ambil(lokasiPasang)).text() : '';
    hasil(buatPasang.status === 302 && detailPasang.includes('Uji Pasang Baru')
      && detailPasang.includes('Rincian bahan'), 'Petugas bisa membuat draf pendaftaran pasang baru');
    const idPasang = lokasiPasang.split('/').pop();
    if (idPasang) {
      const editPasang = await (await petugas.ambil(`/pasang/${idPasang}/edit`)).text();
      hasil(editPasang.includes('Ubah Pendaftaran') && editPasang.includes('barisBahan')
        && !editPasang.includes('id="modalPasang"'),
        'Halaman ubah pendaftaran tetap berupa halaman penuh');
      // Bersihkan data uji agar tidak menumpuk di database demo.
      await petugas.ambil(`/pasang/${idPasang}/hapus`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: '',
      });
    }
  }
  const tambahSumurPetugas = await petugas.ambil('/sumur', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ dusun_id: '1', kode: 'SB-UJI', nama: 'Sumur Uji Petugas' }).toString(),
  });
  hasil(tambahSumurPetugas.status === 403, 'Petugas tidak bisa menambah sumur', `status ${tambahSumurPetugas.status}`);

  // --- Portal warga (pelanggan) ---
  const warga = buatKlien();
  hasil(await login(warga, 'warga', 'warga123'), 'Login warga');
  await cekHalaman(warga, '/warga', 200, 'Akun Saya');
  const wargaHtml = await (await warga.ambil('/warga')).text();
  hasil(wargaHtml.includes('Tagihan Saya') && wargaHtml.includes('/warga/pemakaian')
    && !wargaHtml.includes('/pelanggan"'),
    'Portal warga hanya menampilkan menu pelanggan');
  await cekHalaman(warga, '/warga/tagihan', 200, 'Daftar tagihan');
  await cekHalaman(warga, '/warga/keluhan', 200, 'Riwayat keluhan');
  const tagihanWarga = await (await warga.ambil('/warga/tagihan')).text();
  const cetakWarga = /href="(\/warga\/tagihan\/\d+\/cetak)"/.exec(tagihanWarga);
  if (cetakWarga) {
    const resCetak = await warga.ambil(cetakWarga[1]);
    hasil(resCetak.status === 200 && (await resCetak.text()).includes('Struk Tagihan Air'),
      'Warga bisa mencetak struk tagihannya sendiri');
  }
  const aksesOperator = await warga.ambil('/pelanggan');
  hasil(aksesOperator.status === 302 && aksesOperator.headers.get('location') === '/warga',
    'Warga dialihkan dari halaman operator', `status ${aksesOperator.status}`);
  const aksesGudang = await warga.ambil('/bahan');
  hasil(aksesGudang.status === 302 && aksesGudang.headers.get('location') === '/warga',
    'Warga tidak bisa membuka gudang bahan', `status ${aksesGudang.status}`);
  const penggunaHtml = await (await admin.ambil('/pengguna')).text();
  hasil(penggunaHtml.includes('name="pelanggan_id"') && penggunaHtml.includes('Pelanggan (untuk akun warga)'),
    'Form akun warga punya pilihan pelanggan');

  const superadmin = buatKlien();
  siapkanSuperUji();
  hasil(await login(superadmin, SUPER_UJI.username, SUPER_UJI.sandi), 'Login superadmin');
  await cekHalaman(superadmin, '/superadmin', 200, 'Panel Superadmin');
  await cekHalaman(superadmin, '/superadmin/pendaftaran', 200, 'Pendaftaran Pengelola');
  await cekHalaman(superadmin, '/superadmin/paket', 200, 'Paket Langganan');
  await cekHalaman(superadmin, '/superadmin/langganan', 200, 'Langganan Pengelola');
  const paketSuper = await (await superadmin.ambil('/superadmin/paket')).text();
  hasil(paketSuper.includes('id="modalPaket"') && paketSuper.includes('Maks. pelanggan'),
    'Superadmin bisa menambah/mengubah paket lewat popup');
  const langgananSuper = await (await superadmin.ambil('/superadmin/langganan')).text();
  hasil(langgananSuper.includes('data-modal-open="modalLangganan') && langgananSuper.includes('Perpanjang'),
    'Superadmin bisa mengatur paket & masa aktif tiap pengelola');
  const daftarPendaftaran = await (await superadmin.ambil('/superadmin/pendaftaran')).text();
  hasil(daftarPendaftaran.includes('id="modalBuatAkun"') && daftarPendaftaran.includes('Buat akun'),
    'Pendaftaran punya popup buat akun otomatis');
  hasil(daftarPendaftaran.includes('id="formBuatAkun"') && daftarPendaftaran.includes('Kata sandi sementara'),
    'Popup buat akun berisi isian akun otomatis');
  await cekHalaman(superadmin, '/superadmin/reset-password', 200, 'Reset Password');
  await cekHalaman(superadmin, '/superadmin/desa', 302, null);
  const panelSuperadmin = await (await superadmin.ambil('/superadmin')).text();
  hasil(panelSuperadmin.includes('dash-hero') && panelSuperadmin.includes('quick-tile'),
    'Dashboard superadmin memakai hero & aksi cepat');
  hasil(!panelSuperadmin.includes('Profil desa'), 'Panel superadmin tidak memuat profil desa');
  await cekHalaman(superadmin, '/profil-desa', 302, null);
  await cekHalaman(superadmin, '/pengaturan', 200, 'Identitas aplikasi');
  await cekHalaman(superadmin, '/pengguna', 200, 'Akun admin');
  const daftarSuper = await (await superadmin.ambil('/pengguna')).text();
  hasil(!daftarSuper.includes('Kasir Desa') && !daftarSuper.includes('Petugas Catat Krajan'),
    'Superadmin hanya melihat akun admin');
  await cekHalaman(superadmin, '/audit', 200, 'Audit Log');
  await cekHalaman(superadmin, '/', 302, null);
  await cekHalaman(superadmin, '/dusun', 302, null);
  await cekHalaman(superadmin, '/sumur', 302, null);
  await cekHalaman(superadmin, '/tagihan', 302, null);
  await cekHalaman(admin, '/superadmin', 403, 'Akses ditolak');
  await cekHalaman(admin, '/superadmin/reset-password', 403, 'Akses ditolak');
  await cekHalaman(admin, '/pengaturan', 403, 'Akses ditolak');

  // Halaman langganan milik pengelola (admin desa & admin dusun).
  await cekHalaman(admin, '/langganan', 200, 'Langganan Saya');
  const halamanLangganan = await (await admin.ambil('/langganan')).text();
  hasil(halamanLangganan.includes('Pemakaian kuota') && halamanLangganan.includes('Masa aktif'),
    'Halaman langganan menampilkan kuota & masa aktif');
  hasil(halamanLangganan.includes('Tagihan langganan'),
    'Halaman langganan menampilkan tagihan bulanan');
  hasil(halamanLangganan.includes('href="/langganan"') && halamanLangganan.includes('Paket lain yang tersedia'),
    'Menu Langganan muncul di sidebar pengelola');
  await cekHalaman(kasir, '/langganan', 403, 'Akses ditolak');
  await cekHalaman(superadmin, '/langganan', 302, null);

  const cobaSuper = await admin.ambil('/pengguna', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      nama: 'Uji Escalation', username: 'uji_super', password: 'rahasia123', role: 'superadmin',
    }).toString(),
  });
  hasil(cobaSuper.status === 302, 'Admin desa ditolak membuat akun superadmin', `status ${cobaSuper.status}`);
  const daftarSetelah = await (await superadmin.ambil('/pengguna')).text();
  hasil(!daftarSetelah.includes('uji_super'), 'Akun uji tidak tercipta');

  const keluar = await admin.ambil('/logout', { method: 'POST' });
  hasil(keluar.status === 302, 'Logout admin', `status ${keluar.status}`);
  await cekHalaman(admin, '/', 200, 'pemasukan yang terukur');

  bersihkanSuperUji();
  console.log('\n' + (gagal === 0 ? 'Semua smoke test LULUS.' : `${gagal} smoke test GAGAL.`));
  process.exit(gagal === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  try {
    bersihkanSuperUji();
  } catch (err2) {
    // abaikan
  }
  process.exit(1);
});
