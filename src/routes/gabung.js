'use strict';

const express = require('express');
const { db } = require('../db');
const { audit } = require('../helpers');
const { daftarPaket, paketById } = require('../services/langganan');
const rateLimit = require('../services/rate-limit');

const router = express.Router();

const UKURAN_PELANGGAN = ['<25', '25-100', '101-300', '>300'];
const JENIS = ['desa', 'dusun', 'individu'];

function bersihkanWa(nilai) {
  let digit = String(nilai || '').replace(/[^\d]/g, '');
  if (digit.startsWith('0')) digit = `62${digit.slice(1)}`;
  return digit;
}

/** Body bisa berisi array bila ada kolom bernama sama; ambil nilai pertama yang terisi. */
function teks(nilai) {
  if (Array.isArray(nilai)) return String(nilai.find((v) => v && String(v).trim()) || '').trim();
  return String(nilai || '').trim();
}

function validasi(form) {
  if (!JENIS.includes(form.jenis)) return 'Pilih jenis pendaftaran terlebih dahulu.';
  if (form.nama.length < 3) return 'Nama lengkap minimal 3 karakter.';
  if (form.whatsapp.length < 9 || form.whatsapp.length > 15) {
    return 'Nomor WhatsApp tidak valid. Contoh: 081234567890.';
  }
  if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
    return 'Alamat email tidak valid.';
  }
  if (!form.paket_id || !paketById(form.paket_id)) {
    return 'Pilih paket langganan yang diinginkan.';
  }
  if (form.jenis === 'desa' && (!form.nama_desa || !form.kecamatan || !form.kabupaten || !form.provinsi)) {
    return 'Provinsi, kabupaten/kota, kecamatan, dan desa wajib dipilih.';
  }
  if (form.jenis === 'dusun'
    && (!form.nama_dusun || !form.desa_induk || !form.kecamatan || !form.kabupaten || !form.provinsi)) {
    return 'Nama dusun, desa induk, kecamatan, kabupaten/kota, dan provinsi wajib diisi.';
  }
  if (form.jenis === 'individu') {
    const wilayahLengkap = form.provinsi && form.kabupaten && form.kecamatan && form.nama_desa;
    if (!form.nama_usaha) return 'Nama usaha/sumur bor wajib diisi.';
    if (!wilayahLengkap && !form.lokasi) {
      return 'Provinsi, kabupaten/kota, kecamatan, dan desa/kelurahan wajib dipilih sebagai alamat usaha.';
    }
  }
  return null;
}

/** Bentuk nama unit & lokasi yang konsisten untuk ditampilkan di panel superadmin. */
function susunIdentitas(form) {
  if (form.jenis === 'desa') {
    return {
      usaha: `Pemerintah Desa ${form.nama_desa}`,
      lokasi: [`Desa ${form.nama_desa}`, `Kec. ${form.kecamatan}`, form.kabupaten, form.provinsi]
        .filter(Boolean).join(', '),
    };
  }
  if (form.jenis === 'dusun') {
    return {
      usaha: `Pengelola Dusun ${form.nama_dusun}`,
      lokasi: [`Dusun ${form.nama_dusun}`, `Desa ${form.desa_induk}`,
        form.kecamatan ? `Kec. ${form.kecamatan}` : '', form.kabupaten, form.provinsi]
        .filter(Boolean).join(', '),
    };
  }
  if (form.jenis === 'individu') {
    // Alamat usaha disusun dari pilihan wilayah (dropdown) bila tersedia.
    const alamat = [
      form.nama_desa ? `Desa ${form.nama_desa}` : '',
      form.kecamatan ? `Kec. ${form.kecamatan}` : '',
      form.kabupaten, form.provinsi,
    ].filter(Boolean);
    return {
      usaha: form.nama_usaha,
      lokasi: alamat.length ? alamat.join(', ') : (form.lokasi || form.nama_usaha),
    };
  }
  return { usaha: form.nama_usaha, lokasi: form.lokasi };
}

function formKosong() {
  return { jenis: 'desa' };
}

router.get('/gabung', (req, res) => {
  if (req.user) return res.redirect('/');
  const paketList = daftarPaket({ hanyaAktif: true });
  const diminta = Number(req.query.paket) || null;
  const pilihan = paketList.find((p) => Number(p.id) === Number(diminta));
  return res.render('gabung', {
    layout: false,
    sukses: req.query.sukses === '1',
    error: null,
    ukuranPelanggan: UKURAN_PELANGGAN,
    paketList,
    form: { ...formKosong(), paket_id: pilihan ? pilihan.id : '' },
  });
});

router.post('/gabung', rateLimit.middleware({
  kunci: (req) => `gabung:${req.ip}`,
  batas: 20,
  jendelaMs: 60 * 60 * 1000,
  pesan: 'Terlalu banyak pendaftaran dari jaringan ini. Coba lagi dalam satu jam.',
}), (req, res) => {
  if (req.user) return res.redirect('/');

  const form = {
    jenis: JENIS.includes(req.body.jenis) ? req.body.jenis : '',
    nama: teks(req.body.nama),
    whatsapp: bersihkanWa(teks(req.body.whatsapp)),
    email: teks(req.body.email),
    jumlah_pelanggan: UKURAN_PELANGGAN.includes(req.body.jumlah_pelanggan) ? req.body.jumlah_pelanggan : '',
    pesan: teks(req.body.pesan),
    nama_desa: teks(req.body.nama_desa),
    kecamatan: teks(req.body.kecamatan),
    kabupaten: teks(req.body.kabupaten),
    provinsi: teks(req.body.provinsi),
    nama_dusun: teks(req.body.nama_dusun),
    desa_induk: teks(req.body.desa_induk),
    nama_usaha: teks(req.body.nama_usaha),
    lokasi: teks(req.body.lokasi),
    paket_id: Number(teks(req.body.paket_id)) || '',
  };

  const error = validasi(form);
  if (error) {
    return res.status(400).render('gabung', {
      layout: false,
      sukses: false,
      error,
      ukuranPelanggan: UKURAN_PELANGGAN,
      paketList: daftarPaket({ hanyaAktif: true }),
      form,
    });
  }

  const identitas = susunIdentitas(form);
  const info = db.prepare(`INSERT INTO pendaftaran_pengelola
    (jenis, nama, usaha, lokasi, provinsi, jumlah_pelanggan, whatsapp, email, pesan, paket_id)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    form.jenis,
    form.nama,
    identitas.usaha,
    identitas.lokasi,
    form.provinsi || null,
    form.jumlah_pelanggan || null,
    form.whatsapp,
    form.email || null,
    form.pesan || null,
    form.paket_id
  );
  const paket = paketById(form.paket_id);
  audit(req, 'create', 'pendaftaran_pengelola', info.lastInsertRowid,
    `${form.jenis}: ${identitas.usaha} · ${form.whatsapp} · paket ${paket ? paket.kode : '-'}`);
  return res.redirect('/gabung?sukses=1');
});

module.exports = router;

