'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { hitungTagihan } = require('./services/tarif');
const { PRODUKSI, SEED_DEMO } = require('./config');
const { hashSandi, validasiSandi } = require('./services/sandi');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'pdam.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS desa (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nama TEXT NOT NULL,
  kecamatan TEXT,
  kabupaten TEXT,
  alamat TEXT,
  telepon TEXT,
  pelaku_usaha TEXT,
  logo_path TEXT
);

CREATE TABLE IF NOT EXISTS dusun (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  desa_id INTEGER NOT NULL REFERENCES desa(id),
  kode TEXT NOT NULL UNIQUE,
  nama TEXT NOT NULL,
  kepala_dusun TEXT,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  desa_id INTEGER NOT NULL REFERENCES desa(id),
  dusun_id INTEGER REFERENCES dusun(id),
  pelanggan_id INTEGER REFERENCES pelanggan(id),
  nama TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('superadmin','admin_desa','admin_dusun','petugas_catat','kasir','warga')),
  is_active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  totp_recovery TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS sumur (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dusun_id INTEGER NOT NULL REFERENCES dusun(id),
  kode TEXT NOT NULL,
  nama TEXT NOT NULL,
  alamat TEXT,
  kapasitas_lps REAL,
  tahun_bor INTEGER,
  nomor_meter_induk TEXT,
  status TEXT NOT NULL DEFAULT 'aktif' CHECK (status IN ('aktif','perbaikan','nonaktif')),
  catatan TEXT,
  UNIQUE (dusun_id, kode)
);

CREATE TABLE IF NOT EXISTS golongan_tarif (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  desa_id INTEGER NOT NULL REFERENCES desa(id),
  kode TEXT NOT NULL,
  nama TEXT NOT NULL,
  abonemen REAL NOT NULL DEFAULT 0,
  min_pemakaian_m3 REAL NOT NULL DEFAULT 0,
  denda_persen REAL NOT NULL DEFAULT 0,
  denda_maks_persen REAL NOT NULL DEFAULT 0,
  UNIQUE (desa_id, kode)
);

CREATE TABLE IF NOT EXISTS tarif_blok (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  golongan_id INTEGER NOT NULL REFERENCES golongan_tarif(id) ON DELETE CASCADE,
  blok_ke INTEGER NOT NULL,
  dari_m3 REAL NOT NULL,
  sampai_m3 REAL,
  harga_per_m3 REAL NOT NULL,
  berlaku_mulai TEXT NOT NULL DEFAULT '2020-01-01',
  UNIQUE (golongan_id, blok_ke, berlaku_mulai)
);

CREATE TABLE IF NOT EXISTS pelanggan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  desa_id INTEGER NOT NULL REFERENCES desa(id),
  dusun_id INTEGER NOT NULL REFERENCES dusun(id),
  sumur_id INTEGER REFERENCES sumur(id),
  golongan_id INTEGER NOT NULL REFERENCES golongan_tarif(id),
  nomor_pelanggan TEXT NOT NULL,
  nama TEXT NOT NULL,
  nik TEXT,
  alamat TEXT,
  rt TEXT,
  rw TEXT,
  telepon TEXT,
  status TEXT NOT NULL DEFAULT 'aktif' CHECK (status IN ('aktif','nonaktif','tunggakan_berat')),
  tanggal_daftar TEXT,
  UNIQUE (desa_id, nomor_pelanggan)
);

CREATE TABLE IF NOT EXISTS sambungan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pelanggan_id INTEGER NOT NULL REFERENCES pelanggan(id),
  nomor_meter TEXT NOT NULL UNIQUE,
  nomor_seri TEXT,
  merk TEXT,
  tipe TEXT,
  ukuran_inch REAL,
  status TEXT NOT NULL DEFAULT 'aktif' CHECK (status IN ('aktif','diganti','dicabut')),
  tanggal_pasang TEXT,
  tanggal_lepas TEXT,
  alasan_ganti TEXT
);

CREATE TABLE IF NOT EXISTS periode_tagihan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  desa_id INTEGER NOT NULL REFERENCES desa(id),
  tahun INTEGER NOT NULL,
  bulan INTEGER NOT NULL,
  tanggal_jatuh_tempo TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','baca_meter','verifikasi','tagihan_terbit','tutup')),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (desa_id, tahun, bulan)
);

CREATE TABLE IF NOT EXISTS pembacaan_meter (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  periode_id INTEGER NOT NULL REFERENCES periode_tagihan(id),
  pelanggan_id INTEGER NOT NULL REFERENCES pelanggan(id),
  sambungan_id INTEGER NOT NULL REFERENCES sambungan(id),
  petugas_id INTEGER REFERENCES users(id),
  angka_lalu REAL NOT NULL DEFAULT 0,
  angka_kini REAL NOT NULL DEFAULT 0,
  pemakaian_m3 REAL NOT NULL DEFAULT 0,
  kondisi_meter TEXT NOT NULL DEFAULT 'normal' CHECK (kondisi_meter IN ('normal','rusak','macet','tidak_dihuni')),
  tanggal_baca TEXT,
  catatan TEXT,
  foto_path TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','diajukan','final','ditolak')),
  alasan_tolak TEXT,
  diverifikasi_oleh INTEGER REFERENCES users(id),
  diverifikasi_at TEXT,
  client_uuid TEXT UNIQUE,
  UNIQUE (periode_id, sambungan_id)
);

CREATE TABLE IF NOT EXISTS tagihan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  periode_id INTEGER NOT NULL REFERENCES periode_tagihan(id),
  pelanggan_id INTEGER NOT NULL REFERENCES pelanggan(id),
  sambungan_id INTEGER NOT NULL REFERENCES sambungan(id),
  dusun_id INTEGER NOT NULL REFERENCES dusun(id),
  nomor_tagihan TEXT NOT NULL UNIQUE,
  pemakaian_m3 REAL NOT NULL DEFAULT 0,
  abonemen REAL NOT NULL DEFAULT 0,
  biaya_pemakaian REAL NOT NULL DEFAULT 0,
  denda REAL NOT NULL DEFAULT 0,
  biaya_lain REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  terbayar REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'belum_bayar' CHECK (status IN ('belum_bayar','sebagian','lunas','tunggakan','batal')),
  tanggal_terbit TEXT,
  jatuh_tempo TEXT,
  keterangan TEXT,
  UNIQUE (periode_id, pelanggan_id)
);

CREATE TABLE IF NOT EXISTS tagihan_item (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tagihan_id INTEGER NOT NULL REFERENCES tagihan(id) ON DELETE CASCADE,
  jenis TEXT NOT NULL,
  keterangan TEXT,
  qty REAL NOT NULL DEFAULT 1,
  harga_satuan REAL NOT NULL DEFAULT 0,
  subtotal REAL NOT NULL DEFAULT 0,
  urutan INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS pembayaran (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tagihan_id INTEGER NOT NULL REFERENCES tagihan(id),
  nomor_kwitansi TEXT NOT NULL UNIQUE,
  tanggal_bayar TEXT NOT NULL,
  jumlah REAL NOT NULL,
  metode TEXT NOT NULL DEFAULT 'tunai' CHECK (metode IN ('tunai','transfer','qris','lain')),
  kasir_id INTEGER REFERENCES users(id),
  catatan TEXT,
  status TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','batal')),
  dibatalkan_oleh INTEGER REFERENCES users(id),
  alasan_batal TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS produksi_air (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sumur_id INTEGER NOT NULL REFERENCES sumur(id),
  tanggal TEXT NOT NULL,
  meter_awal REAL NOT NULL DEFAULT 0,
  meter_akhir REAL NOT NULL DEFAULT 0,
  volume_m3 REAL NOT NULL DEFAULT 0,
  jam_operasi REAL,
  catatan TEXT,
  dicatat_oleh INTEGER REFERENCES users(id),
  UNIQUE (sumur_id, tanggal)
);

CREATE TABLE IF NOT EXISTS keluhan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dusun_id INTEGER NOT NULL REFERENCES dusun(id),
  pelanggan_id INTEGER REFERENCES pelanggan(id),
  sumur_id INTEGER REFERENCES sumur(id),
  kategori TEXT NOT NULL,
  deskripsi TEXT NOT NULL,
  prioritas TEXT NOT NULL DEFAULT 'sedang',
  status TEXT NOT NULL DEFAULT 'baru' CHECK (status IN ('baru','diproses','selesai','ditutup')),
  dilaporkan_oleh TEXT,
  telepon TEXT,
  ditangani_oleh INTEGER REFERENCES users(id),
  tanggal_lapor TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  tanggal_selesai TEXT,
  tindak_lanjut TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  aksi TEXT NOT NULL,
  entitas TEXT NOT NULL,
  entitas_id INTEGER,
  detail TEXT,
  ip_address TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_users_dusun ON users(dusun_id);
CREATE INDEX IF NOT EXISTS idx_sumur_dusun ON sumur(dusun_id);
CREATE INDEX IF NOT EXISTS idx_pelanggan_dusun ON pelanggan(dusun_id);
CREATE INDEX IF NOT EXISTS idx_pelanggan_sumur ON pelanggan(sumur_id);
CREATE INDEX IF NOT EXISTS idx_baca_periode ON pembacaan_meter(periode_id);
CREATE INDEX IF NOT EXISTS idx_baca_pelanggan ON pembacaan_meter(pelanggan_id);
CREATE INDEX IF NOT EXISTS idx_tagihan_dusun ON tagihan(dusun_id);
CREATE INDEX IF NOT EXISTS idx_tagihan_periode ON tagihan(periode_id);
CREATE INDEX IF NOT EXISTS idx_bayar_tagihan ON pembayaran(tagihan_id);
CREATE INDEX IF NOT EXISTS idx_bayar_tanggal ON pembayaran(tanggal_bayar);
CREATE INDEX IF NOT EXISTS idx_produksi_sumur ON produksi_air(sumur_id, tanggal);
CREATE INDEX IF NOT EXISTS idx_keluhan_dusun ON keluhan(dusun_id, status);
CREATE INDEX IF NOT EXISTS idx_audit_waktu ON audit_log(created_at);
`;

const SKEMA_PENDAFTARAN = `
CREATE TABLE IF NOT EXISTS pendaftaran_pengelola (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jenis TEXT NOT NULL DEFAULT 'individu' CHECK (jenis IN ('desa','dusun','individu')),
  nama TEXT NOT NULL,
  usaha TEXT NOT NULL,
  lokasi TEXT NOT NULL,
  provinsi TEXT,
  jumlah_pelanggan INTEGER,
  whatsapp TEXT NOT NULL,
  email TEXT,
  pesan TEXT,
  user_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'baru' CHECK (status IN ('baru','dihubungi','diterima','ditolak')),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_pendaftaran_status ON pendaftaran_pengelola(status);
`;

const SKEMA_PENGATURAN = `
CREATE TABLE IF NOT EXISTS pengaturan (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  nama_aplikasi TEXT NOT NULL DEFAULT 'TirtaDesa',
  tagline TEXT NOT NULL DEFAULT 'Platform Pengelolaan Sumur Bor',
  logo_path TEXT,
  bayar_online_aktif INTEGER NOT NULL DEFAULT 1,
  bayar_online_info TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

INSERT OR IGNORE INTO pengaturan (id) VALUES (1);
`;

const SKEMA_RESET = `
CREATE TABLE IF NOT EXISTS permintaan_reset (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  nama TEXT,
  whatsapp TEXT NOT NULL,
  pesan TEXT,
  status TEXT NOT NULL DEFAULT 'baru' CHECK (status IN ('baru','diproses','selesai')),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_reset_status ON permintaan_reset(status);
`;

// ---------------------------------------------------------------------------
// GUDANG BAHAN & PENDAFTARAN PASANG BARU
// Alur: petugas mendaftar calon pelanggan + hitung kebutuhan pipa/bahan →
// admin memverifikasi & menyetujui (stok otomatis dikeluarkan) → pemasangan
// selesai dan data pelanggan + meter dibuat otomatis.
// ---------------------------------------------------------------------------
const SKEMA_GUDANG = `
CREATE TABLE IF NOT EXISTS bahan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  desa_id INTEGER NOT NULL REFERENCES desa(id),
  kode TEXT NOT NULL,
  nama TEXT NOT NULL,
  kategori TEXT NOT NULL DEFAULT 'pipa'
    CHECK (kategori IN ('pipa','fitting','meter','aksesoris','alat','lain')),
  satuan TEXT NOT NULL DEFAULT 'buah',
  stok REAL NOT NULL DEFAULT 0,
  stok_minimum REAL NOT NULL DEFAULT 0,
  harga_satuan REAL NOT NULL DEFAULT 0,
  lokasi TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (desa_id, kode)
);

CREATE TABLE IF NOT EXISTS bahan_mutasi (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bahan_id INTEGER NOT NULL REFERENCES bahan(id),
  jenis TEXT NOT NULL CHECK (jenis IN ('masuk','keluar','koreksi')),
  jumlah REAL NOT NULL DEFAULT 0,
  stok_akhir REAL NOT NULL DEFAULT 0,
  referensi TEXT,
  keterangan TEXT,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS pendaftaran_pasang (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  desa_id INTEGER NOT NULL REFERENCES desa(id),
  nomor TEXT NOT NULL UNIQUE,
  dusun_id INTEGER NOT NULL REFERENCES dusun(id),
  sumur_id INTEGER REFERENCES sumur(id),
  golongan_id INTEGER REFERENCES golongan_tarif(id),
  nama TEXT NOT NULL,
  nik TEXT,
  alamat TEXT,
  rt TEXT,
  rw TEXT,
  telepon TEXT,
  jumlah_penghuni INTEGER,
  tanggal_survei TEXT,
  ukuran_pipa TEXT,
  panjang_pipa REAL NOT NULL DEFAULT 0,
  kedalaman_tapping REAL,
  catatan TEXT,
  biaya_jasa REAL NOT NULL DEFAULT 0,
  total_bahan REAL NOT NULL DEFAULT 0,
  total_biaya REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draf'
    CHECK (status IN ('draf','diajukan','disetujui','ditolak','terpasang','dibatalkan')),
  alasan_tolak TEXT,
  catatan_admin TEXT,
  diajukan_oleh INTEGER REFERENCES users(id),
  diajukan_at TEXT,
  disetujui_oleh INTEGER REFERENCES users(id),
  disetujui_at TEXT,
  pelanggan_id INTEGER REFERENCES pelanggan(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS pendaftaran_bahan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pendaftaran_id INTEGER NOT NULL REFERENCES pendaftaran_pasang(id) ON DELETE CASCADE,
  bahan_id INTEGER NOT NULL REFERENCES bahan(id),
  nama_bahan TEXT,
  satuan TEXT,
  jumlah REAL NOT NULL DEFAULT 0,
  harga_satuan REAL NOT NULL DEFAULT 0,
  subtotal REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pembelian (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  desa_id INTEGER NOT NULL REFERENCES desa(id),
  nomor TEXT NOT NULL UNIQUE,
  tanggal TEXT NOT NULL,
  supplier TEXT,
  metode TEXT NOT NULL DEFAULT 'tunai' CHECK (metode IN ('tunai','transfer','kredit','lain')),
  catatan TEXT,
  total REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draf' CHECK (status IN ('draf','diterima','dibatalkan')),
  dibuat_oleh INTEGER REFERENCES users(id),
  diterima_oleh INTEGER REFERENCES users(id),
  diterima_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS pembelian_item (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pembelian_id INTEGER NOT NULL REFERENCES pembelian(id) ON DELETE CASCADE,
  bahan_id INTEGER NOT NULL REFERENCES bahan(id),
  nama_bahan TEXT,
  satuan TEXT,
  jumlah REAL NOT NULL DEFAULT 0,
  harga_satuan REAL NOT NULL DEFAULT 0,
  subtotal REAL NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_bahan_desa ON bahan(desa_id, kategori);
CREATE INDEX IF NOT EXISTS idx_mutasi_bahan ON bahan_mutasi(bahan_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pasang_desa ON pendaftaran_pasang(desa_id, status);
CREATE INDEX IF NOT EXISTS idx_pasang_bahan ON pendaftaran_bahan(pendaftaran_id);
CREATE INDEX IF NOT EXISTS idx_pembelian_desa ON pembelian(desa_id, status, tanggal);
CREATE INDEX IF NOT EXISTS idx_pembelian_item ON pembelian_item(pembelian_id);
`;

// ---------------------------------------------------------------------------
// KEPEGAWAIAN & PENGGAJIAN
// Karyawan dikelola terpisah dari akun pengguna (tidak semua karyawan punya
// akun login). Absensi harian menjadi dasar potongan alpa dan upah lembur.
// Slip gaji dibuat per karyawan per bulan, bisa dicetak, dan pengeluaran gaji
// yang sudah dibayar ikut tampil di Laporan.
// ---------------------------------------------------------------------------
const SKEMA_KEPEGAWAIAN = `
CREATE TABLE IF NOT EXISTS karyawan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  desa_id INTEGER NOT NULL REFERENCES desa(id),
  dusun_id INTEGER REFERENCES dusun(id),
  nomor TEXT NOT NULL,
  nama TEXT NOT NULL,
  nik TEXT,
  jabatan TEXT,
  telepon TEXT,
  tanggal_masuk TEXT,
  tanggal_keluar TEXT,
  status TEXT NOT NULL DEFAULT 'aktif' CHECK (status IN ('aktif','nonaktif')),
  gaji_pokok REAL NOT NULL DEFAULT 0,
  tunjangan_tetap REAL NOT NULL DEFAULT 0,
  potongan_tetap REAL NOT NULL DEFAULT 0,
  tarif_lembur REAL NOT NULL DEFAULT 0,
  potongan_alpa REAL NOT NULL DEFAULT 0,
  rekening TEXT,
  catatan TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (desa_id, nomor)
);

CREATE TABLE IF NOT EXISTS absensi (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  karyawan_id INTEGER NOT NULL REFERENCES karyawan(id) ON DELETE CASCADE,
  tanggal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'hadir'
    CHECK (status IN ('hadir','izin','sakit','cuti','alpa','libur')),
  jam_masuk TEXT,
  jam_keluar TEXT,
  lembur_jam REAL NOT NULL DEFAULT 0,
  keterangan TEXT,
  dicatat_oleh INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (karyawan_id, tanggal)
);

CREATE TABLE IF NOT EXISTS kasbon (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  desa_id INTEGER NOT NULL REFERENCES desa(id),
  karyawan_id INTEGER NOT NULL REFERENCES karyawan(id),
  nomor TEXT NOT NULL,
  tanggal TEXT NOT NULL,
  jumlah REAL NOT NULL DEFAULT 0,
  keterangan TEXT,
  status TEXT NOT NULL DEFAULT 'terbuka' CHECK (status IN ('terbuka','lunas','dibatalkan')),
  dibuat_oleh INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (desa_id, nomor)
);

CREATE TABLE IF NOT EXISTS kasbon_bayar (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kasbon_id INTEGER NOT NULL REFERENCES kasbon(id) ON DELETE CASCADE,
  tanggal TEXT NOT NULL,
  jumlah REAL NOT NULL DEFAULT 0,
  keterangan TEXT,
  dicatat_oleh INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS penggajian (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  desa_id INTEGER NOT NULL REFERENCES desa(id),
  karyawan_id INTEGER NOT NULL REFERENCES karyawan(id),
  nomor TEXT NOT NULL,
  tahun INTEGER NOT NULL,
  bulan INTEGER NOT NULL,
  hari_hadir INTEGER NOT NULL DEFAULT 0,
  hari_izin INTEGER NOT NULL DEFAULT 0,
  hari_sakit INTEGER NOT NULL DEFAULT 0,
  hari_cuti INTEGER NOT NULL DEFAULT 0,
  hari_alpa INTEGER NOT NULL DEFAULT 0,
  lembur_jam REAL NOT NULL DEFAULT 0,
  gaji_pokok REAL NOT NULL DEFAULT 0,
  tunjangan REAL NOT NULL DEFAULT 0,
  upah_lembur REAL NOT NULL DEFAULT 0,
  bonus REAL NOT NULL DEFAULT 0,
  potongan_alpa REAL NOT NULL DEFAULT 0,
  potongan_tetap REAL NOT NULL DEFAULT 0,
  potongan_kasbon REAL NOT NULL DEFAULT 0,
  total_pendapatan REAL NOT NULL DEFAULT 0,
  total_potongan REAL NOT NULL DEFAULT 0,
  gaji_bersih REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draf' CHECK (status IN ('draf','dibayar')),
  tanggal_bayar TEXT,
  metode TEXT,
  catatan TEXT,
  dibuat_oleh INTEGER REFERENCES users(id),
  dibayar_oleh INTEGER REFERENCES users(id),
  dibayar_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (karyawan_id, tahun, bulan),
  UNIQUE (desa_id, nomor)
);

CREATE INDEX IF NOT EXISTS idx_karyawan_desa ON karyawan(desa_id, status);
CREATE INDEX IF NOT EXISTS idx_karyawan_dusun ON karyawan(dusun_id);
CREATE INDEX IF NOT EXISTS idx_absensi_karyawan ON absensi(karyawan_id, tanggal);
CREATE INDEX IF NOT EXISTS idx_kasbon_karyawan ON kasbon(karyawan_id, status);
CREATE INDEX IF NOT EXISTS idx_kasbon_bayar ON kasbon_bayar(kasbon_id);
CREATE INDEX IF NOT EXISTS idx_penggajian_periode ON penggajian(desa_id, tahun, bulan, status);
`;

// ---------------------------------------------------------------------------
// PAKET LANGGANAN (KOMERSIAL)
// Batas 0 = tanpa batas. Kuota diperiksa saat menambah pelanggan/sumur/dusun.
// ---------------------------------------------------------------------------
const SKEMA_LANGGANAN = `
CREATE TABLE IF NOT EXISTS paket (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kode TEXT NOT NULL UNIQUE,
  nama TEXT NOT NULL,
  deskripsi TEXT,
  harga INTEGER NOT NULL DEFAULT 0,
  maks_pelanggan INTEGER NOT NULL DEFAULT 0,
  maks_sumur INTEGER NOT NULL DEFAULT 0,
  maks_dusun INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  urutan INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_paket_aktif ON paket(is_active, urutan);
`;

// ---------------------------------------------------------------------------
// PEMBAYARAN ONLINE WARGA
// Saluran bayar (rekening/QRIS/link) diatur superadmin. Warga mengajukan
// pembayaran dari portalnya; kasir/admin desa memverifikasi menjadi kwitansi.
// ---------------------------------------------------------------------------
const SKEMA_BAYAR_ONLINE = `
CREATE TABLE IF NOT EXISTS saluran_bayar (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nama TEXT NOT NULL,
  jenis TEXT NOT NULL DEFAULT 'transfer' CHECK (jenis IN ('transfer','qris','link')),
  penyedia TEXT,
  nomor_tujuan TEXT,
  atas_nama TEXT,
  gambar_path TEXT,
  url_bayar TEXT,
  instruksi TEXT,
  urutan INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS pembayaran_online (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kode TEXT NOT NULL UNIQUE,
  tagihan_id INTEGER NOT NULL REFERENCES tagihan(id),
  pelanggan_id INTEGER NOT NULL REFERENCES pelanggan(id),
  desa_id INTEGER NOT NULL REFERENCES desa(id),
  dusun_id INTEGER NOT NULL REFERENCES dusun(id),
  saluran_id INTEGER REFERENCES saluran_bayar(id),
  jumlah REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'menunggu' CHECK (status IN ('menunggu','dikonfirmasi','ditolak')),
  bukti_path TEXT,
  catatan_warga TEXT,
  pembayaran_id INTEGER REFERENCES pembayaran(id),
  diproses_oleh INTEGER REFERENCES users(id),
  catatan_admin TEXT,
  diproses_pada TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_saluran_urut ON saluran_bayar(is_active, urutan);
CREATE INDEX IF NOT EXISTS idx_bayar_online_status ON pembayaran_online(desa_id, status);
CREATE INDEX IF NOT EXISTS idx_bayar_online_tagihan ON pembayaran_online(tagihan_id);
`;

// ---------------------------------------------------------------------------
// TAGIHAN LANGGANAN (iuran bulanan pengelola ke penyedia layanan)
// Dibuat otomatis per siklus, dibayar lewat saluran pembayaran yang sama.
// ---------------------------------------------------------------------------
const SKEMA_TAGIHAN_LANGGANAN = `
CREATE TABLE IF NOT EXISTS tagihan_langganan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  desa_id INTEGER NOT NULL REFERENCES desa(id),
  nomor TEXT NOT NULL UNIQUE,
  paket_id INTEGER REFERENCES paket(id),
  paket_nama TEXT NOT NULL,
  periode_mulai TEXT NOT NULL,
  periode_sampai TEXT NOT NULL,
  jumlah REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'belum_bayar' CHECK (status IN ('belum_bayar','menunggu','lunas','batal')),
  saluran_id INTEGER REFERENCES saluran_bayar(id),
  bukti_path TEXT,
  catatan TEXT,
  catatan_admin TEXT,
  divalidasi_oleh INTEGER REFERENCES users(id),
  divalidasi_pada TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_tagihan_langganan_desa ON tagihan_langganan(desa_id, status);
`;

// Paket awal yang bisa langsung dipakai/diubah superadmin.
const PAKET_AWAL = [
  ['STARTER', 'Starter', 'Untuk pengelola dusun / usaha kecil', 150000, 100, 2, 1, 1],
  ['GROWTH', 'Growth', 'Untuk desa dengan beberapa dusun', 450000, 500, 5, 5, 2],
  ['BISNIS', 'Bisnis', 'Untuk pengelola dengan jaringan luas', 1250000, 2000, 15, 20, 3],
  ['ENTERPRISE', 'Enterprise', 'Tanpa batas pelanggan, sumur, dan dusun', 2500000, 0, 0, 0, 4],
];

// Bahan bawaan gudang agar pengelola baru langsung punya daftar item standar.
const BAHAN_AWAL = [
  ['PIPA-050', 'Pipa HDPE 1/2 inci (batang 4 m)', 'pipa', 'batang', 40, 10, 45000],
  ['PIPA-075', 'Pipa HDPE 3/4 inci (batang 4 m)', 'pipa', 'batang', 24, 8, 65000],
  ['PIPA-100', 'Pipa HDPE 1 inci (batang 4 m)', 'pipa', 'batang', 16, 6, 95000],
  ['FIT-ELB', 'Elbow / knee 1/2 inci', 'fitting', 'buah', 60, 20, 4000],
  ['FIT-TEE', 'Tee 1/2 inci', 'fitting', 'buah', 40, 15, 6000],
  ['FIT-SOK', 'Sok / socket 1/2 inci', 'fitting', 'buah', 60, 20, 3000],
  ['FIT-KRAAN', 'Kran meter 1/2 inci', 'fitting', 'buah', 25, 10, 35000],
  ['MTR-050', 'Meter air 1/2 inci', 'meter', 'unit', 20, 5, 250000],
  ['AKS-SEAL', 'Segel meter air', 'aksesoris', 'buah', 50, 20, 5000],
  ['AKS-TAP', 'Tapping saddle 1/2 inci', 'aksesoris', 'buah', 15, 5, 45000],
  ['AKS-LEM', 'Lem PVC (kaleng)', 'aksesoris', 'kaleng', 10, 3, 25000],
  ['ALT-KUNCI', 'Kunci pipa', 'alat', 'unit', 2, 1, 120000],
];

/**
 * Paket langganan awal (bisa diubah superadmin di menu Paket Langganan).
 * Batas 0 berarti tanpa batas.
 */
function pastikanPaketAwal() {
  const ada = db.prepare('SELECT COUNT(*) AS n FROM paket').get().n;
  if (ada > 0) return;
  const insert = db.prepare(`INSERT INTO paket
    (kode, nama, deskripsi, harga, maks_pelanggan, maks_sumur, maks_dusun, urutan)
    VALUES (?,?,?,?,?,?,?,?)`);
  db.transaction(() => {
    PAKET_AWAL.forEach(([kode, nama, deskripsi, harga, mp, ms, md, urutan]) => {
      insert.run(kode, nama, deskripsi, harga, mp, ms, md, urutan);
    });
  })();
}

/**
 * Database lama: tambahkan kolom paket pada pengelola & pendaftaran, lalu
 * tautkan pengelola yang belum punya paket ke paket "tanpa batas" agar tidak
 * tiba-tiba terbentur kuota.
 */
function pastikanLangganan() {
  const kolomDesa = db.prepare('PRAGMA table_info(desa)').all().map((c) => c.name);
  const tambahanDesa = [
    ['paket_id', 'INTEGER REFERENCES paket(id)'],
    ['langganan_mulai', 'TEXT'],
    ['langganan_sampai', 'TEXT'],
    ['status_langganan', "TEXT NOT NULL DEFAULT 'aktif'"],
  ];
  tambahanDesa.forEach(([nama, tipe]) => {
    if (!kolomDesa.includes(nama)) db.exec(`ALTER TABLE desa ADD COLUMN ${nama} ${tipe}`);
  });

  const kolomDaftar = db.prepare('PRAGMA table_info(pendaftaran_pengelola)').all().map((c) => c.name);
  if (!kolomDaftar.includes('paket_id')) {
    db.exec('ALTER TABLE pendaftaran_pengelola ADD COLUMN paket_id INTEGER REFERENCES paket(id)');
  }

  const tanpaBatas = db.prepare(`SELECT id FROM paket
    WHERE maks_pelanggan = 0 AND maks_sumur = 0 AND maks_dusun = 0
    ORDER BY harga DESC LIMIT 1`).get() || db.prepare('SELECT id FROM paket ORDER BY urutan DESC LIMIT 1').get();
  if (!tanpaBatas) return;
  // Harga paket dihitung per bulan → masa aktif awal untuk pengelola lama = 1 bulan.
  const bulanDepan = new Date();
  bulanDepan.setMonth(bulanDepan.getMonth() + 1);
  const bulanDepanISO = `${bulanDepan.getFullYear()}-${String(bulanDepan.getMonth() + 1).padStart(2, '0')}-${String(bulanDepan.getDate()).padStart(2, '0')}`;
  db.prepare(`UPDATE desa SET paket_id = ?, langganan_mulai = COALESCE(langganan_mulai, date('now','localtime')),
      langganan_sampai = COALESCE(langganan_sampai, ?), status_langganan = COALESCE(status_langganan, 'aktif')
    WHERE paket_id IS NULL`).run(tanpaBatas.id, bulanDepanISO);

  // Data lama dari migrasi pertama memakai masa aktif persis 1 TAHUN untuk semua
  // pengelola. Karena harga paket berlaku per bulan, siklus seperti itu
  // diselaraskan menjadi 1 bulan. Idempoten: setelah diselaraskan nilainya tidak
  // lagi cocok, jadi perpanjangan manual (+12 bulan) tidak ikut diubah.
  const diselaraskan = db.prepare(`UPDATE desa SET langganan_sampai = date(langganan_mulai, '+1 month')
    WHERE langganan_mulai IS NOT NULL
      AND langganan_sampai BETWEEN date(langganan_mulai, '+1 year', '-2 day')
                               AND date(langganan_mulai, '+1 year')`).run();
  if (diselaraskan.changes > 0) {
    console.log(`${diselaraskan.changes} langganan lama diselaraskan ke siklus bulanan.`);
  }
}

function isSeeded() {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
  if (!row) return false;
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
}

/**
 * Setiap pengelola mendapat daftar bahan gudang standar sekali saja
 * (dipakai untuk database baru, database lama, dan tenant yang baru mendaftar).
 */
function seedBahanDesa(desaId) {
  const ada = db.prepare('SELECT COUNT(*) AS n FROM bahan WHERE desa_id = ?').get(desaId).n;
  if (ada > 0) return false;
  const insert = db.prepare(`INSERT INTO bahan
    (desa_id, kode, nama, kategori, satuan, stok, stok_minimum, harga_satuan)
    VALUES (?,?,?,?,?,?,?,?)`);
  db.transaction(() => {
    BAHAN_AWAL.forEach(([kode, nama, kategori, satuan, stok, minimum, harga]) => {
      insert.run(desaId, kode, nama, kategori, satuan, stok, minimum, harga);
    });
  })();
  return true;
}

function pastikanBahanAwal() {
  db.prepare('SELECT id FROM desa').all().forEach((d) => seedBahanDesa(d.id));
}

function migrate() {
  db.exec(SKEMA_PENDAFTARAN);
  db.exec(SKEMA_PENGATURAN);
  db.exec(SKEMA_RESET);
  db.exec(SKEMA_GUDANG);
  db.exec(SKEMA_KEPEGAWAIAN);
  db.exec(SKEMA_LANGGANAN);
  db.exec(SKEMA_BAYAR_ONLINE);
  db.exec(SKEMA_TAGIHAN_LANGGANAN);
  pastikanPaketAwal();
  pastikanLangganan();
  pastikanBahanAwal();

  // Database lama: tambahkan kolom jenis pada pendaftaran pengelola.
  const kolomDaftar = db.prepare('PRAGMA table_info(pendaftaran_pengelola)').all().map((c) => c.name);
  if (!kolomDaftar.includes('jenis')) {
    db.exec("ALTER TABLE pendaftaran_pengelola ADD COLUMN jenis TEXT NOT NULL DEFAULT 'individu'");
  }
  if (!kolomDaftar.includes('provinsi')) {
    db.exec('ALTER TABLE pendaftaran_pengelola ADD COLUMN provinsi TEXT');
  }
  // Akun yang dibuat dari data pendaftaran (superadmin) ditautkan di sini.
  if (!kolomDaftar.includes('user_id')) {
    db.exec('ALTER TABLE pendaftaran_pengelola ADD COLUMN user_id INTEGER REFERENCES users(id)');
  }

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);

  if (tables.includes('keluhan')) {
    const kolom = db.prepare('PRAGMA table_info(keluhan)').all().map((c) => c.name);
    if (!kolom.includes('ditangani_oleh')) {
      db.exec('ALTER TABLE keluhan ADD COLUMN ditangani_oleh INTEGER REFERENCES users(id)');
    }
  }

  // Identitas usaha/pengelola: nama pelaku usaha & logo sendiri per desa.
  if (tables.includes('desa')) {
    const kolomDesa = db.prepare('PRAGMA table_info(desa)').all().map((c) => c.name);
    if (!kolomDesa.includes('pelaku_usaha')) {
      db.exec('ALTER TABLE desa ADD COLUMN pelaku_usaha TEXT');
    }
    if (!kolomDesa.includes('logo_path')) {
      db.exec('ALTER TABLE desa ADD COLUMN logo_path TEXT');
    }
  }

  // Jatuh tempo bawaan baru: tanggal 20 bulan berikutnya (dulu tanggal 10).
  // Seluruh periode & tagihannya yang masih memakai tanggal 10 disesuaikan
  // agar konsisten dengan periode baru yang dibuat otomatis.
  if (tables.includes('periode_tagihan')) {
    const lama = db.prepare(`SELECT id FROM periode_tagihan
      WHERE tanggal_jatuh_tempo IS NOT NULL AND substr(tanggal_jatuh_tempo, 9, 2) = '10'`).all();
    const geser = db.prepare(`UPDATE periode_tagihan
      SET tanggal_jatuh_tempo = substr(tanggal_jatuh_tempo, 1, 8) || '20' WHERE id = ?`);
    const adaTabelTagihan = tables.includes('tagihan');
    const geserTagihan = adaTabelTagihan
      ? db.prepare(`UPDATE tagihan SET jatuh_tempo = substr(jatuh_tempo, 1, 8) || '20'
          WHERE periode_id = ? AND jatuh_tempo IS NOT NULL AND substr(jatuh_tempo, 9, 2) = '10'`)
      : null;
    for (const p of lama) {
      geser.run(p.id);
      if (geserTagihan) geserTagihan.run(p.id);
    }
  }

  // Tanggal terbit tagihan otomatis: tanggal 21 bulan periode (dulu memakai tanggal penerbitan).
  if (tables.includes('periode_tagihan') && tables.includes('tagihan')) {
    db.exec(`UPDATE tagihan
      SET tanggal_terbit = (
        SELECT printf('%04d-%02d-21', per.tahun, per.bulan)
        FROM periode_tagihan per WHERE per.id = tagihan.periode_id
      )
      WHERE EXISTS (
        SELECT 1 FROM periode_tagihan per
        WHERE per.id = tagihan.periode_id
          AND tanggal_terbit <> printf('%04d-%02d-21', per.tahun, per.bulan)
      )`);
  }

  // Akun warga (pelanggan) ditautkan ke data pelanggannya.
  const kolomUsers = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!kolomUsers.includes('pelanggan_id')) {
    db.exec('ALTER TABLE users ADD COLUMN pelanggan_id INTEGER REFERENCES pelanggan(id)');
  }
  if (!kolomUsers.includes('must_change_password')) {
    db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
  }
  if (!kolomUsers.includes('totp_secret')) {
    db.exec('ALTER TABLE users ADD COLUMN totp_secret TEXT');
  }
  if (!kolomUsers.includes('totp_enabled')) {
    db.exec('ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0');
  }
  if (!kolomUsers.includes('totp_recovery')) {
    db.exec('ALTER TABLE users ADD COLUMN totp_recovery TEXT');
  }

  // Pembatas laju berbasis database.
  db.exec(`CREATE TABLE IF NOT EXISTS rate_limit (
    kunci TEXT PRIMARY KEY,
    jumlah INTEGER NOT NULL DEFAULT 0,
    reset_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_rate_limit_reset ON rate_limit(reset_at);`);

  // Setelan pembayaran online warga (dikelola superadmin).
  const kolomPengaturan = db.prepare('PRAGMA table_info(pengaturan)').all().map((c) => c.name);
  if (!kolomPengaturan.includes('bayar_online_aktif')) {
    db.exec('ALTER TABLE pengaturan ADD COLUMN bayar_online_aktif INTEGER NOT NULL DEFAULT 1');
  }
  if (!kolomPengaturan.includes('bayar_online_info')) {
    db.exec('ALTER TABLE pengaturan ADD COLUMN bayar_online_info TEXT');
  }

  // Nomor seri & identitas fisik meter air, beserta riwayat penggantian.
  if (tables.includes('sambungan')) {
    const kolomSambungan = db.prepare('PRAGMA table_info(sambungan)').all().map((c) => c.name);
    const tambahan = [
      ['nomor_seri', 'TEXT'],
      ['merk', 'TEXT'],
      ['tipe', 'TEXT'],
      ['tanggal_lepas', 'TEXT'],
      ['alasan_ganti', 'TEXT'],
    ];
    tambahan.forEach(([nama, tipe]) => {
      if (!kolomSambungan.includes(nama)) {
        db.exec(`ALTER TABLE sambungan ADD COLUMN ${nama} ${tipe}`);
      }
    });
  }

  pastikanSuperadmin();
}

/**
 * Pastikan selalu ada akun superadmin, termasuk pada database lama
 * yang dibuat sebelum fitur superadmin ditambahkan.
 */
function pastikanSuperadmin() {
  const desa = db.prepare('SELECT id FROM desa ORDER BY id LIMIT 1').get();
  if (!desa) return;

  const adaSuperadmin = db.prepare("SELECT id FROM users WHERE role = 'superadmin' LIMIT 1").get();
  if (adaSuperadmin) return;

  const username = String(process.env.SUPERADMIN_USERNAME || 'superadmin').trim().toLowerCase();
  const dariEnv = String(process.env.SUPERADMIN_PASSWORD || '');
  if (dariEnv) {
    const salah = validasiSandi(dariEnv, { username });
    if (salah) throw new Error(`SUPERADMIN_PASSWORD tidak memenuhi kebijakan: ${salah}`);
  }
  if (PRODUKSI && !dariEnv) {
    throw new Error('Belum ada akun superadmin. Isi SUPERADMIN_PASSWORD (min. 8 karakter) di .env lalu jalankan ulang.');
  }
  const password = dariEnv || 'superadmin123';

  const pemakaiNama = db.prepare('SELECT id, role FROM users WHERE username = ?').get(username);
  if (pemakaiNama) {
    // Jangan pernah menaikkan akun staf biasa menjadi superadmin hanya karena namanya sama.
    throw new Error(`Username "${username}" sudah dipakai akun ${pemakaiNama.role}. `
      + 'Set SUPERADMIN_USERNAME lain di .env lalu jalankan ulang aplikasi.');
  }

  db.prepare(`INSERT INTO users (desa_id, dusun_id, nama, username, password_hash, role, must_change_password)
    VALUES (?, NULL, 'Superadmin', ?, ?, 'superadmin', 1)`)
    .run(desa.id, username, hashSandi(password));
  console.log(`Akun superadmin dibuat: ${username} (ganti kata sandi setelah masuk).`);
}

function initDb({ force = false } = {}) {
  if (!isSeeded()) {
    db.exec(SCHEMA);
    seed();
    migrate();
    return true;
  }
  migrate();
  return false;
}

// ---------------------------------------------------------------------------
// SEED DATA DEMO
// ---------------------------------------------------------------------------

/**
 * Database baru di lingkungan produksi (SEED_DEMO=0):
 * hanya ruang kerja sistem + akun superadmin dari variabel lingkungan.
 * Tidak ada akun/data demo dengan kata sandi yang diketahui publik.
 */
function seedProduksi() {
  const username = String(process.env.SUPERADMIN_USERNAME || 'superadmin').trim().toLowerCase();
  const password = String(process.env.SUPERADMIN_PASSWORD || '');
  const salah = validasiSandi(password, { username });
  if (salah) {
    throw new Error(`Database kosong: ${salah} Isi SUPERADMIN_PASSWORD di .env lalu jalankan ulang.`);
  }
  db.transaction(() => {
    const info = db.prepare(`INSERT INTO desa (nama, kecamatan, kabupaten, alamat, telepon)
      VALUES (?,?,?,?,?)`).run('Ruang Kerja Sistem', null, null, null, null);
    db.prepare(`INSERT INTO users (desa_id, dusun_id, nama, username, password_hash, role, must_change_password)
      VALUES (?, NULL, 'Superadmin', ?, ?, 'superadmin', 1)`)
      .run(info.lastInsertRowid, username, hashSandi(password));
  })();
  console.log(`Database produksi disiapkan. Superadmin: ${username} (ganti kata sandi saat masuk pertama).`);
}

function seed() {
  if (!SEED_DEMO) return seedProduksi();

  let rndState = 20261019;
  const rnd = () => {
    rndState = (rndState * 1664525 + 1013904223) % 4294967296;
    return rndState / 4294967296;
  };
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const pad = (n, len = 4) => String(n).padStart(len, '0');

  const firstNames = ['Siti', 'Ahmad', 'Nur', 'Budi', 'Rina', 'Hasan', 'Lestari', 'Agus', 'Dewi', 'Fauzan',
    'Sri', 'Yusuf', 'Maya', 'Hendra', 'Wati', 'Ilham', 'Fitri', 'Rudi', 'Ningsih', 'Zainal'];
  const lastNames = ['Aminah', 'Wijaya', 'Hidayat', 'Santoso', 'Kusuma', 'Rahman', 'Saputra', 'Handayani',
    'Firmansyah', 'Mulyani'];

  db.transaction(() => {
    db.prepare(`INSERT INTO desa (nama, kecamatan, kabupaten, alamat, telepon)
      VALUES (?,?,?,?,?)`).run('Desa Sumber Makmur', 'Sembalun', 'Lombok Timur', 'Jl. Balai Desa No. 1', '081234567890');

    const insertDusun = db.prepare('INSERT INTO dusun (desa_id, kode, nama, kepala_dusun) VALUES (1,?,?,?)');
    insertDusun.run('D01', 'Dusun Krajan', 'Bapak Sutrisno');
    insertDusun.run('D02', 'Dusun Ngemplak', 'Bapak Hariyanto');
    insertDusun.run('D03', 'Dusun Sumber', 'Bapak Suparman');

    const insertSumur = db.prepare(`INSERT INTO sumur
      (dusun_id, kode, nama, alamat, kapasitas_lps, tahun_bor, nomor_meter_induk, status)
      VALUES (?,?,?,?,?,?,?,?)`);
    insertSumur.run(1, 'SB-01', 'Sumur Bor Krajan I', 'RT 01/RW 01 Dusun Krajan', 2.5, 2018, 'MTR-IND-01', 'aktif');
    insertSumur.run(1, 'SB-02', 'Sumur Bor Krajan II', 'RT 03/RW 02 Dusun Krajan', 2.0, 2021, 'MTR-IND-02', 'aktif');
    insertSumur.run(2, 'SB-03', 'Sumur Bor Ngemplak', 'RT 02/RW 01 Dusun Ngemplak', 3.0, 2019, 'MTR-IND-03', 'aktif');
    insertSumur.run(3, 'SB-04', 'Sumur Bor Sumber', 'RT 01/RW 01 Dusun Sumber', 2.5, 2020, 'MTR-IND-04', 'aktif');

    const insertGol = db.prepare(`INSERT INTO golongan_tarif
      (desa_id, kode, nama, abonemen, min_pemakaian_m3, denda_persen, denda_maks_persen)
      VALUES (1,?,?,?,?,?,?)`);
    insertGol.run('RT1', 'Rumah Tangga', 5000, 5, 2, 24);
    insertGol.run('NIAGA', 'Niaga', 10000, 5, 2, 24);
    insertGol.run('SOSIAL', 'Sosial/Umum', 3000, 5, 0, 0);

    const insertBlok = db.prepare(`INSERT INTO tarif_blok
      (golongan_id, blok_ke, dari_m3, sampai_m3, harga_per_m3, berlaku_mulai)
      VALUES (?,?,?,?,?,?)`);
    insertBlok.run(1, 1, 0, 10, 1500, '2026-01-01');
    insertBlok.run(1, 2, 10, 20, 2500, '2026-01-01');
    insertBlok.run(1, 3, 20, null, 3500, '2026-01-01');
    insertBlok.run(2, 1, 0, null, 4000, '2026-01-01');
    insertBlok.run(3, 1, 0, 10, 1000, '2026-01-01');
    insertBlok.run(3, 2, 10, null, 1500, '2026-01-01');

    const insertUser = db.prepare(`INSERT INTO users
      (desa_id, dusun_id, nama, username, password_hash, role)
      VALUES (1,?,?,?,?,?)`);
    const hash = (pw) => hashSandi(pw);
    insertUser.run(null, 'Superadmin', 'superadmin', hash('superadmin123'), 'superadmin');
    insertUser.run(null, 'Admin Desa', 'admin', hash('admin123'), 'admin_desa');
    insertUser.run(1, 'Admin Dusun Krajan', 'krajan', hash('krajan123'), 'admin_dusun');
    insertUser.run(2, 'Admin Dusun Ngemplak', 'ngemplak', hash('ngemplak123'), 'admin_dusun');
    insertUser.run(3, 'Admin Dusun Sumber', 'sumber', hash('sumber123'), 'admin_dusun');
    insertUser.run(1, 'Petugas Catat Krajan', 'petugas', hash('petugas123'), 'petugas_catat');
    insertUser.run(null, 'Kasir Desa', 'kasir', hash('kasir123'), 'kasir');
    const golonganIds = [1, 1, 1, 1, 1, 1, 1, 2, 3];
    const insertPelanggan = db.prepare(`INSERT INTO pelanggan
      (desa_id, dusun_id, sumur_id, golongan_id, nomor_pelanggan, nama, alamat, rt, rw, telepon, status, tanggal_daftar)
      VALUES (1,?,?,?,?,?,?,?,?,?,?,?)`);
    const insertSambungan = db.prepare(`INSERT INTO sambungan
      (pelanggan_id, nomor_meter, ukuran_inch, status, tanggal_pasang)
      VALUES (?,?,?,?,?)`);

    const pelangganIds = [];
    let counter = 0;
    for (let d = 1; d <= 3; d += 1) {
      const kodeDusun = ['D01', 'D02', 'D03'][d - 1];
      const sumurUntukDusun = d === 1 ? [1, 2] : [d === 2 ? 3 : 4];
      for (let i = 0; i < 40; i += 1) {
        counter += 1;
        const sumurId = sumurUntukDusun[counter % sumurUntukDusun.length];
        const golId = pick(golonganIds);
        const nama = `${pick(firstNames)} ${pick(lastNames)}`;
        const nomor = `${kodeDusun}-${pad(counter)}`;
        const info = insertPelanggan.run(
          d, sumurId, golId, nomor, nama,
          `RT ${pad(1 + (i % 5), 2)}/RW ${pad(1 + (d % 3), 2)}, Dusun ${['Krajan', 'Ngemplak', 'Sumber'][d - 1]}`,
          pad(1 + (i % 5), 2), pad(1 + (d % 3), 2),
          `0812${pad(100000 + counter * 137, 6)}`, 'aktif', '2024-01-15'
        );
        const pelangganId = info.lastInsertRowid;
        pelangganIds.push({ id: pelangganId, dusunId: d, sumurId, golonganId: golId });
        insertSambungan.run(pelangganId, `MTR-${pad(counter, 6)}`, 0.5, 'aktif', '2024-01-20');
      }
    }

    // Akun demo warga (pelanggan) yang tertaut ke pelanggan pertama.
    if (pelangganIds.length) {
      db.prepare(`INSERT INTO users (desa_id, dusun_id, pelanggan_id, nama, username, password_hash, role)
        VALUES (1,?,?,?,?,?,?)`).run(
        pelangganIds[0].dusunId, pelangganIds[0].id, 'Warga Demo', 'warga', hash('warga123'), 'warga'
      );
    }

    // Meter awal per pelanggan
    const meters = new Map();
    pelangganIds.forEach((p, idx) => meters.set(p.id, 120 + idx * 23 + Math.floor(rnd() * 60)));

    const insertPeriode = db.prepare(`INSERT INTO periode_tagihan
      (desa_id, tahun, bulan, tanggal_jatuh_tempo, status) VALUES (1,?,?,?,?)`);
    const insertBaca = db.prepare(`INSERT INTO pembacaan_meter
      (periode_id, pelanggan_id, sambungan_id, petugas_id, angka_lalu, angka_kini, pemakaian_m3,
       kondisi_meter, tanggal_baca, status, diverifikasi_oleh, diverifikasi_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insertTagihan = db.prepare(`INSERT INTO tagihan
      (periode_id, pelanggan_id, sambungan_id, dusun_id, nomor_tagihan, pemakaian_m3,
       abonemen, biaya_pemakaian, total, terbayar, status, tanggal_terbit, jatuh_tempo)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insertItem = db.prepare(`INSERT INTO tagihan_item
      (tagihan_id, jenis, keterangan, qty, harga_satuan, subtotal, urutan) VALUES (?,?,?,?,?,?,?)`);
    const insertBayar = db.prepare(`INSERT INTO pembayaran
      (tagihan_id, nomor_kwitansi, tanggal_bayar, jumlah, metode, kasir_id, status)
      VALUES (?,?,?,?,?,?,?)`);

    const sambunganByPelanggan = new Map();
    db.prepare('SELECT id, pelanggan_id FROM sambungan').all()
      .forEach((s) => sambunganByPelanggan.set(s.pelanggan_id, s.id));

    let kwitansiSeq = 0;
    const bulanList = [
      { bulan: 7, status: 'tutup' },
      { bulan: 8, status: 'tutup' },
      { bulan: 9, status: 'tutup' },
      { bulan: 10, status: 'baca_meter' },
    ];

    for (const { bulan, status } of bulanList) {
      const jatuhTempo = bulan === 10 ? '2026-11-20' : `2026-${pad(bulan + 1, 2)}-20`;
      const periodeId = insertPeriode.run(2026, bulan, jatuhTempo, status).lastInsertRowid;
      const tanggalBaca = `2026-${pad(bulan, 2)}-28`;
      const tanggalTerbit = `2026-${pad(bulan, 2)}-21`;

      for (const p of pelangganIds) {
        const meterAwal = meters.get(p.id);
        const golKode = p.golonganId === 2 ? 'NIAGA' : p.golonganId === 3 ? 'SOSIAL' : 'RT';
        const base = golKode === 'NIAGA' ? 18 : golKode === 'SOSIAL' ? 8 : 12;
        const pakai = Math.max(2, Math.round(base + (rnd() * 12 - 6)));
        const meterAkhir = meterAwal + pakai;
        meters.set(p.id, meterAkhir);

        const final = status === 'tutup';
        const readingStatus = bulan === 10 ? (rnd() < 0.65 ? 'diajukan' : 'draft') : 'final';
        if (bulan === 10 && rnd() < 0.2) continue; // sebagian belum dibaca

        insertBaca.run(
          periodeId, p.id, sambunganByPelanggan.get(p.id), 5,
          meterAwal, meterAkhir, pakai, 'normal', tanggalBaca,
          readingStatus, final ? 1 : null, final ? `${tanggalBaca} 14:30:00` : null
        );

        if (!final) continue;

        const bill = hitungTagihan(db, p.golonganId, pakai, tanggalTerbit);
        const nomorTagihan = `TAG/2026/${pad(bulan, 2)}/${pad(p.id)}`;
        const tagihanId = insertTagihan.run(
          periodeId, p.id, sambunganByPelanggan.get(p.id), p.dusunId, nomorTagihan, pakai,
          bill.abonemen, bill.biaya_pemakaian, bill.total, 0, 'belum_bayar', tanggalTerbit, jatuhTempo
        ).lastInsertRowid;

        bill.items.forEach((it) => {
          insertItem.run(tagihanId, it.jenis, it.keterangan, it.qty, it.harga_satuan, it.subtotal, it.urutan);
        });

        const undian = rnd();
        let dibayar = 0;
        if (undian < 0.72) dibayar = bill.total;
        else if (undian < 0.85) dibayar = Math.round(bill.total * 0.5);

        if (dibayar > 0) {
          kwitansiSeq += 1;
          const tglBayar = `2026-${pad(bulan, 2)}-${pad(10 + Math.floor(rnd() * 15), 2)}`;
          insertBayar.run(
            tagihanId, `KW/2026/${pad(kwitansiSeq, 5)}`, tglBayar, dibayar,
            rnd() < 0.85 ? 'tunai' : 'transfer', 6, 'valid'
          );
          const statusBayar = dibayar >= bill.total - 0.005 ? 'lunas' : 'sebagian';
          db.prepare('UPDATE tagihan SET terbayar = ?, status = ? WHERE id = ?')
            .run(dibayar, statusBayar, tagihanId);
        }
      }

      // Tandai tunggakan lama
      if (status === 'tutup') {
        db.prepare(`UPDATE tagihan SET status = 'tunggakan'
          WHERE periode_id = ? AND status = 'belum_bayar'`).run(periodeId);
      }
    }

    // Produksi air harian per sumur (Juli-Oktober, sampai 19 Okt untuk bulan berjalan)
    const insertProduksi = db.prepare(`INSERT INTO produksi_air
      (sumur_id, tanggal, meter_awal, meter_akhir, volume_m3, jam_operasi, dicatat_oleh)
      VALUES (?,?,?,?,?,?,?)`);
    const meterProduksi = new Map([[1, 5000], [2, 4200], [3, 6100], [4, 5300]]);

    for (const bulan of [7, 8, 9, 10]) {
      const maxHari = bulan === 10 ? 19 : 28;
      for (const sumurId of [1, 2, 3, 4]) {
        for (let hari = 1; hari <= maxHari; hari += 1) {
          const volume = Math.round((10 + rnd() * 12) * 10) / 10;
          const awal = meterProduksi.get(sumurId);
          const akhir = Math.round((awal + volume) * 10) / 10;
          meterProduksi.set(sumurId, akhir);
          insertProduksi.run(
            sumurId, `2026-${pad(bulan, 2)}-${pad(hari, 2)}`,
            awal, akhir, volume, Math.round((2 + rnd() * 3) * 10) / 10, 5
          );
        }
      }
    }

    // Keluhan contoh
    const insertKeluhan = db.prepare(`INSERT INTO keluhan
      (dusun_id, pelanggan_id, sumur_id, kategori, deskripsi, prioritas, status, dilaporkan_oleh, telepon)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    insertKeluhan.run(1, 1, 1, 'kebocoran', 'Pipa bocor di depan rumah, air menggenang.', 'tinggi', 'diproses', 'Siti Aminah', '0812100001');
    insertKeluhan.run(2, 45, 3, 'air_mati', 'Air tidak mengalir sejak pagi.', 'sedang', 'baru', 'Budi Santoso', '0812100002');
    insertKeluhan.run(3, 90, 4, 'meter', 'Angka meter tidak berputar saat air dipakai.', 'sedang', 'baru', 'Dewi Lestari', '0812100003');
  })();
}

initDb();

module.exports = { db, initDb, DB_PATH, seedBahanDesa };
