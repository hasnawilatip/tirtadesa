'use strict';

/**
 * Menghitung tagihan progresif berdasarkan golongan, pemakaian, dan tanggal terbit.
 * Blok 1 dimulai dari 0; blok berikutnya memakai batas bawah eksklusif.
 */
function pilihBlokAktif(db, golonganId, tanggal) {
  const rows = db.prepare(`
    SELECT * FROM tarif_blok
    WHERE golongan_id = ? AND berlaku_mulai <= ?
    ORDER BY blok_ke ASC, berlaku_mulai DESC
  `).all(golonganId, tanggal);

  const perBlok = new Map();
  for (const row of rows) {
    if (!perBlok.has(row.blok_ke)) perBlok.set(row.blok_ke, row);
  }
  return [...perBlok.values()].sort((a, b) => a.blok_ke - b.blok_ke);
}

function hitungTagihan(db, golonganId, pemakaian, tanggalTerbit) {
  const golongan = db.prepare('SELECT * FROM golongan_tarif WHERE id = ?').get(golonganId);
  if (!golongan) throw new Error('Golongan tarif tidak ditemukan.');

  const blok = pilihBlokAktif(db, golonganId, tanggalTerbit);
  const pemakaianAsli = Number(pemakaian) || 0;
  const qtyDitagih = Math.max(pemakaianAsli, Number(golongan.min_pemakaian_m3) || 0);

  const items = [{
    jenis: 'abonemen',
    keterangan: 'Abonemen bulanan',
    qty: 1,
    harga_satuan: Number(golongan.abonemen),
    subtotal: Number(golongan.abonemen),
    urutan: 1,
  }];

  let biayaPemakaian = 0;
  let urutan = 2;

  for (const b of blok) {
    const dari = Number(b.dari_m3);
    const sampai = b.sampai_m3 == null ? Infinity : Number(b.sampai_m3);
    const qty = Math.max(0, Math.min(qtyDitagih, sampai) - dari);
    if (qty <= 0) continue;

    const subtotal = qty * Number(b.harga_per_m3);
    biayaPemakaian += subtotal;
    const catatanMinimum = pemakaianAsli < qtyDitagih && urutan === 2 ? ', minimum' : '';
    items.push({
      jenis: 'pemakaian',
      keterangan: `Pemakaian blok ${b.blok_ke} (${qty} m³${catatanMinimum})`,
      qty,
      harga_satuan: Number(b.harga_per_m3),
      subtotal,
      urutan: urutan += 1,
    });
  }

  const total = Number(golongan.abonemen) + biayaPemakaian;
  return {
    golongan,
    pemakaianAsli,
    qtyDitagih,
    abonemen: Number(golongan.abonemen),
    biaya_pemakaian: Math.round(biayaPemakaian * 100) / 100,
    total: Math.round(total * 100) / 100,
    items,
  };
}

module.exports = { hitungTagihan, pilihBlokAktif };
