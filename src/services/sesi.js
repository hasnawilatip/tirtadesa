'use strict';

const { db } = require('../db');

/**
 * Hapus sesi milik satu pengguna (mis. setelah kata sandi direset).
 * @param {number} userId
 * @param {string|null} kecualiSid sid yang dipertahankan (sesi saat ini)
 * @returns {number} jumlah sesi dihapus
 */
function hapusSesiPengguna(userId, kecualiSid = null) {
  const target = Number(userId);
  if (!target) return 0;
  const rows = db.prepare('SELECT sid, data FROM web_sessions').all();
  const hapus = db.prepare('DELETE FROM web_sessions WHERE sid = ?');
  let jumlah = 0;
  for (const row of rows) {
    if (kecualiSid && row.sid === kecualiSid) continue;
    try {
      const data = JSON.parse(row.data);
      if (Number(data.userId) === target) {
        hapus.run(row.sid);
        jumlah += 1;
      }
    } catch (err) {
      // data sesi rusak — biarkan pembersih berkala menghapusnya
    }
  }
  return jumlah;
}

module.exports = { hapusSesiPengguna };
