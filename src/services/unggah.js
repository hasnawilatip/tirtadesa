'use strict';

/**
 * Unggahan berkas yang aman:
 * - disimpan DI LUAR `public/` (folder `storage/uploads`) dan hanya disajikan
 *   lewat rute berautentikasi,
 * - nama berkas acak, ekstensi ditentukan dari tipe MIME (bukan nama asli),
 * - isi berkas diverifikasi lewat magic bytes sehingga berkas HTML/JS tidak
 *   bisa menyamar sebagai gambar.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { STORAGE_DIR } = require('../config');

const AKAR = path.join(STORAGE_DIR, 'uploads');
const FOLDER_SAH = ['logo', 'meter', 'bayar'];

const EKSTENSI = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
};

function folder(nama) {
  const bersih = FOLDER_SAH.includes(nama) ? nama : null;
  if (!bersih) throw new Error(`Folder unggahan tidak dikenal: ${nama}`);
  const dir = path.join(AKAR, bersih);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Deteksi tipe berkas dari 16 byte pertama (magic bytes). */
function deteksiMime(lokasi) {
  try {
    const fd = fs.openSync(lokasi, 'r');
    const buf = Buffer.alloc(16);
    const dibaca = fs.readSync(fd, buf, 0, 16, 0);
    fs.closeSync(fd);
    if (dibaca < 4) return null;
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (
      buf.slice(0, 4).toString('ascii') === 'RIFF'
      && buf.slice(8, 12).toString('ascii') === 'WEBP'
    ) return 'image/webp';
    if (buf.slice(0, 4).toString('ascii') === '%PDF') return 'application/pdf';
    return null;
  } catch (err) {
    return null;
  }
}

function daftarBerkas(req) {
  if (req.file) return [req.file];
  if (Array.isArray(req.files)) return req.files;
  if (req.files && typeof req.files === 'object') {
    return Object.values(req.files).flat();
  }
  return [];
}

/**
 * Middleware validasi isi berkas setelah multer selesai menyimpannya.
 * Mengganti ekstensi berkas sesuai tipe asli dan menghapus berkas palsu.
 */
function validasiBerkas(tipe, pesan) {
  return (req, res, next) => {
    const diizinkan = Array.isArray(tipe) ? tipe : [];
    for (const berkas of daftarBerkas(req)) {
      const mime = deteksiMime(berkas.path);
      if (!mime || !diizinkan.includes(mime)) {
        fs.promises.unlink(berkas.path).catch(() => {});
        return next(new Error(pesan || 'Isi berkas tidak sesuai dengan tipe yang diizinkan.'));
      }
      const ekstensi = EKSTENSI[mime] || path.extname(berkas.filename);
      const namaBaru = `${path.basename(berkas.filename, path.extname(berkas.filename))}${ekstensi}`;
      if (namaBaru !== berkas.filename) {
        const tujuan = path.join(path.dirname(berkas.path), namaBaru);
        try {
          fs.renameSync(berkas.path, tujuan);
          berkas.filename = namaBaru;
          berkas.path = tujuan;
        } catch (err) {
          fs.promises.unlink(berkas.path).catch(() => {});
          return next(new Error('Gagal menyimpan berkas unggahan.'));
        }
      }
    }
    return next();
  };
}

/**
 * @param {object} opsi
 * @param {string} opsi.folder    nama subfolder di storage/uploads
 * @param {string} opsi.prefix    awalan nama berkas
 * @param {string[]} opsi.tipe    daftar mimetype yang diterima
 * @param {number} [opsi.batas]   ukuran maksimum (byte)
 * @param {string} [opsi.pesan]   pesan kesalahan tipe berkas
 */
function buatUnggahan({ folder: namaFolder, prefix, tipe, batas = 2 * 1024 * 1024, pesan }) {
  const dir = folder(namaFolder);
  const mesin = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, dir),
      filename: (req, file, cb) => {
        const ekstensi = EKSTENSI[String(file.mimetype || '')] || '.bin';
        cb(null, `${prefix}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ekstensi}`);
      },
    }),
    limits: { fileSize: batas, files: 3 },
    fileFilter: (req, file, cb) => {
      const mime = String(file.mimetype || '');
      if (!tipe.includes(mime)) {
        return cb(new Error(pesan || 'Tipe berkas tidak didukung.'));
      }
      return cb(null, true);
    },
  });
  mesin.validasi = validasiBerkas(tipe, pesan);
  return mesin;
}

/** Hapus berkas unggahan lama dengan aman (hanya di dalam storage/uploads). */
function hapusBerkas(relPath) {
  const bersih = String(relPath || '');
  if (!bersih.startsWith('/uploads/')) return;
  const bagian = bersih.split('/').filter(Boolean); // ['uploads', folder, nama]
  if (bagian.length !== 3) return;
  const namaFolder = bagian[1];
  const namaBerkas = path.basename(bagian[2]);
  if (!FOLDER_SAH.includes(namaFolder) || namaBerkas !== bagian[2]) return;
  fs.promises.unlink(path.join(AKAR, namaFolder, namaBerkas)).catch(() => {});
}

/**
 * Pindahkan berkas lama dari `public/uploads` ke `storage/uploads`
 * supaya tidak lagi dapat diakses tanpa autentikasi. Aman dijalankan berulang.
 */
function migrasiKeStorage() {
  const lama = path.join(__dirname, '..', '..', 'public', 'uploads');
  if (!fs.existsSync(lama)) return 0;
  let dipindah = 0;
  FOLDER_SAH.forEach((namaFolder) => {
    const asal = path.join(lama, namaFolder);
    if (!fs.existsSync(asal)) return;
    const tujuan = folder(namaFolder);
    for (const berkas of fs.readdirSync(asal)) {
      const dari = path.join(asal, berkas);
      let info;
      try {
        info = fs.statSync(dari);
      } catch (err) {
        continue;
      }
      if (!info.isFile()) continue;
      const ke = path.join(tujuan, berkas);
      if (fs.existsSync(ke)) continue;
      try {
        fs.renameSync(dari, ke);
        dipindah += 1;
      } catch (err) {
        try {
          fs.copyFileSync(dari, ke);
          fs.unlinkSync(dari);
          dipindah += 1;
        } catch (err2) {
          console.error(`Gagal memindahkan ${dari}: ${err2.message}`);
        }
      }
    }
    try {
      fs.rmdirSync(asal);
    } catch (err) {
      // masih ada berkas/berkas tersembunyi — biarkan
    }
  });
  try {
    fs.rmdirSync(lama);
  } catch (err) {
    // biarkan bila masih berisi
  }
  return dipindah;
}

module.exports = {
  buatUnggahan,
  hapusBerkas,
  folder,
  validasiBerkas,
  deteksiMime,
  migrasiKeStorage,
  AKAR,
  EKSTENSI,
};
