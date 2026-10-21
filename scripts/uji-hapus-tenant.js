'use strict';
process.env.DB_PATH = 'G:\\aplikasi PDAM\\data\\uji-hapus.db';
const bcrypt = require('bcryptjs');
const { db, DB_PATH } = require('../src/db');
if (/pdam\.db$/i.test(DB_PATH)) { console.error('Tolak jalan di pdam.db'); process.exit(1); }

const BASE = 'http://localhost:3100';
const H = { 'content-type': 'application/x-www-form-urlencoded' };
const badan = (o) => new URLSearchParams(o).toString();

const { buatKlien: klien } = require('./klien-uji');

function siapkanTenantKosong(nama) {
  const desaId = db.prepare(`INSERT INTO desa (nama, kecamatan, kabupaten, alamat, status_langganan,
      langganan_mulai, langganan_sampai) VALUES (?, 'Kec Uji', 'Kab Uji', 'Alamat uji', 'aktif',
      date('now','localtime'), date('now','localtime','+30 day'))`).run(nama).lastInsertRowid;
  db.prepare("INSERT INTO dusun (desa_id, kode, nama) VALUES (?, 'H01', 'Dusun Hapus')").run(desaId);
  const hash = bcrypt.hashSync('hapus123', 10);
  const userId = db.prepare(`INSERT INTO users (desa_id, nama, username, password_hash, role, is_active)
    VALUES (?, 'Admin Hapus', 'adminhapus', ?, 'admin_desa', 1)`).run(desaId, hash).lastInsertRowid;
  db.prepare(`INSERT INTO audit_log (user_id, aksi, entitas, entitas_id, detail) VALUES (?, 'create', 'desa', ?, 'uji')`)
    .run(userId, desaId);
  return { desaId, userId };
}

(async () => {
  const superadmin = klien();
  if (!await superadmin.login('superadmin', 'superadmin123')) { console.error('login gagal'); process.exit(1); }

  // 1) Ruang kerja kosong bisa dihapus beserta akunnya.
  const kosong = siapkanTenantKosong('Ruang Kosong Uji');
  const res1 = await superadmin.ambil(`/superadmin/langganan/${kosong.desaId}/hapus`, { method: 'POST', headers: H });
  const sisaDesa = db.prepare('SELECT 1 FROM desa WHERE id = ?').get(kosong.desaId);
  const sisaUser = db.prepare('SELECT 1 FROM users WHERE id = ?').get(kosong.userId);
  const sisaDusun = db.prepare('SELECT 1 FROM dusun WHERE desa_id = ?').get(kosong.desaId);
  console.log(res1.status === 302 && !sisaDesa && !sisaUser && !sisaDusun
    ? 'PASS  Ruang kerja kosong + akun terhapus'
    : `FAIL  hapus kosong (desa=${!!sisaDesa} user=${!!sisaUser} dusun=${!!sisaDusun})`);

  // 2) Ruang kerja yang punya data operasional ditolak.
  const berisi = siapkanTenantKosong('Ruang Berisi Uji');
  const dusunId = db.prepare('SELECT id FROM dusun WHERE desa_id = ?').get(berisi.desaId).id;
  db.prepare(`INSERT INTO pelanggan (desa_id, dusun_id, golongan_id, nomor_pelanggan, nama, status, tanggal_daftar)
    VALUES (?, ?, 1, 'X-1', 'Pelanggan Uji', 'aktif', date('now','localtime'))`).run(berisi.desaId, dusunId);
  await superadmin.ambil(`/superadmin/langganan/${berisi.desaId}/hapus`, { method: 'POST', headers: H });
  const masihAda = db.prepare('SELECT 1 FROM desa WHERE id = ?').get(berisi.desaId);
  console.log(masihAda ? 'PASS  Ruang kerja berisi data ditolak dihapus' : 'FAIL  ruang berisi ikut terhapus');

  // Bersihkan sisa uji.
  const u = db.prepare('SELECT id FROM users WHERE desa_id = ?').all(berisi.desaId).map((x) => x.id);
  db.prepare('DELETE FROM pelanggan WHERE desa_id = ?').run(berisi.desaId);
  if (u.length) { db.prepare(`DELETE FROM audit_log WHERE user_id IN (${u.map(() => '?').join(',')})`).run(...u); }
  db.prepare('DELETE FROM users WHERE desa_id = ?').run(berisi.desaId);
  db.prepare('DELETE FROM dusun WHERE desa_id = ?').run(berisi.desaId);
  db.prepare('DELETE FROM desa WHERE id = ?').run(berisi.desaId);
})();
