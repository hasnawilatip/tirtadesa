'use strict';

/**
 * Perhitungan penggajian karyawan.
 *
 * Aturan yang dipakai:
 * - Gaji pokok + tunjangan tetap dibayar penuh.
 * - Upah lembur = total jam lembur pada absensi bulan itu × tarif lembur karyawan.
 * - Potongan alpa = jumlah hari berstatus `alpa` × potongan harian.
 *   Bila potongan harian karyawan 0, dipakai gaji pokok ÷ 25.
 * - Potongan tetap (mis. BPJS) dipotong setiap bulan.
 * - Kasbon dipotong dari gaji dengan batas 50% gaji bersih sebelum kasbon,
 *   sisanya tetap berstatus terbuka dan dipotong pada bulan berikutnya.
 * - Izin, sakit, dan cuti tidak dipotong (hanya dicatat pada rekap absensi).
 */

const { db } = require('../db');
const { nomorPenggajianBaru } = require('./penomoran');

const METODE_BAYAR = ['tunai', 'transfer', 'lain'];

function dua(n) {
  return String(n).padStart(2, '0');
}

function angka(n) {
  return Math.max(0, Number(n) || 0);
}

/** Rentang tanggal satu bulan; `selesai` bersifat eksklusif. */
function rentangBulan(tahun, bulan) {
  const mulai = `${tahun}-${dua(bulan)}-01`;
  const berikut = bulan === 12 ? [tahun + 1, 1] : [tahun, bulan + 1];
  const selesai = `${berikut[0]}-${dua(berikut[1])}-01`;
  return { mulai, selesai };
}

/** Jumlah hari dalam bulan (untuk tampilan). */
function jumlahHari(tahun, bulan) {
  return new Date(tahun, bulan, 0).getDate();
}

function rekapAbsensi(karyawanId, tahun, bulan) {
  const { mulai, selesai } = rentangBulan(tahun, bulan);
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status = 'hadir' THEN 1 ELSE 0 END), 0) AS hadir,
      COALESCE(SUM(CASE WHEN status = 'izin'  THEN 1 ELSE 0 END), 0) AS izin,
      COALESCE(SUM(CASE WHEN status = 'sakit' THEN 1 ELSE 0 END), 0) AS sakit,
      COALESCE(SUM(CASE WHEN status = 'cuti'  THEN 1 ELSE 0 END), 0) AS cuti,
      COALESCE(SUM(CASE WHEN status = 'alpa'  THEN 1 ELSE 0 END), 0) AS alpa,
      COALESCE(SUM(CASE WHEN status = 'libur' THEN 1 ELSE 0 END), 0) AS libur,
      COALESCE(SUM(lembur_jam), 0) AS lembur
    FROM absensi
    WHERE karyawan_id = ? AND tanggal >= ? AND tanggal < ?
  `).get(karyawanId, mulai, selesai);

  return {
    hadir: Number(row.hadir) || 0,
    izin: Number(row.izin) || 0,
    sakit: Number(row.sakit) || 0,
    cuti: Number(row.cuti) || 0,
    alpa: Number(row.alpa) || 0,
    libur: Number(row.libur) || 0,
    lembur: Number(row.lembur) || 0,
  };
}

/** Daftar kasbon yang masih terbuka beserta sisa utangnya. */
function kasbonTerbuka(karyawanId) {
  const rows = db.prepare(`
    SELECT k.id, k.nomor, k.tanggal, k.jumlah, k.keterangan,
           COALESCE((SELECT SUM(b.jumlah) FROM kasbon_bayar b WHERE b.kasbon_id = k.id), 0) AS dibayar
    FROM kasbon k
    WHERE k.karyawan_id = ? AND k.status = 'terbuka'
    ORDER BY k.tanggal, k.id
  `).all(karyawanId);
  return rows.map((r) => ({ ...r, sisa: Math.max(0, angka(r.jumlah) - angka(r.dibayar)) }));
}

function totalKasbonTerbuka(karyawanId) {
  return kasbonTerbuka(karyawanId).reduce((a, r) => a + r.sisa, 0);
}

function potonganAlpaHarian(karyawan) {
  const tetap = angka(karyawan.potongan_alpa);
  if (tetap > 0) return tetap;
  return Math.round(angka(karyawan.gaji_pokok) / 25);
}

/** Hitung satu slip tanpa menyimpannya. */
function hitungSlip(karyawan, tahun, bulan) {
  const absen = rekapAbsensi(karyawan.id, tahun, bulan);
  const gajiPokok = angka(karyawan.gaji_pokok);
  const tunjangan = angka(karyawan.tunjangan_tetap);
  const upahLembur = Math.round(absen.lembur * angka(karyawan.tarif_lembur));
  const potonganHarian = potonganAlpaHarian(karyawan);
  const potonganAlpa = Math.round(absen.alpa * potonganHarian);
  const potonganTetap = angka(karyawan.potongan_tetap);

  const totalPendapatan = gajiPokok + tunjangan + upahLembur;
  const potonganDasar = potonganAlpa + potonganTetap;
  const sisaKasbon = totalKasbonTerbuka(karyawan.id);
  const ruang = Math.max(0, totalPendapatan - potonganDasar);
  const batasKasbon = Math.floor(ruang * 0.5);
  const potonganKasbon = Math.min(sisaKasbon, batasKasbon);
  const totalPotongan = potonganDasar + potonganKasbon;
  const gajiBersih = Math.max(0, totalPendapatan - totalPotongan);

  return {
    ...absen,
    gaji_pokok: gajiPokok,
    tunjangan,
    upah_lembur: upahLembur,
    bonus: 0,
    potongan_alpa: potonganAlpa,
    potongan_tetap: potonganTetap,
    potongan_kasbon: potonganKasbon,
    total_pendapatan: totalPendapatan,
    total_potongan: totalPotongan,
    gaji_bersih: gajiBersih,
    potongan_harian: potonganHarian,
    sisa_kasbon: sisaKasbon,
  };
}

function adaSlip(karyawanId, tahun, bulan) {
  return db.prepare('SELECT id FROM penggajian WHERE karyawan_id = ? AND tahun = ? AND bulan = ?')
    .get(karyawanId, tahun, bulan);
}

/** Buat slip draf untuk satu karyawan. Mengembalikan null bila sudah ada. */
function buatSlip(karyawan, tahun, bulan, userId) {
  if (adaSlip(karyawan.id, tahun, bulan)) return null;
  const h = hitungSlip(karyawan, tahun, bulan);
  const nomor = nomorPenggajianBaru(karyawan.desa_id, tahun);
  const info = db.prepare(`
    INSERT INTO penggajian
      (desa_id, karyawan_id, nomor, tahun, bulan,
       hari_hadir, hari_izin, hari_sakit, hari_cuti, hari_alpa, lembur_jam,
       gaji_pokok, tunjangan, upah_lembur, bonus,
       potongan_alpa, potongan_tetap, potongan_kasbon,
       total_pendapatan, total_potongan, gaji_bersih, status, dibuat_oleh)
    VALUES (?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?, ?,?,?, ?,?,?, 'draf', ?)
  `).run(
    karyawan.desa_id, karyawan.id, nomor, tahun, bulan,
    h.hadir, h.izin, h.sakit, h.cuti, h.alpa, h.lembur,
    h.gaji_pokok, h.tunjangan, h.upah_lembur, h.bonus,
    h.potongan_alpa, h.potongan_tetap, h.potongan_kasbon,
    h.total_pendapatan, h.total_potongan, h.gaji_bersih, userId,
  );
  return db.prepare('SELECT * FROM penggajian WHERE id = ?').get(info.lastInsertRowid);
}

/** Hitung ulang slip yang masih draf (mis. absensi baru ditambahkan). */
function hitungUlang(slipId) {
  const slip = db.prepare('SELECT * FROM penggajian WHERE id = ?').get(slipId);
  if (!slip) throw new Error('Slip gaji tidak ditemukan.');
  if (slip.status !== 'draf') throw new Error('Slip yang sudah dibayar tidak dapat dihitung ulang.');
  const karyawan = db.prepare('SELECT * FROM karyawan WHERE id = ?').get(slip.karyawan_id);
  if (!karyawan) throw new Error('Karyawan tidak ditemukan.');
  const h = hitungSlip(karyawan, slip.tahun, slip.bulan);
  db.prepare(`
    UPDATE penggajian SET
      hari_hadir = ?, hari_izin = ?, hari_sakit = ?, hari_cuti = ?, hari_alpa = ?, lembur_jam = ?,
      gaji_pokok = ?, tunjangan = ?, upah_lembur = ?,
      potongan_alpa = ?, potongan_tetap = ?, potongan_kasbon = ?,
      total_pendapatan = ?, total_potongan = ?, gaji_bersih = ?
    WHERE id = ?
  `).run(
    h.hadir, h.izin, h.sakit, h.cuti, h.alpa, h.lembur,
    h.gaji_pokok, h.tunjangan, h.upah_lembur,
    h.potongan_alpa, h.potongan_tetap, h.potongan_kasbon,
    h.total_pendapatan, h.total_potongan, h.gaji_bersih, slip.id,
  );
  return db.prepare('SELECT * FROM penggajian WHERE id = ?').get(slip.id);
}

/**
 * Tandai slip dibayar sekaligus memotong kasbon karyawan (FIFO).
 * Potongan kasbon yang tercatat pada slip dibagikan ke kasbon terbuka.
 */
function bayarSlip(slipId, { tanggalBayar, metode, catatan } = {}, userId) {
  const jalankan = db.transaction(() => {
    const slip = db.prepare('SELECT * FROM penggajian WHERE id = ?').get(slipId);
    if (!slip) throw new Error('Slip gaji tidak ditemukan.');
    if (slip.status === 'dibayar') throw new Error('Slip gaji ini sudah dibayar.');
    const tanggal = String(tanggalBayar || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggal)) throw new Error('Tanggal bayar tidak valid.');
    const cara = METODE_BAYAR.includes(metode) ? metode : 'tunai';

    db.prepare(`
      UPDATE penggajian
      SET status = 'dibayar', tanggal_bayar = ?, metode = ?, catatan = ?,
          dibayar_oleh = ?, dibayar_at = datetime('now','localtime')
      WHERE id = ?
    `).run(tanggal, cara, catatan ? String(catatan).trim() : null, userId, slip.id);

    // Potong kasbon yang masih terbuka.
    let sisaPotongan = angka(slip.potongan_kasbon);
    if (sisaPotongan > 0) {
      const daftar = kasbonTerbuka(slip.karyawan_id);
      const catat = db.prepare(`INSERT INTO kasbon_bayar
        (kasbon_id, tanggal, jumlah, keterangan, dicatat_oleh) VALUES (?,?,?,?,?)`);
      const lunas = db.prepare("UPDATE kasbon SET status = 'lunas' WHERE id = ?");
      for (const k of daftar) {
        if (sisaPotongan <= 0) break;
        const bayar = Math.min(k.sisa, sisaPotongan);
        if (bayar <= 0) continue;
        catat.run(k.id, tanggal, bayar, `Potongan gaji ${slip.nomor}`, userId);
        sisaPotongan -= bayar;
        if (bayar >= k.sisa) lunas.run(k.id);
      }
    }

    return db.prepare('SELECT * FROM penggajian WHERE id = ?').get(slip.id);
  });
  return jalankan();
}

function ringkasanPeriode(desaId, tahun, bulan) {
  const row = db.prepare(`
    SELECT COUNT(*) AS jumlah,
           COALESCE(SUM(total_pendapatan), 0) AS pendapatan,
           COALESCE(SUM(total_potongan), 0) AS potongan,
           COALESCE(SUM(gaji_bersih), 0) AS bersih,
           COALESCE(SUM(CASE WHEN status = 'dibayar' THEN gaji_bersih ELSE 0 END), 0) AS dibayar,
           COALESCE(SUM(CASE WHEN status = 'draf' THEN gaji_bersih ELSE 0 END), 0) AS draf
    FROM penggajian WHERE desa_id = ? AND tahun = ? AND bulan = ?
  `).get(desaId, tahun, bulan);
  return {
    jumlah: Number(row.jumlah) || 0,
    pendapatan: Number(row.pendapatan) || 0,
    potongan: Number(row.potongan) || 0,
    bersih: Number(row.bersih) || 0,
    dibayar: Number(row.dibayar) || 0,
    draf: Number(row.draf) || 0,
  };
}

module.exports = {
  METODE_BAYAR,
  rentangBulan,
  jumlahHari,
  rekapAbsensi,
  kasbonTerbuka,
  totalKasbonTerbuka,
  potonganAlpaHarian,
  hitungSlip,
  buatSlip,
  hitungUlang,
  bayarSlip,
  ringkasanPeriode,
};
