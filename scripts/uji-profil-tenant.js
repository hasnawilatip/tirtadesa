'use strict';

/**
 * Uji profil pengelola untuk tenant berjenis dusun mandiri.
 *
 * Skenario:
 * 1. Buat tenant sementara (desa + dusun + akun admin dusun).
 * 2. Login sebagai admin dusun tenant tersebut.
 * 3. Pastikan /profil-pengelola dan alias /profil-desa dapat dibuka.
 * 4. Simpan perubahan identitas dan pastikan tersimpan.
 * 5. Hapus seluruh data uji.
 *
 * Jalankan server lebih dulu, lalu:
 *   node scripts/uji-profil-tenant.js
 */

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const { db } = require('../src/db');
const { hashSandi } = require('../src/services/sandi');

let gagal = 0;
function hasil(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) gagal += 1;
}

function buatKlien() {
  let cookie = '';
  let token = '';
  let jalurToken = '/login';

  async function segarkanToken() {
    const headers = cookie ? { cookie } : {};
    const res = await fetch(`${BASE}${jalurToken}`, { headers, redirect: 'manual' });
    let daftar = [];
    if (typeof res.headers.getSetCookie === 'function') daftar = res.headers.getSetCookie();
    if (!daftar.length) {
      const satu = res.headers.get('set-cookie');
      if (satu) daftar = [satu];
    }
    if (daftar.length) cookie = daftar.map((c) => c.split(';')[0]).join('; ');
    const html = await res.text();
    const cocok = html.match(/<meta name="csrf-token" content="([^"]*)"/);
    token = cocok ? cocok[1] : '';
  }

  return {
    async ambil(path, opsi = {}) {
      const metode = String(opsi.method || 'GET').toUpperCase();
      if (metode !== 'GET' && !token) await segarkanToken();
      const headers = { ...(opsi.headers || {}) };
      if (cookie) headers.cookie = cookie;
      if (token && metode !== 'GET') headers['x-csrf-token'] = token;
      const res = await fetch(`${BASE}${path}`, { ...opsi, headers, redirect: 'manual' });

      let daftar = [];
      if (typeof res.headers.getSetCookie === 'function') daftar = res.headers.getSetCookie();
      if (!daftar.length) {
        const satu = res.headers.get('set-cookie');
        if (satu) daftar = [satu];
      }
      if (daftar.length) cookie = daftar.map((c) => c.split(';')[0]).join('; ');
      if (metode !== 'GET' && path === '/login' && res.status === 302) {
        token = '';
        jalurToken = '/';
      }
      return res;
    },
  };
}

async function login(jar, username, password) {
  const res = await jar.ambil('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password }).toString(),
  });
  return res.status === 302;
}

async function main() {
  try {
    await fetch(`${BASE}/login`);
  } catch (err) {
    console.error(`Server tidak dapat dihubungi di ${BASE}. Jalankan "npm start" lebih dulu.`);
    process.exit(1);
  }

  const cap = Date.now().toString().slice(-8);
  const username = `uji_profil_${cap}`;
  const sandi = 'UjiProfil12345';
  let desaId = null;
  let dusunId = null;
  let userId = null;

  try {
    const infoDesa = db.prepare(`INSERT INTO desa (nama, jenis, kecamatan, kabupaten, alamat, telepon)
      VALUES (?, 'dusun', 'Kecamatan Uji', 'Kabupaten Uji', 'Dusun Uji, Desa Uji', '0800000')`)
      .run(`Dusun Uji ${cap}`);
    desaId = Number(infoDesa.lastInsertRowid);

    const infoDusun = db.prepare('INSERT INTO dusun (desa_id, kode, nama) VALUES (?,?,?)')
      .run(desaId, `UJI${cap}`, `Dusun Uji ${cap}`);
    dusunId = Number(infoDusun.lastInsertRowid);

    const infoUser = db.prepare(`INSERT INTO users
      (desa_id, dusun_id, nama, username, password_hash, role, is_active, must_change_password)
      VALUES (?,?,?,?,?, 'admin_dusun', 1, 0)`)
      .run(desaId, dusunId, 'Admin Dusun Uji', username, hashSandi(sandi));
    userId = Number(infoUser.lastInsertRowid);

    const jar = buatKlien();
    hasil(await login(jar, username, sandi), 'Login admin dusun mandiri');

    const halaman = await jar.ambil('/profil-pengelola');
    const html = await halaman.text();
    hasil(halaman.status === 200 && html.includes('Profil Pengelola'),
      'GET /profil-pengelola untuk tenant dusun', `status ${halaman.status}`);
    hasil(html.includes('Ruang kerja dusun mandiri'), 'Jenis ruang kerja dusun ditampilkan');
    hasil(html.includes('>Profil Pengelola<') && html.includes('href="/profil-pengelola"'),
      'Menu sidebar menampilkan Profil Pengelola');

    const alias = await jar.ambil('/profil-desa');
    hasil(alias.status === 200, 'Alias /profil-desa tetap berfungsi', `status ${alias.status}`);

    const namaBaru = `Dusun Uji Baru ${cap}`;
    const simpan = await jar.ambil('/profil-pengelola', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        nama: namaBaru,
        pelaku_usaha: 'Kepala Dusun Uji',
        kecamatan: 'Kecamatan Uji',
        kabupaten: 'Kabupaten Uji',
        alamat: 'Dusun Uji Baru, Desa Uji',
        telepon: '081200000000',
      }).toString(),
    });
    hasil(simpan.status === 302, 'POST /profil-pengelola tersimpan', `status ${simpan.status}`);

    const row = db.prepare('SELECT nama, pelaku_usaha, jenis FROM desa WHERE id = ?').get(desaId);
    hasil(row.nama === namaBaru, 'Nama tenant diperbarui', row.nama);
    hasil(row.pelaku_usaha === 'Kepala Dusun Uji', 'Pelaku usaha/penanggung jawab tersimpan', row.pelaku_usaha);
    hasil(row.jenis === 'dusun', 'Jenis tenant tetap dusun', row.jenis);

    const dash = await jar.ambil('/');
    const htmlDash = await dash.text();
    hasil(dash.status === 200 && htmlDash.includes(namaBaru), 'Sidebar memakai nama pengelola baru');

    const menuSembunyi = await jar.ambil('/dusun');
    hasil(menuSembunyi.status === 403, 'Admin dusun tetap tidak boleh mengelola master dusun',
      `status ${menuSembunyi.status}`);
  } finally {
    // Hapus seluruh data tenant uji, termasuk data otomatis yang dibuat
    // aplikasi saat admin membuka dashboard (periode & bahan standar).
    const bersih = db.transaction(() => {
      if (userId) db.prepare('DELETE FROM audit_log WHERE user_id = ?').run(userId);
      if (desaId) {
        db.prepare('DELETE FROM users WHERE desa_id = ?').run(desaId);
        db.prepare(`DELETE FROM tarif_blok WHERE golongan_id IN
          (SELECT id FROM golongan_tarif WHERE desa_id = ?)`).run(desaId);
        db.prepare('DELETE FROM golongan_tarif WHERE desa_id = ?').run(desaId);
        db.prepare(`DELETE FROM bahan_mutasi WHERE bahan_id IN
          (SELECT id FROM bahan WHERE desa_id = ?)`).run(desaId);
        db.prepare('DELETE FROM bahan WHERE desa_id = ?').run(desaId);
        db.prepare('DELETE FROM periode_tagihan WHERE desa_id = ?').run(desaId);
      }
      if (dusunId) db.prepare('DELETE FROM dusun WHERE id = ?').run(dusunId);
      if (desaId) db.prepare('DELETE FROM desa WHERE id = ?').run(desaId);
    });
    try {
      bersih();
    } catch (err) {
      console.error('Gagal membersihkan data uji:', err.message);
    }
  }

  console.log(gagal ? `\n${gagal} pemeriksaan GAGAL.` : '\nSemua pemeriksaan profil tenant LULUS.');
  process.exit(gagal ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
