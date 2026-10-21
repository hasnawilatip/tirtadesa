'use strict';

/**
 * Langganan & kuota paket.
 * Paket menentukan batas jumlah pelanggan, sumur, dan dusun (0 = tanpa batas).
 * Semua pemeriksaan memakai desa_id sebagai tenant.
 */

const { db } = require('../db');
const { todayISO } = require('../helpers');

const JENIS = ['pelanggan', 'sumur', 'dusun'];

function daftarPaket({ hanyaAktif = false } = {}) {
  const syarat = hanyaAktif ? 'WHERE is_active = 1' : '';
  return db.prepare(`SELECT * FROM paket ${syarat} ORDER BY urutan, harga, id`).all();
}

function paketById(id) {
  return db.prepare('SELECT * FROM paket WHERE id = ?').get(Number(id));
}

function hitungDipakai(desaId) {
  return {
    pelanggan: db.prepare("SELECT COUNT(*) AS n FROM pelanggan WHERE desa_id = ? AND status <> 'nonaktif'")
      .get(desaId).n,
    sumur: db.prepare(`SELECT COUNT(*) AS n FROM sumur s JOIN dusun d ON d.id = s.dusun_id
      WHERE d.desa_id = ?`).get(desaId).n,
    dusun: db.prepare('SELECT COUNT(*) AS n FROM dusun WHERE desa_id = ?').get(desaId).n,
  };
}

function selisihHari(tanggal) {
  if (!tanggal) return null;
  const akhir = new Date(`${String(tanggal).slice(0, 10)}T00:00:00`);
  const kini = new Date(`${todayISO()}T00:00:00`);
  return Math.round((akhir - kini) / 86400000);
}

/**
 * Ringkasan langganan satu pengelola: paket, pemakaian, sisa kuota, peringatan.
 */
function infoLangganan(desaId) {
  const desa = db.prepare('SELECT * FROM desa WHERE id = ?').get(desaId);
  if (!desa) return null;
  const paket = desa.paket_id ? paketById(desa.paket_id) : null;
  const dipakai = hitungDipakai(desaId);
  const batas = {
    pelanggan: paket ? Number(paket.maks_pelanggan) : 0,
    sumur: paket ? Number(paket.maks_sumur) : 0,
    dusun: paket ? Number(paket.maks_dusun) : 0,
  };
  const sisa = {};
  JENIS.forEach((jenis) => {
    sisa[jenis] = batas[jenis] > 0 ? Math.max(0, batas[jenis] - dipakai[jenis]) : null;
  });
  const hari = selisihHari(desa.langganan_sampai);
  const peringatan = [];
  if (!paket) peringatan.push('Pengelola belum memiliki paket langganan.');
  if (desa.status_langganan && desa.status_langganan !== 'aktif') {
    peringatan.push(`Status langganan: ${desa.status_langganan}.`);
  }
  if (hari != null && hari < 0) peringatan.push('Masa langganan sudah berakhir — perpanjang agar layanan tetap aktif.');
  else if (hari != null && hari <= 7) peringatan.push(`Masa langganan berakhir dalam ${hari} hari.`);
  // Catatan: kuota penuh TIDAK dijadikan peringatan menetap. Pesan kuota hanya
  // muncul saat pengelola benar-benar mencoba menambah data melebihi paket
  // (lihat cekKuota) dan lewat bar pemakaian di kartu langganan.
  const kuotaPenuh = JENIS.filter((jenis) => batas[jenis] > 0 && dipakai[jenis] >= batas[jenis]);
  return {
    desa,
    paket,
    batas,
    dipakai,
    sisa,
    hari,
    peringatan,
    kuotaPenuh,
    bisaTambah: {
      pelanggan: batas.pelanggan === 0 || dipakai.pelanggan < batas.pelanggan,
      sumur: batas.sumur === 0 || dipakai.sumur < batas.sumur,
      dusun: batas.dusun === 0 || dipakai.dusun < batas.dusun,
    },
  };
}

/**
 * Cek apakah pengelola masih boleh menambah data jenis tertentu.
 * Mengembalikan { izin, pesan, info }.
 */
function cekKuota(desaId, jenis, tambahan = 1) {
  if (!JENIS.includes(jenis)) return { izin: true, info: null };
  const info = infoLangganan(desaId);
  if (!info) return { izin: false, pesan: 'Pengelola tidak ditemukan.', info: null };
  const status = String(info.desa.status_langganan || 'aktif');
  if (status === 'ditangguhkan') {
    return {
      izin: false,
      pesan: 'Langganan pengelola sedang ditangguhkan. Hubungi penyedia layanan untuk mengaktifkan kembali.',
      info,
    };
  }
  const batas = info.batas[jenis];
  if (batas > 0 && info.dipakai[jenis] + tambahan > batas) {
    return {
      izin: false,
      pesan: `Kuota ${jenis} paket ${info.paket ? info.paket.nama : '-'} sudah penuh `
        + `(${info.dipakai[jenis]}/${batas}). Perbesar paket langganan untuk menambah ${jenis}.`,
      info,
    };
  }
  return { izin: true, info, pesan: null };
}

/** Pemakaian kuota semua pengelola (untuk panel superadmin). */
function ringkasanSemuaDesa() {
  const desaList = db.prepare('SELECT * FROM desa ORDER BY nama').all();
  return desaList.map((desa) => {
    const info = infoLangganan(desa.id);
    return {
      ...info,
      pelanggan: info.dipakai.pelanggan,
      sumur: info.dipakai.sumur,
      dusun: info.dipakai.dusun,
    };
  });
}

module.exports = {
  JENIS,
  daftarPaket,
  paketById,
  hitungDipakai,
  infoLangganan,
  cekKuota,
  ringkasanSemuaDesa,
};
