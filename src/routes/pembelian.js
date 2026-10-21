'use strict';

/**
 * Pembelian bahan (pengadaan).
 * Alur: admin mencatat nota pembelian (draf) → barang diterima → stok gudang
 * bertambah dan mutasi tercatat (referensi nomor pembelian) → harga satuan
 * bahan diperbarui → total pembelian masuk laporan sebagai pengeluaran.
 */

const express = require('express');
const { db } = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { audit, todayISO } = require('../helpers');
const { nomorPembelianBaru } = require('../services/penomoran');

const router = express.Router();
router.use(requireAuth);

const PERAN_LIHAT = ['admin_desa', 'admin_dusun', 'kasir'];
const PERAN_KELOLA = ['admin_desa', 'admin_dusun'];
const METODE = { tunai: 'Tunai', transfer: 'Transfer', kredit: 'Kredit / tempo', lain: 'Lainnya' };
const STATUS = ['draf', 'diterima', 'dibatalkan'];

function daftarBahan(user) {
  return db.prepare(`SELECT * FROM bahan WHERE desa_id = ? ORDER BY
    CASE kategori WHEN 'pipa' THEN 1 WHEN 'fitting' THEN 2 WHEN 'meter' THEN 3
      WHEN 'aksesoris' THEN 4 WHEN 'alat' THEN 5 ELSE 6 END, nama`).all(user.desa_id);
}

function ambilPembelian(user, id) {
  return db.prepare(`SELECT p.*, du.nama AS dibuat_nama, dr.nama AS diterima_nama
    FROM pembelian p
    LEFT JOIN users du ON du.id = p.dibuat_oleh
    LEFT JOIN users dr ON dr.id = p.diterima_oleh
    WHERE p.id = ? AND p.desa_id = ?`).get(Number(id), user.desa_id);
}

function rincianPembelian(id) {
  return db.prepare('SELECT * FROM pembelian_item WHERE pembelian_id = ? ORDER BY id').all(id);
}

/** Baca baris item (bahan_id[], jumlah[], harga[]) dari form. */
function bacaItem(req, desaId) {
  const ke = (v) => (Array.isArray(v) ? v : (v == null ? [] : [v]));
  const ids = ke(req.body.bahan_id);
  const jumlah = ke(req.body.jumlah);
  const harga = ke(req.body.harga);
  const hasil = [];
  const cari = db.prepare('SELECT * FROM bahan WHERE id = ? AND desa_id = ?');
  ids.forEach((idMentah, i) => {
    const bahanId = Number(idMentah);
    if (!bahanId) return;
    const qty = Number(jumlah[i]) || 0;
    if (qty <= 0) return;
    const bahan = cari.get(bahanId, desaId);
    if (!bahan) return;
    const satuanHarga = Math.max(0, Number(harga[i]) || 0);
    hasil.push({
      bahan_id: bahan.id,
      nama_bahan: bahan.nama,
      satuan: bahan.satuan,
      jumlah: qty,
      harga_satuan: satuanHarga,
      subtotal: qty * satuanHarga,
    });
  });
  return hasil;
}

function simpanItem(pembelianId, items) {
  db.prepare('DELETE FROM pembelian_item WHERE pembelian_id = ?').run(pembelianId);
  const insert = db.prepare(`INSERT INTO pembelian_item
    (pembelian_id, bahan_id, nama_bahan, satuan, jumlah, harga_satuan, subtotal)
    VALUES (?,?,?,?,?,?,?)`);
  items.forEach((b) => insert.run(
    pembelianId, b.bahan_id, b.nama_bahan, b.satuan, b.jumlah, b.harga_satuan, b.subtotal
  ));
}

function totalItem(items) {
  return items.reduce((t, b) => t + b.subtotal, 0);
}

function dataHeader(req) {
  return {
    tanggal: String(req.body.tanggal || '').trim() || todayISO(),
    supplier: String(req.body.supplier || '').trim(),
    metode: METODE[req.body.metode] ? req.body.metode : 'tunai',
    catatan: String(req.body.catatan || '').trim(),
  };
}

function ringkasan(desaId) {
  const bulan = todayISO().slice(0, 7);
  const bulanIni = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS total
    FROM pembelian WHERE desa_id = ? AND status = 'diterima' AND substr(tanggal, 1, 7) = ?`)
    .get(desaId, bulan);
  const draf = db.prepare(`SELECT COUNT(*) AS n FROM pembelian WHERE desa_id = ? AND status = 'draf'`)
    .get(desaId).n;
  const supplier = db.prepare(`SELECT COUNT(DISTINCT supplier) AS n FROM pembelian
    WHERE desa_id = ? AND status = 'diterima' AND supplier IS NOT NULL AND supplier <> ''`)
    .get(desaId).n;
  const menipis = db.prepare(`SELECT COUNT(*) AS n FROM bahan
    WHERE desa_id = ? AND is_active = 1 AND stok <= stok_minimum`).get(desaId).n;
  return { bulanTotal: bulanIni.total, bulanNota: bulanIni.n, draf, supplier, menipis };
}

/** Saran jumlah beli untuk bahan yang stoknya menipis/habis. */
function saranBeli(bahan) {
  const minimum = Number(bahan.stok_minimum) || 0;
  const stok = Number(bahan.stok) || 0;
  const target = Math.max(minimum * 2, minimum + 1);
  return Math.max(1, Math.ceil(target - stok));
}

/** Prefill baris form dari ?bahan=<id> atau ?dari=menipis. */
function prefillItem(bahanList, query) {
  const items = [];
  const idBahan = Number(query.bahan);
  if (idBahan) {
    const bahan = bahanList.find((b) => b.id === idBahan);
    if (bahan) {
      items.push({
        bahan_id: bahan.id,
        jumlah: saranBeli(bahan),
        harga_satuan: Number(bahan.harga_satuan) || 0,
      });
    }
  } else if (query.dari === 'menipis') {
    bahanList
      .filter((b) => b.is_active && Number(b.stok) <= Number(b.stok_minimum))
      .forEach((b) => items.push({
        bahan_id: b.id,
        jumlah: saranBeli(b),
        harga_satuan: Number(b.harga_satuan) || 0,
      }));
  }
  return items;
}

// ---------------------------------------------------------------------------
// DAFTAR
// ---------------------------------------------------------------------------

router.get('/pembelian', requireRole(...PERAN_LIHAT), (req, res) => {
  const filters = {
    q: String(req.query.q || '').trim(),
    status: String(req.query.status || '').trim(),
    bulan: String(req.query.bulan || '').trim(),
  };
  const syarat = ['p.desa_id = ?'];
  const nilai = [req.user.desa_id];
  if (STATUS.includes(filters.status)) {
    syarat.push('p.status = ?');
    nilai.push(filters.status);
  }
  if (/^\d{4}-\d{2}$/.test(filters.bulan)) {
    syarat.push('substr(p.tanggal, 1, 7) = ?');
    nilai.push(filters.bulan);
  }
  if (filters.q) {
    syarat.push('(p.nomor LIKE ? OR p.supplier LIKE ? OR p.catatan LIKE ?)');
    nilai.push(`%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`);
  }
  const rows = db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM pembelian_item i WHERE i.pembelian_id = p.id) AS jumlah_item,
      (SELECT COALESCE(SUM(i.jumlah), 0) FROM pembelian_item i WHERE i.pembelian_id = p.id) AS total_qty
    FROM pembelian p
    WHERE ${syarat.join(' AND ')}
    ORDER BY p.tanggal DESC, p.id DESC
  `).all(...nilai);

  res.render('pembelian/index', {
    title: 'Pembelian Bahan',
    rows,
    filters,
    ringkas: ringkasan(req.user.desa_id),
    metodeLabel: METODE,
    bahanList: daftarBahan(req.user),
    items: prefillItem(daftarBahan(req.user), req.query),
    nomorOtomatis: nomorPembelianBaru(req.user.desa_id),
    bolehKelola: PERAN_KELOLA.includes(req.user.role),
  });
});

// ---------------------------------------------------------------------------
// FORM
// ---------------------------------------------------------------------------

router.get('/pembelian/baru', requireRole(...PERAN_KELOLA), (req, res) => {
  // Formulir tambah kini berupa popup di halaman daftar; teruskan prefill yang diminta.
  const params = new URLSearchParams({ buka: 'modalPembelian' });
  if (req.query.bahan) params.set('bahan', String(req.query.bahan));
  if (req.query.dari === 'menipis') params.set('dari', 'menipis');
  res.redirect(`/pembelian?${params.toString()}`);
});

router.post('/pembelian', requireRole(...PERAN_KELOLA), (req, res) => {
  const header = dataHeader(req);
  const items = bacaItem(req, req.user.desa_id);
  if (!items.length) {
    req.flash('error', 'Tambahkan minimal satu bahan yang dibeli.');
    return res.redirect('/pembelian?buka=modalPembelian');
  }
  const total = totalItem(items);
  const langsungTerima = req.body.aksi === 'terima';
  const nomor = nomorPembelianBaru(req.user.desa_id);

  try {
    const id = db.transaction(() => {
      const info = db.prepare(`INSERT INTO pembelian
        (desa_id, nomor, tanggal, supplier, metode, catatan, total, status, dibuat_oleh)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(
        req.user.desa_id, nomor, header.tanggal, header.supplier || null,
        header.metode, header.catatan || null, total,
        langsungTerima ? 'diterima' : 'draf', req.user.id
      );
      simpanItem(info.lastInsertRowid, items);
      if (langsungTerima) terimaStok(req, info.lastInsertRowid, nomor, items, header.supplier);
      return info.lastInsertRowid;
    })();
    audit(req, 'create', 'pembelian', id, `${nomor} — ${total}`);
    req.flash('success', langsungTerima
      ? `Pembelian ${nomor} diterima. Stok gudang bertambah dan pengeluaran tercatat.`
      : `Pembelian ${nomor} disimpan sebagai draf.`);
    res.redirect(`/pembelian/${id}`);
  } catch (err) {
    req.flash('error', `Gagal menyimpan pembelian: ${err.message}`);
    res.redirect('/pembelian?buka=modalPembelian');
  }
});

router.get('/pembelian/:id/edit', requireRole(...PERAN_KELOLA), (req, res) => {
  const row = ambilPembelian(req.user, req.params.id);
  if (!row) {
    req.flash('error', 'Pembelian tidak ditemukan.');
    return res.redirect('/pembelian');
  }
  if (row.status !== 'draf') {
    req.flash('error', 'Pembelian yang sudah diterima tidak dapat diubah.');
    return res.redirect(`/pembelian/${row.id}`);
  }
  res.render('pembelian/form', {
    title: `Ubah ${row.nomor}`,
    row,
    items: rincianPembelian(row.id),
    bahanList: daftarBahan(req.user),
    metodeLabel: METODE,
    nomorOtomatis: row.nomor,
  });
});

router.post('/pembelian/:id', requireRole(...PERAN_KELOLA), (req, res) => {
  const row = ambilPembelian(req.user, req.params.id);
  if (!row) {
    req.flash('error', 'Pembelian tidak ditemukan.');
    return res.redirect('/pembelian');
  }
  if (row.status !== 'draf') {
    req.flash('error', 'Pembelian yang sudah diterima tidak dapat diubah.');
    return res.redirect(`/pembelian/${row.id}`);
  }
  const header = dataHeader(req);
  const items = bacaItem(req, req.user.desa_id);
  if (!items.length) {
    req.flash('error', 'Tambahkan minimal satu bahan yang dibeli.');
    return res.redirect(`/pembelian/${row.id}/edit`);
  }
  const total = totalItem(items);
  const langsungTerima = req.body.aksi === 'terima';
  try {
    db.transaction(() => {
      db.prepare(`UPDATE pembelian SET tanggal = ?, supplier = ?, metode = ?, catatan = ?,
        total = ?, status = ? WHERE id = ?`).run(
        header.tanggal, header.supplier || null, header.metode, header.catatan || null,
        total, langsungTerima ? 'diterima' : 'draf', row.id
      );
      simpanItem(row.id, items);
      if (langsungTerima) terimaStok(req, row.id, row.nomor, items, header.supplier);
    })();
    audit(req, 'update', 'pembelian', row.id, `${row.nomor} — ${total}`);
    req.flash('success', langsungTerima
      ? `Pembelian ${row.nomor} diperbarui dan barang langsung diterima.`
      : `Pembelian ${row.nomor} diperbarui.`);
  } catch (err) {
    req.flash('error', `Gagal memperbarui pembelian: ${err.message}`);
  }
  res.redirect(`/pembelian/${row.id}`);
});

// ---------------------------------------------------------------------------
// DETAIL & AKSI
// ---------------------------------------------------------------------------

router.get('/pembelian/:id', requireRole(...PERAN_LIHAT), (req, res) => {
  const row = ambilPembelian(req.user, req.params.id);
  if (!row) {
    req.flash('error', 'Pembelian tidak ditemukan.');
    return res.redirect('/pembelian');
  }
  const items = rincianPembelian(row.id);
  const mutasi = db.prepare(`
    SELECT m.*, b.nama AS bahan_nama, b.satuan
    FROM bahan_mutasi m JOIN bahan b ON b.id = m.bahan_id
    WHERE m.referensi = ? ORDER BY m.id
  `).all(row.nomor);
  res.render('pembelian/detail', {
    title: `Pembelian ${row.nomor}`,
    row,
    items,
    mutasi,
    metodeLabel: METODE,
    bolehKelola: PERAN_KELOLA.includes(req.user.role),
    today: todayISO(),
  });
});

router.post('/pembelian/:id/terima', requireRole(...PERAN_KELOLA), (req, res) => {
  const row = ambilPembelian(req.user, req.params.id);
  if (!row) {
    req.flash('error', 'Pembelian tidak ditemukan.');
    return res.redirect('/pembelian');
  }
  if (row.status !== 'draf') {
    req.flash('error', 'Pembelian ini sudah diproses.');
    return res.redirect(`/pembelian/${row.id}`);
  }
  const items = rincianPembelian(row.id);
  if (!items.length) {
    req.flash('error', 'Pembelian belum memiliki rincian bahan.');
    return res.redirect(`/pembelian/${row.id}/edit`);
  }
  try {
    db.transaction(() => terimaStok(req, row.id, row.nomor, items, row.supplier))();
    audit(req, 'terima', 'pembelian', row.id, `${row.nomor} — ${row.total}`);
    req.flash('success', `Barang untuk ${row.nomor} diterima. Stok bertambah ${items.length} jenis bahan.`);
  } catch (err) {
    req.flash('error', `Gagal menerima barang: ${err.message}`);
  }
  res.redirect(`/pembelian/${row.id}`);
});

router.post('/pembelian/:id/batal', requireRole(...PERAN_KELOLA), (req, res) => {
  const row = ambilPembelian(req.user, req.params.id);
  if (!row) {
    req.flash('error', 'Pembelian tidak ditemukan.');
    return res.redirect('/pembelian');
  }
  if (row.status !== 'draf') {
    req.flash('error', 'Hanya pembelian berstatus draf yang bisa dibatalkan.');
    return res.redirect(`/pembelian/${row.id}`);
  }
  db.prepare("UPDATE pembelian SET status = 'dibatalkan' WHERE id = ?").run(row.id);
  audit(req, 'batal', 'pembelian', row.id, row.nomor);
  req.flash('success', `Pembelian ${row.nomor} dibatalkan.`);
  res.redirect(`/pembelian/${row.id}`);
});

router.post('/pembelian/:id/hapus', requireRole(...PERAN_KELOLA), (req, res) => {
  const row = ambilPembelian(req.user, req.params.id);
  if (!row) {
    req.flash('error', 'Pembelian tidak ditemukan.');
    return res.redirect('/pembelian');
  }
  if (row.status === 'diterima') {
    req.flash('error', 'Pembelian yang sudah diterima tidak bisa dihapus (stok sudah masuk).');
    return res.redirect(`/pembelian/${row.id}`);
  }
  db.transaction(() => {
    db.prepare('DELETE FROM pembelian_item WHERE pembelian_id = ?').run(row.id);
    db.prepare('DELETE FROM pembelian WHERE id = ?').run(row.id);
  })();
  audit(req, 'hapus', 'pembelian', row.id, row.nomor);
  req.flash('success', `Pembelian ${row.nomor} dihapus.`);
  res.redirect('/pembelian');
});

/**
 * Terima barang: stok bertambah, mutasi gudang tercatat, harga bahan diperbarui
 * ke harga pembelian terakhir, dan status pembelian menjadi 'diterima'.
 * Wajib dipanggil di dalam transaksi.
 */
function terimaStok(req, pembelianId, nomor, items, supplier) {
  items.forEach((b) => {
    const bahan = db.prepare('SELECT stok, harga_satuan FROM bahan WHERE id = ?').get(b.bahan_id);
    if (!bahan) return;
    const stokAkhir = Number(bahan.stok) + Number(b.jumlah);
    // Harga master mengikuti harga pembelian terakhir (bila diisi).
    const hargaBaru = Number(b.harga_satuan) > 0 ? Number(b.harga_satuan) : Number(bahan.harga_satuan);
    db.prepare('UPDATE bahan SET stok = ?, harga_satuan = ? WHERE id = ?')
      .run(stokAkhir, hargaBaru, b.bahan_id);
    db.prepare(`INSERT INTO bahan_mutasi
      (bahan_id, jenis, jumlah, stok_akhir, referensi, keterangan, user_id)
      VALUES (?,?,?,?,?,?,?)`).run(
      b.bahan_id, 'masuk', b.jumlah, stokAkhir, nomor,
      `Pembelian ${nomor}${supplier ? ` — ${supplier}` : ''}`, req.user.id
    );
  });
  db.prepare(`UPDATE pembelian SET status = 'diterima', diterima_oleh = ?,
    diterima_at = datetime('now','localtime') WHERE id = ?`).run(req.user.id, pembelianId);
}

module.exports = router;
module.exports.METODE = METODE;
module.exports.saranBeli = saranBeli;
