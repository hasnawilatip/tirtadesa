-- ============================================================================
-- SKEMA DATABASE APLIKASI PDAM DESA
-- Pengelolaan sumur bor (BOS) per dusun
-- Target  : MySQL 8.0+ / MariaDB 10.5+
-- Encoding: utf8mb4
-- Catatan : nominal DECIMAL(14,2), volume m3 DECIMAL(10,2)
--           data keuangan tidak dihapus, hanya dibatalkan
-- ============================================================================

CREATE DATABASE IF NOT EXISTS pdam_desa
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE pdam_desa;

-- ----------------------------------------------------------------------------
-- 1. MASTER DESA & DUSUN
-- ----------------------------------------------------------------------------

CREATE TABLE desa (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  nama        VARCHAR(120) NOT NULL,
  kecamatan   VARCHAR(120) NULL,
  kabupaten   VARCHAR(120) NULL,
  alamat      VARCHAR(255) NULL,
  telepon     VARCHAR(30)  NULL,
  email       VARCHAR(120) NULL,
  logo_path   VARCHAR(255) NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB;

CREATE TABLE dusun (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  desa_id      BIGINT UNSIGNED NOT NULL,
  kode         VARCHAR(20)  NOT NULL,
  nama         VARCHAR(120) NOT NULL,
  kepala_dusun VARCHAR(120) NULL,
  telepon      VARCHAR(30)  NULL,
  is_active    TINYINT(1) NOT NULL DEFAULT 1,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_dusun_kode (desa_id, kode),
  CONSTRAINT fk_dusun_desa FOREIGN KEY (desa_id) REFERENCES desa (id)
) ENGINE=InnoDB;

-- ----------------------------------------------------------------------------
-- 2. PENGGUNA & HAK AKSES
-- ----------------------------------------------------------------------------

CREATE TABLE users (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  desa_id       BIGINT UNSIGNED NOT NULL,
  dusun_id      BIGINT UNSIGNED NULL COMMENT 'NULL = level desa/pusat',
  nama          VARCHAR(120) NOT NULL,
  username      VARCHAR(60)  NOT NULL,
  email         VARCHAR(160) NULL,
  telepon       VARCHAR(30)  NULL,
  password_hash VARCHAR(255) NOT NULL,
  role          ENUM('superadmin','admin_desa','admin_dusun','petugas_catat','kasir','warga')
                NOT NULL DEFAULT 'petugas_catat',
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  last_login_at DATETIME NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_username (username),
  UNIQUE KEY uq_users_email (email),
  KEY idx_users_dusun (dusun_id),
  CONSTRAINT fk_users_desa  FOREIGN KEY (desa_id)  REFERENCES desa (id),
  CONSTRAINT fk_users_dusun FOREIGN KEY (dusun_id) REFERENCES dusun (id)
) ENGINE=InnoDB;

-- Akses tambahan: satu petugas/kasir dapat ditugaskan ke beberapa dusun.
CREATE TABLE user_dusun_akses (
  user_id  BIGINT UNSIGNED NOT NULL,
  dusun_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (user_id, dusun_id),
  CONSTRAINT fk_uda_user  FOREIGN KEY (user_id)  REFERENCES users (id)  ON DELETE CASCADE,
  CONSTRAINT fk_uda_dusun FOREIGN KEY (dusun_id) REFERENCES dusun (id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ----------------------------------------------------------------------------
-- 3. SUMUR BOR (BOS)
-- ----------------------------------------------------------------------------

CREATE TABLE sumur (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  dusun_id          BIGINT UNSIGNED NOT NULL,
  kode              VARCHAR(30)  NOT NULL,
  nama              VARCHAR(120) NOT NULL,
  alamat            VARCHAR(255) NULL,
  latitude          DECIMAL(10,7) NULL,
  longitude         DECIMAL(10,7) NULL,
  tahun_bor         SMALLINT UNSIGNED NULL,
  kedalaman_m       DECIMAL(6,2) NULL,
  kapasitas_lps     DECIMAL(8,2) NULL COMMENT 'liter per detik',
  pompa_merek       VARCHAR(120) NULL,
  pompa_daya_kw     DECIMAL(6,2) NULL,
  nomor_meter_induk VARCHAR(60)  NULL,
  tanggal_operasi   DATE NULL,
  status            ENUM('aktif','perbaikan','nonaktif') NOT NULL DEFAULT 'aktif',
  catatan           TEXT NULL,
  deleted_at        TIMESTAMP NULL,
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sumur_kode (dusun_id, kode),
  KEY idx_sumur_status (status),
  CONSTRAINT fk_sumur_dusun FOREIGN KEY (dusun_id) REFERENCES dusun (id)
) ENGINE=InnoDB;

-- ----------------------------------------------------------------------------
-- 4. TARIF
-- ----------------------------------------------------------------------------

CREATE TABLE golongan_tarif (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  desa_id           BIGINT UNSIGNED NOT NULL,
  kode              VARCHAR(20)  NOT NULL,
  nama              VARCHAR(80)  NOT NULL,
  deskripsi         VARCHAR(255) NULL,
  abonemen          DECIMAL(14,2) NOT NULL DEFAULT 0,
  min_pemakaian_m3  DECIMAL(10,2) NOT NULL DEFAULT 0,
  denda_persen      DECIMAL(5,2)  NOT NULL DEFAULT 0 COMMENT '0 = denda nonaktif',
  denda_maks_persen DECIMAL(5,2)  NOT NULL DEFAULT 0,
  is_active         TINYINT(1) NOT NULL DEFAULT 1,
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_golongan_kode (desa_id, kode),
  CONSTRAINT fk_golongan_desa FOREIGN KEY (desa_id) REFERENCES desa (id)
) ENGINE=InnoDB;

-- Versi tarif dapat berubah; tagihan memakai versi terakhir sebelum tanggal tagihan.
-- Blok 1 mulai dari 0; blok berikutnya memakai batas bawah eksklusif.
CREATE TABLE tarif_blok (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  golongan_id   BIGINT UNSIGNED NOT NULL,
  blok_ke       TINYINT UNSIGNED NOT NULL,
  dari_m3       DECIMAL(10,2) NOT NULL,
  sampai_m3     DECIMAL(10,2) NULL COMMENT 'NULL = tanpa batas',
  harga_per_m3  DECIMAL(14,2) NOT NULL,
  berlaku_mulai DATE NOT NULL DEFAULT '2020-01-01',
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_tarif_blok (golongan_id, blok_ke, berlaku_mulai),
  CONSTRAINT fk_blok_golongan FOREIGN KEY (golongan_id) REFERENCES golongan_tarif (id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ----------------------------------------------------------------------------
-- 5. PELANGGAN & SAMBUNGAN
-- ----------------------------------------------------------------------------

CREATE TABLE pelanggan (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  desa_id          BIGINT UNSIGNED NOT NULL,
  dusun_id         BIGINT UNSIGNED NOT NULL,
  sumur_id         BIGINT UNSIGNED NULL COMMENT 'sumur sumber air',
  golongan_id      BIGINT UNSIGNED NOT NULL,
  nomor_pelanggan  VARCHAR(30)  NOT NULL,
  nama             VARCHAR(160) NOT NULL,
  nik              VARCHAR(255) NULL COMMENT 'disarankan terenkripsi',
  alamat           VARCHAR(255) NULL,
  rt               VARCHAR(5)   NULL,
  rw               VARCHAR(5)   NULL,
  telepon          VARCHAR(30)  NULL,
  status           ENUM('aktif','nonaktif','tunggakan_berat') NOT NULL DEFAULT 'aktif',
  tanggal_daftar   DATE NULL,
  tanggal_nonaktif DATE NULL,
  catatan          TEXT NULL,
  deleted_at       TIMESTAMP NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_pelanggan_nomor (desa_id, nomor_pelanggan),
  KEY idx_pelanggan_dusun (dusun_id),
  KEY idx_pelanggan_sumur (sumur_id),
  KEY idx_pelanggan_status (status),
  CONSTRAINT fk_pelanggan_desa     FOREIGN KEY (desa_id)     REFERENCES desa (id),
  CONSTRAINT fk_pelanggan_dusun    FOREIGN KEY (dusun_id)    REFERENCES dusun (id),
  CONSTRAINT fk_pelanggan_sumur    FOREIGN KEY (sumur_id)    REFERENCES sumur (id),
  CONSTRAINT fk_pelanggan_golongan FOREIGN KEY (golongan_id) REFERENCES golongan_tarif (id)
) ENGINE=InnoDB;

CREATE TABLE sambungan (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  pelanggan_id  BIGINT UNSIGNED NOT NULL,
  nomor_meter   VARCHAR(60) NOT NULL,
  ukuran_inch   DECIMAL(4,1) NULL,
  tanggal_pasang DATE NULL,
  posisi_meter  VARCHAR(120) NULL,
  foto_path     VARCHAR(255) NULL,
  status        ENUM('aktif','diganti','dicabut') NOT NULL DEFAULT 'aktif',
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sambungan_meter (nomor_meter),
  KEY idx_sambungan_pelanggan (pelanggan_id),
  CONSTRAINT fk_sambungan_pelanggan FOREIGN KEY (pelanggan_id) REFERENCES pelanggan (id)
) ENGINE=InnoDB;

-- ----------------------------------------------------------------------------
-- 6. PERIODE & PEMBACAAN METER
-- ----------------------------------------------------------------------------

CREATE TABLE periode_tagihan (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  desa_id              BIGINT UNSIGNED NOT NULL,
  tahun                SMALLINT UNSIGNED NOT NULL,
  bulan                TINYINT UNSIGNED NOT NULL,
  tanggal_mulai_baca   DATE NULL,
  tanggal_akhir_baca   DATE NULL,
  tanggal_jatuh_tempo  DATE NULL,
  status               ENUM('draft','baca_meter','verifikasi','tagihan_terbit','tutup')
                       NOT NULL DEFAULT 'draft',
  created_by           BIGINT UNSIGNED NULL,
  closed_at            DATETIME NULL,
  created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_periode (desa_id, tahun, bulan),
  KEY idx_periode_status (status),
  CONSTRAINT fk_periode_desa FOREIGN KEY (desa_id) REFERENCES desa (id),
  CONSTRAINT fk_periode_user FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB;

CREATE TABLE pembacaan_meter (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  periode_id       BIGINT UNSIGNED NOT NULL,
  pelanggan_id     BIGINT UNSIGNED NOT NULL,
  sambungan_id     BIGINT UNSIGNED NOT NULL,
  petugas_id       BIGINT UNSIGNED NULL,
  angka_lalu       DECIMAL(12,2) NOT NULL DEFAULT 0,
  angka_kini       DECIMAL(12,2) NOT NULL DEFAULT 0,
  pemakaian_m3     DECIMAL(10,2)
                   GENERATED ALWAYS AS (GREATEST(angka_kini - angka_lalu, 0)) STORED,
  kondisi_meter    ENUM('normal','rusak','macet','tidak_dihuni') NOT NULL DEFAULT 'normal',
  tanggal_baca     DATE NULL,
  foto_path        VARCHAR(255) NULL,
  catatan          VARCHAR(255) NULL,
  status           ENUM('draft','diajukan','final','ditolak') NOT NULL DEFAULT 'draft',
  alasan_tolak     VARCHAR(255) NULL,
  diverifikasi_oleh BIGINT UNSIGNED NULL,
  diverifikasi_at  DATETIME NULL,
  client_uuid      CHAR(36) NULL COMMENT 'kunci idempoten sinkronisasi offline',
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_baca_periode_sambungan (periode_id, sambungan_id),
  UNIQUE KEY uq_baca_client_uuid (client_uuid),
  KEY idx_baca_pelanggan (pelanggan_id),
  KEY idx_baca_status (status),
  CONSTRAINT fk_baca_periode   FOREIGN KEY (periode_id)   REFERENCES periode_tagihan (id),
  CONSTRAINT fk_baca_pelanggan FOREIGN KEY (pelanggan_id) REFERENCES pelanggan (id),
  CONSTRAINT fk_baca_sambungan FOREIGN KEY (sambungan_id) REFERENCES sambungan (id),
  CONSTRAINT fk_baca_petugas   FOREIGN KEY (petugas_id)   REFERENCES users (id),
  CONSTRAINT fk_baca_verifikator FOREIGN KEY (diverifikasi_oleh) REFERENCES users (id)
) ENGINE=InnoDB;

-- ----------------------------------------------------------------------------
-- 7. TAGIHAN
-- ----------------------------------------------------------------------------

CREATE TABLE tagihan (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  periode_id      BIGINT UNSIGNED NOT NULL,
  pelanggan_id    BIGINT UNSIGNED NOT NULL,
  sambungan_id    BIGINT UNSIGNED NOT NULL,
  dusun_id        BIGINT UNSIGNED NOT NULL COMMENT 'denormalisasi untuk laporan & scope',
  nomor_tagihan   VARCHAR(40) NOT NULL,
  pemakaian_m3    DECIMAL(10,2) NOT NULL DEFAULT 0,
  abonemen        DECIMAL(14,2) NOT NULL DEFAULT 0,
  biaya_pemakaian DECIMAL(14,2) NOT NULL DEFAULT 0,
  denda           DECIMAL(14,2) NOT NULL DEFAULT 0,
  biaya_lain      DECIMAL(14,2) NOT NULL DEFAULT 0,
  total           DECIMAL(14,2) NOT NULL DEFAULT 0,
  terbayar        DECIMAL(14,2) NOT NULL DEFAULT 0,
  sisa            DECIMAL(14,2)
                  GENERATED ALWAYS AS (GREATEST(total - terbayar, 0)) STORED,
  status          ENUM('belum_bayar','sebagian','lunas','tunggakan','batal')
                  NOT NULL DEFAULT 'belum_bayar',
  tanggal_terbit  DATE NULL,
  jatuh_tempo     DATE NULL,
  keterangan      VARCHAR(255) NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_tagihan_periode_pelanggan (periode_id, pelanggan_id),
  UNIQUE KEY uq_tagihan_nomor (nomor_tagihan),
  KEY idx_tagihan_dusun (dusun_id),
  KEY idx_tagihan_status (status),
  KEY idx_tagihan_jatuh_tempo (jatuh_tempo),
  CONSTRAINT fk_tagihan_periode   FOREIGN KEY (periode_id)   REFERENCES periode_tagihan (id),
  CONSTRAINT fk_tagihan_pelanggan FOREIGN KEY (pelanggan_id) REFERENCES pelanggan (id),
  CONSTRAINT fk_tagihan_sambungan FOREIGN KEY (sambungan_id) REFERENCES sambungan (id),
  CONSTRAINT fk_tagihan_dusun     FOREIGN KEY (dusun_id)     REFERENCES dusun (id)
) ENGINE=InnoDB;

-- Snapshot harga saat tagihan diterbitkan.
CREATE TABLE tagihan_item (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tagihan_id    BIGINT UNSIGNED NOT NULL,
  jenis         ENUM('abonemen','pemakaian','denda','admin','lain') NOT NULL,
  keterangan    VARCHAR(160) NULL,
  qty           DECIMAL(10,2) NOT NULL DEFAULT 1,
  harga_satuan  DECIMAL(14,2) NOT NULL DEFAULT 0,
  subtotal      DECIMAL(14,2) NOT NULL DEFAULT 0,
  urutan        TINYINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  KEY idx_item_tagihan (tagihan_id),
  CONSTRAINT fk_item_tagihan FOREIGN KEY (tagihan_id) REFERENCES tagihan (id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ----------------------------------------------------------------------------
-- 8. PEMBAYARAN
-- ----------------------------------------------------------------------------

CREATE TABLE pembayaran (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tagihan_id          BIGINT UNSIGNED NOT NULL,
  nomor_kwitansi      VARCHAR(40) NOT NULL,
  tanggal_bayar       DATE NOT NULL,
  jumlah              DECIMAL(14,2) NOT NULL,
  metode              ENUM('tunai','transfer','qris','lain') NOT NULL DEFAULT 'tunai',
  kasir_id            BIGINT UNSIGNED NULL,
  bukti_path          VARCHAR(255) NULL,
  catatan             VARCHAR(255) NULL,
  status              ENUM('valid','batal') NOT NULL DEFAULT 'valid',
  dibatalkan_oleh     BIGINT UNSIGNED NULL,
  alasan_batal        VARCHAR(255) NULL,
  dibatalkan_at       DATETIME NULL,
  created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_kwitansi (nomor_kwitansi),
  KEY idx_bayar_tagihan (tagihan_id),
  KEY idx_bayar_tanggal (tanggal_bayar),
  CONSTRAINT fk_bayar_tagihan FOREIGN KEY (tagihan_id) REFERENCES tagihan (id),
  CONSTRAINT fk_bayar_kasir   FOREIGN KEY (kasir_id)   REFERENCES users (id),
  CONSTRAINT fk_bayar_batal   FOREIGN KEY (dibatalkan_oleh) REFERENCES users (id)
) ENGINE=InnoDB;

-- ----------------------------------------------------------------------------
-- 9. PRODUKSI AIR & PERAWATAN
-- ----------------------------------------------------------------------------

CREATE TABLE produksi_air (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sumur_id      BIGINT UNSIGNED NOT NULL,
  tanggal       DATE NOT NULL,
  meter_awal    DECIMAL(12,2) NOT NULL DEFAULT 0,
  meter_akhir   DECIMAL(12,2) NOT NULL DEFAULT 0,
  volume_m3     DECIMAL(10,2)
                GENERATED ALWAYS AS (GREATEST(meter_akhir - meter_awal, 0)) STORED,
  jam_operasi   DECIMAL(5,2) NULL,
  catatan       VARCHAR(255) NULL,
  dicatat_oleh  BIGINT UNSIGNED NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_produksi_sumur_tanggal (sumur_id, tanggal),
  CONSTRAINT fk_produksi_sumur FOREIGN KEY (sumur_id) REFERENCES sumur (id),
  CONSTRAINT fk_produksi_user  FOREIGN KEY (dicatat_oleh) REFERENCES users (id)
) ENGINE=InnoDB;

CREATE TABLE maintenance_sumur (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sumur_id        BIGINT UNSIGNED NOT NULL,
  jenis           ENUM('pompa','pipa','listrik','kebersihan','lain') NOT NULL DEFAULT 'lain',
  deskripsi       TEXT NULL,
  tanggal_mulai   DATE NULL,
  tanggal_selesai DATE NULL,
  biaya           DECIMAL(14,2) NOT NULL DEFAULT 0,
  vendor          VARCHAR(160) NULL,
  status          ENUM('rencana','berjalan','selesai','batal') NOT NULL DEFAULT 'rencana',
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_maint_sumur (sumur_id),
  CONSTRAINT fk_maint_sumur FOREIGN KEY (sumur_id) REFERENCES sumur (id)
) ENGINE=InnoDB;

-- ----------------------------------------------------------------------------
-- 10. KELUHAN
-- ----------------------------------------------------------------------------

CREATE TABLE keluhan (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  dusun_id         BIGINT UNSIGNED NOT NULL,
  pelanggan_id     BIGINT UNSIGNED NULL,
  sumur_id         BIGINT UNSIGNED NULL,
  kategori         ENUM('kebocoran','air_mati','kualitas_air','meter','tagihan','lain')
                   NOT NULL DEFAULT 'lain',
  deskripsi        TEXT NOT NULL,
  prioritas        ENUM('rendah','sedang','tinggi') NOT NULL DEFAULT 'sedang',
  status           ENUM('baru','diproses','selesai','ditutup') NOT NULL DEFAULT 'baru',
  dilaporkan_oleh  VARCHAR(120) NULL,
  telepon          VARCHAR(30)  NULL,
  ditangani_oleh   BIGINT UNSIGNED NULL,
  tanggal_lapor    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  tanggal_selesai  DATETIME NULL,
  tindak_lanjut    TEXT NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_keluhan_dusun (dusun_id),
  KEY idx_keluhan_status (status),
  CONSTRAINT fk_keluhan_dusun     FOREIGN KEY (dusun_id)     REFERENCES dusun (id),
  CONSTRAINT fk_keluhan_pelanggan FOREIGN KEY (pelanggan_id) REFERENCES pelanggan (id),
  CONSTRAINT fk_keluhan_sumur     FOREIGN KEY (sumur_id)     REFERENCES sumur (id),
  CONSTRAINT fk_keluhan_petugas   FOREIGN KEY (ditangani_oleh) REFERENCES users (id)
) ENGINE=InnoDB;

-- ----------------------------------------------------------------------------
-- 11. NOTIFIKASI, AUDIT, PENGATURAN
-- ----------------------------------------------------------------------------

CREATE TABLE notifikasi_outbox (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  pelanggan_id   BIGINT UNSIGNED NULL,
  tagihan_id     BIGINT UNSIGNED NULL,
  kanal          ENUM('whatsapp','sms','email','pengumuman') NOT NULL DEFAULT 'whatsapp',
  tujuan         VARCHAR(60) NULL,
  isi            TEXT NOT NULL,
  status         ENUM('antri','terkirim','gagal') NOT NULL DEFAULT 'antri',
  percobaan      SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  error_message  VARCHAR(255) NULL,
  dijadwalkan_at DATETIME NULL,
  terkirim_at    DATETIME NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_notif_status (status, dijadwalkan_at),
  CONSTRAINT fk_notif_pelanggan FOREIGN KEY (pelanggan_id) REFERENCES pelanggan (id),
  CONSTRAINT fk_notif_tagihan   FOREIGN KEY (tagihan_id)   REFERENCES tagihan (id)
) ENGINE=InnoDB;

CREATE TABLE audit_log (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NULL,
  aksi        VARCHAR(40) NOT NULL COMMENT 'login/create/update/delete/verifikasi/generate/batal',
  entitas     VARCHAR(60) NOT NULL,
  entitas_id  BIGINT UNSIGNED NULL,
  data_lama   JSON NULL,
  data_baru   JSON NULL,
  ip_address  VARCHAR(45) NULL,
  user_agent  VARCHAR(255) NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_entitas (entitas, entitas_id),
  KEY idx_audit_user (user_id),
  KEY idx_audit_waktu (created_at),
  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB;

CREATE TABLE pengaturan (
  id        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  desa_id   BIGINT UNSIGNED NOT NULL,
  grup      VARCHAR(40) NOT NULL DEFAULT 'umum',
  kunci     VARCHAR(80) NOT NULL,
  nilai     TEXT NULL,
  tipe      ENUM('string','integer','decimal','boolean','json') NOT NULL DEFAULT 'string',
  PRIMARY KEY (id),
  UNIQUE KEY uq_pengaturan (desa_id, kunci),
  CONSTRAINT fk_pengaturan_desa FOREIGN KEY (desa_id) REFERENCES desa (id)
) ENGINE=InnoDB;

-- ============================================================================
-- DATA CONTOH (silakan sesuaikan)
-- ============================================================================

INSERT INTO desa (nama, kecamatan, kabupaten, alamat, telepon)
VALUES ('Desa Contoh', 'Kecamatan Contoh', 'Kabupaten Contoh', 'Jl. Balai Desa No. 1', '081234567890');

INSERT INTO dusun (desa_id, kode, nama, kepala_dusun) VALUES
  (1, 'D01', 'Dusun Krajan',  'Bapak Sutrisno'),
  (1, 'D02', 'Dusun Ngemplak', 'Bapak Hariyanto'),
  (1, 'D03', 'Dusun Sumber',  'Bapak Suparman');

INSERT INTO sumur (dusun_id, kode, nama, kapasitas_lps, tahun_bor, status) VALUES
  (1, 'SB-01', 'Sumur Bor Krajan I',   2.50, 2018, 'aktif'),
  (1, 'SB-02', 'Sumur Bor Krajan II',  2.00, 2021, 'aktif'),
  (2, 'SB-03', 'Sumur Bor Ngemplak',   3.00, 2019, 'aktif'),
  (3, 'SB-04', 'Sumur Bor Sumber',     2.50, 2020, 'aktif');

INSERT INTO golongan_tarif
  (desa_id, kode, nama, abonemen, min_pemakaian_m3, denda_persen, denda_maks_persen)
VALUES
  (1, 'RT1',   'Rumah Tangga', 5000,  5, 2.00, 24.00),
  (1, 'NIAGA', 'Niaga',       10000,  5, 2.00, 24.00),
  (1, 'SOSIAL','Sosial/Umum',  3000,  5, 0.00,  0.00);

-- Blok 1 mulai dari 0; blok berikutnya batas bawah eksklusif.
INSERT INTO tarif_blok (golongan_id, blok_ke, dari_m3, sampai_m3, harga_per_m3, berlaku_mulai) VALUES
  (1, 1,  0.00, 10.00, 1500.00, '2026-01-01'),
  (1, 2, 10.00, 20.00, 2500.00, '2026-01-01'),
  (1, 3, 20.00, NULL,  3500.00, '2026-01-01'),
  (2, 1,  0.00, NULL,  4000.00, '2026-01-01'),
  (3, 1,  0.00, 10.00, 1000.00, '2026-01-01'),
  (3, 2, 10.00, NULL,  1500.00, '2026-01-01');

-- Akun pengguna sebaiknya dibuat lewat seeder aplikasi agar password ter-hash
-- dengan algoritma yang benar (bcrypt/Argon2id). Contoh:
-- INSERT INTO users (desa_id, dusun_id, nama, username, password_hash, role)
-- VALUES (1, NULL, 'Admin Desa', 'admin_desa', '<hash>', 'admin_desa');

-- ============================================================================
-- CONTOH QUERY LAPORAN
-- ============================================================================

-- 1) Tunggakan per dusun dengan umur tunggakan
-- SELECT p.dusun_id,
--        SUM(t.sisa) AS total_tunggakan,
--        SUM(CASE WHEN DATEDIFF(CURDATE(), t.jatuh_tempo) <= 90 THEN t.sisa ELSE 0 END)  AS umur_0_3_bulan,
--        SUM(CASE WHEN DATEDIFF(CURDATE(), t.jatuh_tempo) BETWEEN 91 AND 180 THEN t.sisa ELSE 0 END) AS umur_4_6_bulan,
--        SUM(CASE WHEN DATEDIFF(CURDATE(), t.jatuh_tempo) > 180 THEN t.sisa ELSE 0 END)  AS umur_lebih_6_bulan
-- FROM tagihan t
-- JOIN pelanggan p ON p.id = t.pelanggan_id
-- WHERE t.status IN ('belum_bayar','sebagian','tunggakan')
-- GROUP BY p.dusun_id;

-- 2) Neraca air per sumur per bulan
-- SELECT s.id, s.nama,
--        COALESCE(SUM(DISTINCT pr.volume_m3), 0) AS produksi_m3
-- FROM sumur s
-- LEFT JOIN produksi_air pr ON pr.sumur_id = s.id
--      AND pr.tanggal BETWEEN '2026-10-01' AND '2026-10-31'
-- GROUP BY s.id, s.nama;

-- 3) Rekap pemakaian & pendapatan per dusun
-- SELECT t.dusun_id,
--        COUNT(*) AS jumlah_tagihan,
--        SUM(t.pemakaian_m3) AS total_m3,
--        SUM(t.total) AS total_tagihan,
--        SUM(t.terbayar) AS total_terbayar
-- FROM tagihan t
-- WHERE t.periode_id = ?
-- GROUP BY t.dusun_id;
