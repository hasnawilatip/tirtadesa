'use strict';
const { db } = require('../src/db');
const rows = db.prepare(`
  SELECT d.nama AS desa, p.nama AS paket, p.maks_pelanggan, p.maks_sumur, p.maks_dusun,
    (SELECT COUNT(*) FROM pelanggan x WHERE x.desa_id = d.id AND x.status <> 'nonaktif') AS dipakai_pelanggan,
    (SELECT COUNT(*) FROM sumur s JOIN dusun du ON du.id = s.dusun_id WHERE du.desa_id = d.id) AS dipakai_sumur,
    (SELECT COUNT(*) FROM dusun du WHERE du.desa_id = d.id) AS dipakai_dusun
  FROM desa d LEFT JOIN paket p ON p.id = d.paket_id
  ORDER BY d.nama
`).all();
rows.forEach((r) => {
  const lewat = (pakai, batas) => (batas > 0 && pakai > batas ? '  ⚠ MELEBIHI' : '');
  console.log(`${r.desa} | ${r.paket} | pelanggan ${r.dipakai_pelanggan}/${r.maks_pelanggan || '∞'}${lewat(r.dipakai_pelanggan, r.maks_pelanggan)}`
    + ` | sumur ${r.dipakai_sumur}/${r.maks_sumur || '∞'}${lewat(r.dipakai_sumur, r.maks_sumur)}`
    + ` | dusun ${r.dipakai_dusun}/${r.maks_dusun || '∞'}${lewat(r.dipakai_dusun, r.maks_dusun)}`);
});
