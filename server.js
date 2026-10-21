'use strict';

const config = require('./src/config');
const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const layouts = require('express-ejs-layouts');
const helmet = require('helmet');

const { initDb, db } = require('./src/db');
const { attachUser } = require('./src/auth');
const helpers = require('./src/helpers');
const csrf = require('./src/services/csrf');
const rateLimit = require('./src/services/rate-limit');
const { migrasiKeStorage, folder } = require('./src/services/unggah');
const { ambilPengaturan, inisial } = require('./src/services/pengaturan');
const SqliteSessionStore = require('./src/services/session-store');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

initDb();
const dipindah = migrasiKeStorage();
if (dipindah > 0) {
  console.log(`${dipindah} berkas unggahan dipindahkan ke folder privat storage/uploads.`);
}
['logo', 'meter', 'bayar'].forEach((nama) => folder(nama));

// Pembersih berkala data pembatas laju yang sudah kedaluwarsa.
const pembersihLaju = setInterval(() => rateLimit.bersihkanKedaluwarsa(), 60 * 60 * 1000);
if (pembersihLaju.unref) pembersihLaju.unref();

// Versi aset statis (berdasarkan waktu ubah berkas) supaya browser tidak memakai
// app.js/style.css lama setelah aplikasi diperbarui.
const versiAset = (() => {
  const berkas = ['public/js/app.js', 'public/css/style.css'];
  const waktu = berkas
    .map((rel) => {
      try {
        return fs.statSync(path.join(__dirname, rel)).mtimeMs;
      } catch (err) {
        return 0;
      }
    });
  return String(Math.max(...waktu, 1)).split('.')[0];
})();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'src', 'views'));
app.use(layouts);
app.set('layout', 'layout');
app.disable('x-powered-by');
app.set('trust proxy', config.TRUST_PROXY);

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'https://www.emsifa.com'],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'same-origin' },
  hsts: config.PRODUKSI ? { maxAge: 15552000, includeSubDomains: true } : false,
  frameguard: { action: 'deny' },
  noSniff: true,
}));

app.use(express.urlencoded({ extended: true, limit: '300kb' }));
app.use(express.json({ limit: '128kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new SqliteSessionStore(),
  name: 'tirtadesa.sid',
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.COOKIE_SECURE,
    maxAge: 1000 * 60 * 60 * 8,
  },
}));

app.use(attachUser);
app.use(helpers.flashMiddleware);

app.use((req, res, next) => {
  res.locals.currentPath = req.path;
  res.locals.versiAset = versiAset;
  res.locals.rupiah = helpers.rupiah;
  res.locals.angka = helpers.angka;
  res.locals.tanggal = helpers.tanggal;
  res.locals.periodeLabel = helpers.periodeLabel;
  res.locals.statusKelas = helpers.statusKelas;
  res.locals.statusLabel = helpers.STATUS_LABEL;
  res.locals.terbilang = helpers.terbilang;
  res.locals.today = helpers.todayISO();
  res.locals.dusunScope = req.user ? (req.user.role === 'admin_desa' || req.user.role === 'superadmin' ? null : req.user.dusun_id) : null;
  const setelan = ambilPengaturan();
  res.locals.pengaturan = setelan;
  res.locals.brandInisial = inisial(setelan.nama_aplikasi);
  // Identitas pengelola (desa/usaha) milik pengguna yang login.
  res.locals.desaAktif = req.user && req.user.desa_id
    ? db.prepare('SELECT * FROM desa WHERE id = ?').get(req.user.desa_id)
    : null;
  // Akun demo disembunyikan otomatis saat NODE_ENV=production,
  // kecuali sengaja diaktifkan dengan TAMPILKAN_AKUN_DEMO=1.
  res.locals.tampilkanDemo = process.env.NODE_ENV !== 'production' || process.env.TAMPILKAN_AKUN_DEMO === '1';
  next();
});

// Token CSRF + helper JSON aman. Token hanya dibuat saat diperlukan agar
// pengunjung halaman publik tidak memenuhi tabel sesi.
app.use((req, res, next) => {
  const butuhToken = !req.path.startsWith('/uploads/')
    && (Boolean(req.user)
      || Boolean(req.session.pending2fa)
      || ['/login', '/gabung', '/lupa-password', '/2fa/verifikasi'].includes(req.path));
  res.locals.csrfToken = butuhToken ? csrf.token(req) : '';
  res.locals.jsonAman = helpers.jsonAman;
  next();
});
app.use(csrf.middleware);

// Halaman terautentikasi tidak boleh disimpan di cache browser.
app.use((req, res, next) => {
  if (req.user) res.set('Cache-Control', 'no-store');
  next();
});

// Akun dengan kata sandi sementara wajib menggantinya lebih dulu.
app.use((req, res, next) => {
  if (!req.user || !req.user.must_change_password) return next();
  if (['/ganti-password', '/logout', '/login', '/uploads'].some((p) => req.path === p || req.path.startsWith(`${p}/`))) return next();
  return res.redirect('/ganti-password');
});

// Superadmin wajib 2FA (produksi) dan sesi lama tanpa verifikasi 2FA dipaksa login ulang.
app.use((req, res, next) => {
  if (!req.user || req.user.role !== 'superadmin') return next();
  const terbuka = req.path === '/2fa' || req.path.startsWith('/2fa/')
    || ['/logout', '/login', '/ganti-password', '/uploads'].includes(req.path)
    || req.path.startsWith('/uploads/');
  if (terbuka) return next();
  if (!req.user.totp_enabled) {
    return config.WAJIB_2FA ? res.redirect('/2fa/pengaturan') : next();
  }
  if (!req.session.totpVerified) {
    return req.session.destroy(() => res.redirect('/login?perlu2fa=1'));
  }
  return next();
});

// Batasi unggahan berkas agar tidak bisa dipakai menguras penyimpanan.
app.use((req, res, next) => {
  if (req.method !== 'POST' || !req.is('multipart/form-data')) return next();
  const kunci = req.user ? `unggah:user:${req.user.id}` : `unggah:ip:${req.ip}`;
  const hasil = rateLimit.tambah(kunci, 40, 60 * 60 * 1000);
  if (hasil.diblokir) {
    return res.status(429).render('error', {
      title: 'Terlalu banyak unggahan',
      message: 'Batas unggahan per jam tercapai. Coba lagi nanti.',
    });
  }
  return next();
});

// Superadmin hanya mengelola pendaftaran & akun pengguna.
// Data operasional (dusun, sumur, pelanggan, tagihan, dsb.) dikelola admin terdaftar.
const JALUR_SUPERADMIN = ['/superadmin', '/pengguna', '/pengaturan', '/audit', '/login', '/logout', '/ganti-password', '/2fa', '/uploads'];
app.use((req, res, next) => {
  if (!req.user || req.user.role !== 'superadmin') return next();
  if (JALUR_SUPERADMIN.some((p) => req.path === p || req.path.startsWith(`${p}/`))) return next();
  if (req.method === 'GET') return res.redirect('/superadmin');
  return res.status(403).render('error', {
    title: 'Akses ditolak',
    message: 'Superadmin hanya mengelola pendaftaran dan akun pengguna. Data operasional dikelola oleh admin yang terdaftar.',
  });
});

// Akun warga (pelanggan) hanya boleh membuka portal warga.
const JALUR_WARGA = ['/warga', '/login', '/logout', '/ganti-password', '/uploads'];
app.use((req, res, next) => {
  if (!req.user || req.user.role !== 'warga') return next();
  const boleh = JALUR_WARGA.some((p) => req.path === p || req.path.startsWith(`${p}/`));
  if (boleh) return next();
  return res.redirect('/warga');
});

app.use('/', require('./src/routes/unggahan'));
app.use('/', require('./src/routes/auth'));
app.use('/', require('./src/routes/dua-faktor'));
app.use('/', require('./src/routes/ganti-password'));
app.use('/', require('./src/routes/lupa-password'));
app.use('/', require('./src/routes/home'));
app.use('/', require('./src/routes/gabung'));
app.use('/', require('./src/routes/dashboard'));
app.use('/warga', require('./src/routes/warga'));
app.use('/', require('./src/routes/master'));
app.use('/', require('./src/routes/gudang'));
app.use('/', require('./src/routes/pembelian'));
app.use('/', require('./src/routes/pasang'));
app.use('/', require('./src/routes/periode'));
app.use('/', require('./src/routes/tagihan'));
app.use('/', require('./src/routes/bayar-online'));
app.use('/', require('./src/routes/produksi'));
app.use('/', require('./src/routes/keluhan'));
app.use('/', require('./src/routes/laporan'));
app.use('/', require('./src/routes/kepegawaian'));
app.use('/', require('./src/routes/superadmin'));
app.use('/', require('./src/routes/langganan-pengelola'));
app.use('/', require('./src/routes/pengaturan'));
app.use('/', require('./src/routes/profil-desa'));

app.use((req, res) => {
  if (!req.user) return res.redirect('/login');
  return res.status(404).render('error', {
    title: 'Halaman tidak ditemukan',
    message: `Alamat ${req.originalUrl} tidak tersedia.`,
  });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  if (!req.user) return res.status(500).send('Terjadi kesalahan pada server.');
  return res.status(500).render('error', {
    title: 'Terjadi kesalahan',
    message: config.PRODUKSI
      ? 'Terjadi kesalahan pada server. Silakan coba lagi atau hubungi administrator.'
      : `Terjadi kesalahan pada server (${err.message || 'tanpa pesan'}).`,
  });
});

if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`TirtaDesa berjalan di http://localhost:${PORT}`);
    if (config.SEED_DEMO) {
      console.log('Login demo: admin/admin123 · krajan/krajan123 · petugas/petugas123 · kasir/kasir123 · warga/warga123');
    }
    if (config.WAJIB_2FA) console.log('2FA wajib untuk superadmin.');
  });

  const tutup = (sinyal) => {
    console.log(`Menerima ${sinyal}, menutup server…`);
    server.close(() => {
      try {
        db.close();
      } catch (err) {
        // abaikan
      }
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => tutup('SIGTERM'));
  process.on('SIGINT', () => tutup('SIGINT'));
}

module.exports = app;
