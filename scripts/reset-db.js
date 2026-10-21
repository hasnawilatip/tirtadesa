'use strict';

const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'data', 'pdam.db');
for (const f of [file, `${file}-wal`, `${file}-shm`]) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

const { db } = require('../src/db');
const total = db.prepare('SELECT COUNT(*) AS n FROM pelanggan').get().n;
console.log(`Database demo berhasil dibuat di ${file}`);
console.log(`Jumlah pelanggan contoh: ${total}`);
db.close();
