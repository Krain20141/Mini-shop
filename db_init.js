// db_init.js
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const db = new sqlite3.Database('shop.db');

// Create tables that server.js expects
db.serialize(() => {
  // Admins (used by /api/admin/login)
  db.run(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Products (used all over)
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

  // Orders (used by checkout + webhook)
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

  // Seed default admin (admin / admin123)
  const username = 'admin';
  const password = 'admin123';
  const hash = bcrypt.hashSync(password, 10);

  db.get(`SELECT id FROM admins WHERE username = ?`, [username], (err, row) => {
    if (err) {
      console.error('DB error:', err.message);
      return db.close();
    }
    if (row) {
      console.log('ℹ️ Admin already exists (username=admin).');
      return db.close();
    }
    db.run(
      `INSERT INTO admins (username, password_hash) VALUES (?, ?)`,
      [username, hash],
      function (e) {
        if (e) console.error('Insert admin error:', e.message);
        else console.log('✅ Admin created: username=admin, password=admin123');
        db.close();
      }
    );
  });
});
