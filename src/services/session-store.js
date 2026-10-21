'use strict';

const session = require('express-session');
const { db } = require('../db');

/**
 * Session store berbasis SQLite (better-sqlite3).
 * Membuat sesi tetap hidup meski server di-restart — berbeda dengan MemoryStore.
 */
class SqliteSessionStore extends session.Store {
  constructor() {
    super();
    db.exec(`
      CREATE TABLE IF NOT EXISTS web_sessions (
        sid TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_web_sessions_expires ON web_sessions(expires_at);
    `);

    this.pembersih = setInterval(() => this.bersihkanKedaluwarsa(), 60 * 60 * 1000);
    if (this.pembersih.unref) this.pembersih.unref();
  }

  hitungKedaluwarsa(sess) {
    const expires = sess && sess.cookie && sess.cookie.expires;
    if (expires) return new Date(expires).getTime();
    const maxAge = sess && sess.cookie && sess.cookie.maxAge;
    if (maxAge) return Date.now() + maxAge;
    return Date.now() + 24 * 60 * 60 * 1000;
  }

  get(sid, cb) {
    try {
      const row = db.prepare('SELECT data, expires_at FROM web_sessions WHERE sid = ?').get(sid);
      if (!row) return cb(null, null);
      if (row.expires_at <= Date.now()) {
        db.prepare('DELETE FROM web_sessions WHERE sid = ?').run(sid);
        return cb(null, null);
      }
      return cb(null, JSON.parse(row.data));
    } catch (err) {
      return cb(err);
    }
  }

  set(sid, sess, cb) {
    try {
      db.prepare(`INSERT INTO web_sessions (sid, data, expires_at) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`)
        .run(sid, JSON.stringify(sess), this.hitungKedaluwarsa(sess));
      return cb && cb(null);
    } catch (err) {
      return cb && cb(err);
    }
  }

  destroy(sid, cb) {
    try {
      db.prepare('DELETE FROM web_sessions WHERE sid = ?').run(sid);
      return cb && cb(null);
    } catch (err) {
      return cb && cb(err);
    }
  }

  touch(sid, sess, cb) {
    return this.set(sid, sess, cb);
  }

  bersihkanKedaluwarsa() {
    try {
      db.prepare('DELETE FROM web_sessions WHERE expires_at <= ?').run(Date.now());
    } catch (err) {
      // abaikan — pembersihan akan dicoba lagi pada interval berikutnya
    }
  }
}

module.exports = SqliteSessionStore;
