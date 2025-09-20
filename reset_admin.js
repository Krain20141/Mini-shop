// reset_admin.js
require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');

const DB_FILE = process.env.DB_PATH || 'shop.db';
const db = new sqlite3.Database(DB_FILE);

// 👉 Change these to whatever you want:
const username = 'myadmin';
const password = 'My$trongPass123';

const hash = bcrypt.hashSync(password, 10);

db.serialize(() => {
  db.run(`DELETE FROM admins WHERE username = ?`, [username], function (err) {
    if (err) {
      console.error('Delete error:', err.message);
      return db.close();
    }
    db.run(
      `INSERT INTO admins (username, password_hash) VALUES (?, ?)`,
      [username, hash],
      function (err2) {
        if (err2) console.error('Insert error:', err2.message);
        else console.log(`✅ Admin reset: ${username} / ${password}`);
        db.close();
      }
    );
  });
});
