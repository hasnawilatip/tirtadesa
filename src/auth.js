'use strict';

const { db } = require('./db');

const ROLE_LABEL = {
  superadmin: 'Superadmin',
  admin_desa: 'Admin Desa',
  admin_dusun: 'Admin Dusun',
  petugas_catat: 'Petugas Catat',
  kasir: 'Kasir',
  warga: 'Warga',
};

function attachUser(req, res, next) {
  const userId = req.session.userId;
  if (userId) {
    const user = db.prepare(`
      SELECT u.*, d.nama AS dusun_nama, d.kode AS dusun_kode
      FROM users u LEFT JOIN dusun d ON d.id = u.dusun_id
      WHERE u.id = ? AND u.is_active = 1
    `).get(userId);
    if (user) req.user = user;
    else delete req.session.userId;
  }
  res.locals.user = req.user || null;
  res.locals.roleLabel = ROLE_LABEL;
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.redirect('/login');
  return next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/login');
    if (!roles.includes(req.user.role)) {
      return res.status(403).render('error', {
        title: 'Akses ditolak',
        message: 'Anda tidak memiliki hak akses untuk halaman ini.',
      });
    }
    return next();
  };
}

function aksesSemuaDusun(user) {
  return user && (user.role === 'admin_desa' || user.role === 'superadmin');
}

/** null = semua dusun, selain itu id dusun pengguna. */
function dusunScope(user) {
  return aksesSemuaDusun(user) ? null : user.dusun_id;
}

/** Id desa (tenant) milik pengguna. */
function desaId(user) {
  return user ? user.desa_id : null;
}

/**
 * Label peran yang menyesuaikan jenis ruang kerja (tenant).
 * Peran tersimpan tetap admin_desa/admin_dusun, tetapi pada tenant usaha atau
 * dusun mandiri labelnya dibaca sesuai konteks (mis. "Admin Usaha").
 */
function labelPeran(user, desa) {
  if (!user) return '';
  if (user.role === 'admin_desa') {
    if (desa && desa.jenis === 'individu') return 'Admin Usaha';
    if (desa && desa.jenis === 'dusun') return 'Admin Dusun';
  }
  return ROLE_LABEL[user.role] || user.role;
}

/**
 * Cek hak kelola dusun sekaligus memastikan dusun berada di desa (tenant) pengguna.
 * Ini yang mencegah admin sebuah pengelola menyentuh data pengelola lain.
 */
function bolehKelolaDusun(user, dusunId) {
  if (!user || !dusunId) return false;
  const dusun = db.prepare('SELECT desa_id FROM dusun WHERE id = ?').get(Number(dusunId));
  if (!dusun || Number(dusun.desa_id) !== Number(user.desa_id)) return false;
  if (aksesSemuaDusun(user)) return true;
  return Number(user.dusun_id) === Number(dusunId);
}

module.exports = {
  ROLE_LABEL,
  labelPeran,
  attachUser,
  requireAuth,
  requireRole,
  aksesSemuaDusun,
  dusunScope,
  desaId,
  bolehKelolaDusun,
};
