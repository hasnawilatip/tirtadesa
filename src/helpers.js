'use strict';

const { db } = require('./db');

const BULAN = ['', 'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

const STATUS_LABEL = {
  draft: 'Draf',
  baca_meter: 'Baca Meter',
  verifikasi: 'Verifikasi',
  tagihan_terbit: 'Tagihan Terbit',
  tutup: 'Tutup',
  belum_bayar: 'Belum Bayar',
  sebagian: 'Sebagian',
  lunas: 'Lunas',
  tunggakan: 'Tunggakan',
  batal: 'Batal',
  diajukan: 'Diajukan',
  final: 'Final',
  ditolak: 'Ditolak',
  aktif: 'Aktif',
  nonaktif: 'Nonaktif',
  perbaikan: 'Perbaikan',
  baru: 'Baru',
  diproses: 'Diproses',
  selesai: 'Selesai',
  ditutup: 'Ditutup',
  normal: 'Normal',
  rusak: 'Rusak',
  macet: 'Macet',
  tidak_dihuni: 'Tidak Dihuni',
  draf: 'Draf',
  disetujui: 'Disetujui',
  terpasang: 'Terpasang',
  dibatalkan: 'Dibatalkan',
  diterima: 'Diterima',
  menipis: 'Menipis',
  habis: 'Habis',
  aman: 'Aman',
  masuk: 'Masuk',
  keluar: 'Keluar',
  koreksi: 'Koreksi',
  hadir: 'Hadir',
  izin: 'Izin',
  sakit: 'Sakit',
  cuti: 'Cuti',
  alpa: 'Tanpa Keterangan',
  libur: 'Libur',
  terbuka: 'Terbuka',
  dibayar: 'Dibayar',
};

function rupiah(n) {
  const num = Number(n) || 0;
  return `Rp ${new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 }).format(Math.round(num))}`;
}

function angka(n, desimal = 0) {
  return new Intl.NumberFormat('id-ID', {
    minimumFractionDigits: desimal,
    maximumFractionDigits: desimal,
  }).format(Number(n) || 0);
}

function tanggal(iso) {
  if (!iso) return '-';
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getDate()} ${BULAN[d.getMonth() + 1]} ${d.getFullYear()}`;
}

function periodeLabel(tahun, bulan) {
  return `${BULAN[bulan] || '?'} ${tahun}`;
}

function statusKelas(status) {
  if (['lunas', 'aktif', 'final', 'selesai', 'terpasang', 'aman', 'masuk', 'diterima', 'hadir', 'dibayar'].includes(status)) return 'badge-success';
  if (['sebagian', 'diproses', 'baca_meter', 'diajukan', 'perbaikan', 'disetujui', 'menipis', 'koreksi', 'izin', 'sakit', 'cuti', 'terbuka'].includes(status)) return 'badge-warning';
  if (['tunggakan', 'ditolak', 'rusak', 'macet', 'nonaktif', 'habis', 'alpa'].includes(status)) return 'badge-danger';
  if (['batal', 'ditutup', 'tidak_dihuni', 'dibatalkan', 'draf', 'libur'].includes(status)) return 'badge-muted';
  return 'badge-info';
}

const ANGKA_TERBILANG = ['', 'satu', 'dua', 'tiga', 'empat', 'lima', 'enam', 'tujuh',
  'delapan', 'sembilan', 'sepuluh', 'sebelas'];

function terbilang(n) {
  const num = Math.floor(Math.abs(Number(n) || 0));
  if (num < 12) return ANGKA_TERBILANG[num];
  if (num < 20) return `${terbilang(num - 10)} belas`.trim();
  if (num < 100) return `${terbilang(Math.floor(num / 10))} puluh ${terbilang(num % 10)}`.trim();
  if (num < 200) return `seratus ${terbilang(num - 100)}`.trim();
  if (num < 1000) return `${terbilang(Math.floor(num / 100))} ratus ${terbilang(num % 100)}`.trim();
  if (num < 2000) return `seribu ${terbilang(num - 1000)}`.trim();
  if (num < 1000000) return `${terbilang(Math.floor(num / 1000))} ribu ${terbilang(num % 1000)}`.trim();
  if (num < 1000000000) return `${terbilang(Math.floor(num / 1000000))} juta ${terbilang(num % 1000000)}`.trim();
  return `${terbilang(Math.floor(num / 1000000000))} miliar ${terbilang(num % 1000000000)}`.trim();
}

function todayISO() {
  return formatISO(new Date());
}

/** Format tanggal lokal YYYY-MM-DD (toISOString bisa bergeser satu hari karena UTC). */
function formatISO(d = new Date()) {
  const tahun = d.getFullYear();
  const bulan = String(d.getMonth() + 1).padStart(2, '0');
  const tanggal = String(d.getDate()).padStart(2, '0');
  return `${tahun}-${bulan}-${tanggal}`;
}

function flashMiddleware(req, res, next) {
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  req.flash = (type, message) => {
    let teks = String(message == null ? '' : message);
    // Jangan bocorkan detail skema/penyimpanan ke pengguna.
    if (/SQLITE_|constraint failed|FOREIGN KEY|UNIQUE constraint|NOT NULL constraint|no such (table|column)|datatype mismatch/i.test(teks)) {
      console.error('Pesan galat internal disembunyikan:', teks);
      teks = 'Permintaan tidak dapat diproses. Periksa kembali data yang diisi.';
    }
    req.session.flash = { type, message: teks };
  };
  next();
}

function audit(req, aksi, entitas, entitasId = null, detail = null) {
  try {
    db.prepare(`INSERT INTO audit_log (user_id, aksi, entitas, entitas_id, detail, ip_address)
      VALUES (?,?,?,?,?,?)`).run(
      req.user ? req.user.id : null, aksi, entitas, entitasId, detail, req.ip || null
    );
  } catch (err) {
    console.error('Gagal menulis audit:', err.message);
  }
}

/** Catat percobaan login gagal (tanpa menyimpan kata sandi). */
function auditLoginGagal(req, username, alasan) {
  try {
    const user = db.prepare('SELECT id FROM users WHERE username = ?').get(String(username || '').trim().toLowerCase());
    db.prepare(`INSERT INTO audit_log (user_id, aksi, entitas, entitas_id, detail, ip_address)
      VALUES (?, 'login_gagal', 'users', ?, ?, ?)`).run(
      user ? user.id : null,
      user ? user.id : null,
      `Percobaan masuk gagal untuk "${String(username || '').slice(0, 64)}" (${alasan})`,
      req.ip || null
    );
  } catch (err) {
    console.error('Gagal menulis audit login gagal:', err.message);
  }
}

/**
 * JSON aman untuk ditanam di dalam <script>.
 * Mencegah `</script>` pada data pengguna memutus blok skrip (XSS).
 */
function jsonAman(nilai) {
  return JSON.stringify(nilai === undefined ? null : nilai)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

module.exports = {
  BULAN,
  STATUS_LABEL,
  rupiah,
  angka,
  tanggal,
  periodeLabel,
  statusKelas,
  todayISO,
  formatISO,
  terbilang,
  flashMiddleware,
  audit,
  auditLoginGagal,
  jsonAman,
};
