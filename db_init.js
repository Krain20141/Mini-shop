// db_init.js
require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');

const DB_FILE = process.env.DB_PATH || 'shop.db';
const db = new sqlite3.Database(DB_FILE);

db.serialize(() => {
  // --- Tables ---
  db.run(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      price REAL NOT NULL,
      image TEXT,
      inventory INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT,
      items_json TEXT,
      total_cents INTEGER,
      status TEXT DEFAULT 'pending',
      tracking_number TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // --- Safe add columns (no-op if they already exist) ---
  db.get(`SELECT 1 FROM pragma_table_info('orders') WHERE name='provider'`, (err, row) => {
    if (!row) db.run(`ALTER TABLE orders ADD COLUMN provider TEXT`);
  });
  db.get(`SELECT 1 FROM pragma_table_info('orders') WHERE name='provider_payment_id'`, (err, row) => {
    if (!row) db.run(`ALTER TABLE orders ADD COLUMN provider_payment_id TEXT`);
  });

  // --- Admin seed/reset from ENV (defaults: admin/admin123) ---
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  const hash = bcrypt.hashSync(password, 10);

  db.get(`SELECT id FROM admins WHERE username = ?`, [username], (err, row) => {
    if (err) {
      console.error('DB error:', err.message);
      return db.close();
    }
    if (row) {
      console.log(`⚠️ Admin "${username}" exists — resetting password...`);
      return db.run(
        `UPDATE admins SET password_hash = ? WHERE username = ?`,
        [hash, username],
        (e) => {
          if (e) console.error('Password reset error:', e.message);
          else console.log(`✅ Password reset: username=${username}, password=${password}`);
          db.close();
        }
      );
    }
    db.run(
      `INSERT INTO admins (username, password_hash) VALUES (?, ?)`,
      [username, hash],
      function (e) {
        if (e) console.error('Insert admin error:', e.message);
        else console.log(`✅ Admin created: username=${username}, password=${password}`);
        db.close();
      }
    );
  });
});
