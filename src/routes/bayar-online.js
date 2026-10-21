'use strict';

/**
 * Pembayaran online.
 *
 * Bagian 1 — superadmin: mengatur saluran pembayaran (rekening, QRIS, link
 * gateway) yang dipakai seluruh portal warga, plus setelan aktif/nonaktif.
 * Bagian 2 — kasir/admin: memverifikasi permintaan pembayaran warga sehingga
 * menjadi kwitansi resmi.
 */

const express = require('express');
const { db } = require('../db');
const { requireRole, aksesSemuaDusun, dusunScope } = require('../auth');
const { audit } = require('../helpers');
const { simpanPengaturan } = require('../services/pengaturan');
const { buatUnggahan, hapusBerkas } = require('../services/unggah');
const csrf = require('../services/csrf');
const { catatPembayaran } = require('../services/pembayaran');
const layanan = require('../services/bayar-online');

const router = express.Router();

const unggahGambar = buatUnggahan({
  folder: 'bayar',
  prefix: 'qr',
  tipe: ['image/png', 'image/jpeg', 'image/webp'],
  pesan: 'Gambar harus PNG, JPG, atau WebP (maks. 2 MB).',
});

function unggahGambarAman(req, res, next) {
  unggahGambar.single('gambar')(req, res, (err) => {
    if (err) {
      req.flash('error', err.message || 'Gagal mengunggah gambar.');
      return res.redirect('/superadmin/pembayaran');
    }
    return unggahGambar.validasi(req, res, (err2) => {
      if (err2) {
        req.flash('error', err2.message || 'Isi berkas gambar tidak valid.');
        return res.redirect('/superadmin/pembayaran');
      }
      return next();
    });
  });
}

function angkaAtau(nilai, cadangan = 0) {
  const n = Number(nilai);
  return Number.isFinite(n) ? n : cadangan;
}

function rapikanSaluran(body, berkas) {
  const jenis = ['transfer', 'qris', 'link'].includes(body.jenis) ? body.jenis : 'transfer';
  // Checkbox diikuti input hidden bernilai 0, jadi nilai terakhir yang dipakai.
  const aktifMentah = Array.isArray(body.is_active)
    ? body.is_active[body.is_active.length - 1]
    : body.is_active;
  return {
    nama: String(body.nama || '').trim(),
    jenis,
    penyedia: String(body.penyedia || '').trim() || null,
    nomor_tujuan: String(body.nomor_tujuan || '').trim() || null,
    atas_nama: String(body.atas_nama || '').trim() || null,
    url_bayar: String(body.url_bayar || '').trim() || null,
    instruksi: String(body.instruksi || '').trim() || null,
    urutan: Math.round(angkaAtau(body.urutan, 1)) || 1,
    is_active: String(aktifMentah || '') === '1' ? 1 : 0,
    gambar_path: berkas ? `/uploads/bayar/${berkas.filename}` : undefined,
  };
}

function validasiSaluran(data) {
  if (!data.nama) return 'Nama saluran pembayaran wajib diisi.';
  if (data.jenis === 'transfer' && !data.nomor_tujuan) {
    return 'Nomor rekening wajib diisi untuk saluran transfer bank.';
  }
  if (data.jenis === 'link' && !/^https?:\/\/.+/i.test(String(data.url_bayar || ''))) {
    return 'URL pembayaran harus diawali http:// atau https://.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// SUPERADMIN — SALURAN PEMBAYARAN
// ---------------------------------------------------------------------------

router.get('/superadmin/pembayaran', requireRole('superadmin'), (req, res) => {
  const saluran = layanan.daftarSaluran({ semua: true });
  const transaksi = db.prepare(`
    SELECT o.*, t.nomor_tagihan, t.total, t.terbayar, p.nama AS pelanggan, p.nomor_pelanggan,
           d.nama AS desa, sb.nama AS saluran
    FROM pembayaran_online o
    JOIN tagihan t ON t.id = o.tagihan_id
    JOIN pelanggan p ON p.id = o.pelanggan_id
    JOIN desa d ON d.id = o.desa_id
    LEFT JOIN saluran_bayar sb ON sb.id = o.saluran_id
    ORDER BY CASE o.status WHEN 'menunggu' THEN 0 ELSE 1 END, o.id DESC
    LIMIT 60
  `).all();

  res.render('superadmin/pembayaran', {
    title: 'Pembayaran Online',
    saluran,
    transaksi,
    setelan: layanan.infoBayar(),
    ringkas: layanan.ringkas(),
    jenisLabel: layanan.JENIS_SALURAN,
    statusLabel: layanan.STATUS_ONLINE,
  });
});

router.post('/superadmin/pembayaran/setelan', requireRole('superadmin'), (req, res) => {
  const data = { bayar_online_info: String(req.body.bayar_online_info || '').trim() || null };
  // Status hanya diubah bila formulir memang mengirimkannya.
  if (req.body.bayar_online_aktif !== undefined) {
    data.bayar_online_aktif = String(req.body.bayar_online_aktif) === '1' ? 1 : 0;
  }
  simpanPengaturan(data);
  audit(req, 'update', 'pengaturan', 1, 'Setelan pembayaran online diperbarui');
  req.flash('success', 'Setelan pembayaran online disimpan.');
  res.redirect('/superadmin/pembayaran');
});

router.post('/superadmin/pembayaran/saluran', requireRole('superadmin'), unggahGambarAman, csrf.setelahUnggah, (req, res) => {
  const data = rapikanSaluran(req.body, req.file);
  const salah = validasiSaluran(data);
  if (salah) {
    if (req.file) hapusBerkas(`/uploads/bayar/${req.file.filename}`);
    req.flash('error', salah);
    return res.redirect('/superadmin/pembayaran');
  }

  const info = db.prepare(`INSERT INTO saluran_bayar
    (nama, jenis, penyedia, nomor_tujuan, atas_nama, gambar_path, url_bayar, instruksi, urutan, is_active)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    data.nama, data.jenis, data.penyedia, data.nomor_tujuan, data.atas_nama,
    data.gambar_path || null, data.url_bayar, data.instruksi, data.urutan, data.is_active
  );
  audit(req, 'create', 'saluran_bayar', info.lastInsertRowid, `${data.jenis}: ${data.nama}`);
  req.flash('success', `Saluran pembayaran “${data.nama}” ditambahkan.`);
  res.redirect('/superadmin/pembayaran');
});

router.post('/superadmin/pembayaran/saluran/:id', requireRole('superadmin'), unggahGambarAman, csrf.setelahUnggah, (req, res) => {
  const lama = layanan.saluranById(req.params.id);
  if (!lama) {
    if (req.file) hapusBerkas(`/uploads/bayar/${req.file.filename}`);
    req.flash('error', 'Saluran pembayaran tidak ditemukan.');
    return res.redirect('/superadmin/pembayaran');
  }

  const data = rapikanSaluran(req.body, req.file);
  const salah = validasiSaluran(data);
  if (salah) {
    if (req.file) hapusBerkas(`/uploads/bayar/${req.file.filename}`);
    req.flash('error', salah);
    return res.redirect('/superadmin/pembayaran');
  }

  const gambar = data.gambar_path !== undefined ? data.gambar_path : lama.gambar_path;
  if (req.file && lama.gambar_path) hapusBerkas(lama.gambar_path);

  db.prepare(`UPDATE saluran_bayar SET nama=?, jenis=?, penyedia=?, nomor_tujuan=?, atas_nama=?,
      gambar_path=?, url_bayar=?, instruksi=?, urutan=?, is_active=? WHERE id=?`).run(
    data.nama, data.jenis, data.penyedia, data.nomor_tujuan, data.atas_nama,
    gambar || null, data.url_bayar, data.instruksi, data.urutan, data.is_active, lama.id
  );
  audit(req, 'update', 'saluran_bayar', lama.id, `${data.jenis}: ${data.nama}`);
  req.flash('success', `Saluran pembayaran “${data.nama}” diperbarui.`);
  res.redirect('/superadmin/pembayaran');
});

router.post('/superadmin/pembayaran/saluran/:id/toggle', requireRole('superadmin'), (req, res) => {
  const row = layanan.saluranById(req.params.id);
  if (!row) {
    req.flash('error', 'Saluran pembayaran tidak ditemukan.');
    return res.redirect('/superadmin/pembayaran');
  }
  const baru = row.is_active ? 0 : 1;
  db.prepare('UPDATE saluran_bayar SET is_active = ? WHERE id = ?').run(baru, row.id);
  audit(req, 'update', 'saluran_bayar', row.id, baru ? 'Aktifkan saluran' : 'Nonaktifkan saluran');
  req.flash('success', `Saluran “${row.nama}” ${baru ? 'diaktifkan' : 'dinonaktifkan'}.`);
  res.redirect('/superadmin/pembayaran');
});

router.post('/superadmin/pembayaran/saluran/:id/hapus', requireRole('superadmin'), (req, res) => {
  const row = layanan.saluranById(req.params.id);
  if (!row) {
    req.flash('error', 'Saluran pembayaran tidak ditemukan.');
    return res.redirect('/superadmin/pembayaran');
  }
  const dipakai = db.prepare('SELECT COUNT(*) AS n FROM pembayaran_online WHERE saluran_id = ?').get(row.id).n;
  if (dipakai > 0) {
    db.prepare('UPDATE saluran_bayar SET is_active = 0 WHERE id = ?').run(row.id);
    req.flash('error', 'Saluran sudah dipakai transaksi, jadi hanya dinonaktifkan agar riwayat tetap utuh.');
    return res.redirect('/superadmin/pembayaran');
  }
  db.prepare('DELETE FROM saluran_bayar WHERE id = ?').run(row.id);
  if (row.gambar_path) hapusBerkas(row.gambar_path);
  audit(req, 'delete', 'saluran_bayar', row.id, row.nama);
  req.flash('success', `Saluran “${row.nama}” dihapus.`);
  res.redirect('/superadmin/pembayaran');
});

// ---------------------------------------------------------------------------
// KASIR / ADMIN — VERIFIKASI PEMBAYARAN WARGA
// ---------------------------------------------------------------------------

function bolehKelola(user) {
  return ['kasir', 'admin_desa', 'admin_dusun'].includes(user.role);
}

function ambilPermintaan(user, id) {
  const row = db.prepare(`
    SELECT o.*, t.nomor_tagihan, t.total, t.terbayar, t.status AS status_tagihan,
           t.dusun_id, p.nama AS pelanggan, p.nomor_pelanggan, sb.nama AS saluran, sb.jenis AS jenis_saluran
    FROM pembayaran_online o
    JOIN tagihan t ON t.id = o.tagihan_id
    JOIN pelanggan p ON p.id = o.pelanggan_id
    LEFT JOIN saluran_bayar sb ON sb.id = o.saluran_id
    WHERE o.id = ?
  `).get(Number(id));
  if (!row) return null;
  if (Number(row.desa_id) !== Number(user.desa_id)) return null;
  const scope = dusunScope(user);
  if (scope != null && Number(row.dusun_id) !== Number(scope)) return null;
  return row;
}

router.get('/pembayaran-online', requireRole('kasir', 'admin_desa', 'admin_dusun'), (req, res) => {
  const scope = dusunScope(req.user);
  const status = ['menunggu', 'dikonfirmasi', 'ditolak'].includes(req.query.status)
    ? req.query.status
    : 'menunggu';

  let where = 'WHERE o.desa_id = ?';
  const params = [req.user.desa_id];
  if (status !== 'semua') { where += ' AND o.status = ?'; params.push(status); }
  if (scope != null) { where += ' AND o.dusun_id = ?'; params.push(scope); }

  const rows = db.prepare(`
    SELECT o.*, t.nomor_tagihan, t.total, t.terbayar, t.jatuh_tempo,
           per.tahun, per.bulan, p.nama AS pelanggan, p.nomor_pelanggan,
           dus.nama AS dusun, sb.nama AS saluran, sb.jenis AS jenis_saluran
    FROM pembayaran_online o
    JOIN tagihan t ON t.id = o.tagihan_id
    JOIN periode_tagihan per ON per.id = t.periode_id
    JOIN pelanggan p ON p.id = o.pelanggan_id
    JOIN dusun dus ON dus.id = o.dusun_id
    LEFT JOIN saluran_bayar sb ON sb.id = o.saluran_id
    ${where}
    ORDER BY o.id DESC
    LIMIT 200
  `).all(...params);

  res.render('bayar-online/index', {
    title: 'Pembayaran Online',
    rows,
    status,
    ringkas: layanan.ringkas({ desaId: req.user.desa_id, dusunId: scope }),
    statusLabel: layanan.STATUS_ONLINE,
    jenisLabel: layanan.JENIS_SALURAN,
    bolehKelola: bolehKelola(req.user),
  });
});

router.post('/pembayaran-online/:id/verifikasi', requireRole('kasir', 'admin_desa', 'admin_dusun'), (req, res) => {
  const row = ambilPermintaan(req.user, req.params.id);
  if (!row) {
    req.flash('error', 'Permintaan pembayaran tidak ditemukan.');
    return res.redirect('/pembayaran-online');
  }
  if (row.status === 'dikonfirmasi') {
    req.flash('error', 'Permintaan ini sudah diverifikasi.');
    return res.redirect('/pembayaran-online');
  }
  if (row.status_tagihan === 'batal') {
    req.flash('error', 'Tagihan sudah dibatalkan, pembayaran tidak dapat diverifikasi.');
    return res.redirect('/pembayaran-online');
  }

  const sisa = Math.round((row.total - row.terbayar) * 100) / 100;
  const jumlah = Math.round((Number(req.body.jumlah) || row.jumlah || 0) * 100) / 100;
  if (jumlah <= 0) {
    req.flash('error', 'Jumlah verifikasi harus lebih dari nol.');
    return res.redirect('/pembayaran-online');
  }
  if (jumlah > sisa + 0.005) {
    req.flash('error', `Jumlah verifikasi melebihi sisa tagihan (${sisa}).`);
    return res.redirect('/pembayaran-online');
  }

  try {
    const pembayaranId = db.transaction(() => {
      const tagihan = db.prepare('SELECT * FROM tagihan WHERE id = ?').get(row.tagihan_id);
      const id = catatPembayaran({
        tagihan,
        jumlah,
        metode: layanan.METODE_DARI_JENIS[row.jenis_saluran] || 'transfer',
        tanggal: String(req.body.tanggal_bayar || '').trim() || undefined,
        userId: req.user.id,
        catatan: `Pembayaran online ${row.kode}${row.saluran ? ` · ${row.saluran}` : ''}`,
      });
      db.prepare(`UPDATE pembayaran_online
        SET status = 'dikonfirmasi', pembayaran_id = ?, diproses_oleh = ?, catatan_admin = ?,
            diproses_pada = datetime('now','localtime'), updated_at = datetime('now','localtime')
        WHERE id = ?`).run(
        id, req.user.id, String(req.body.catatan_admin || '').trim() || null, row.id
      );
      return id;
    })();

    audit(req, 'update', 'pembayaran_online', row.id, `Verifikasi ${row.kode} → kwitansi #${pembayaranId}`);
    req.flash('success', `Pembayaran ${row.kode} diverifikasi. Kwitansi siap dicetak.`);
    return res.redirect(`/kwitansi/${pembayaranId}`);
  } catch (err) {
    req.flash('error', `Gagal memverifikasi pembayaran: ${err.message}`);
    return res.redirect('/pembayaran-online');
  }
});

router.post('/pembayaran-online/:id/tolak', requireRole('kasir', 'admin_desa', 'admin_dusun'), (req, res) => {
  const row = ambilPermintaan(req.user, req.params.id);
  if (!row) {
    req.flash('error', 'Permintaan pembayaran tidak ditemukan.');
    return res.redirect('/pembayaran-online');
  }
  if (row.status !== 'menunggu') {
    req.flash('error', 'Hanya permintaan yang menunggu verifikasi yang bisa ditolak.');
    return res.redirect('/pembayaran-online');
  }

  const alasan = String(req.body.catatan_admin || '').trim() || 'Bukti pembayaran tidak sesuai';
  db.prepare(`UPDATE pembayaran_online
    SET status = 'ditolak', diproses_oleh = ?, catatan_admin = ?,
        diproses_pada = datetime('now','localtime'), updated_at = datetime('now','localtime')
    WHERE id = ?`).run(req.user.id, alasan, row.id);
  audit(req, 'update', 'pembayaran_online', row.id, `Tolak ${row.kode}: ${alasan}`);
  req.flash('success', `Permintaan ${row.kode} ditolak. Warga dapat mengirim ulang bukti.`);
  res.redirect('/pembayaran-online');
});

module.exports = router;
