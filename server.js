// server.js
require('dotenv').config();

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const Stripe = require('stripe');
const cors = require('cors');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const PORT = process.env.PORT || 3000;

// --- DB (SQLite file)
const DB_FILE = path.resolve(__dirname, 'shop.db');
const db = new sqlite3.Database(DB_FILE);

/* ===========================
   Stripe webhook (MUST be before JSON parsers)
   =========================== */
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const sessionObj = event.data.object;
    const orderId = sessionObj?.metadata?.order_id;
    console.log('✅ Checkout completed for order', orderId);

    if (orderId) {
      // Decrement inventory based on order items, then mark as paid
      db.get('SELECT items_json FROM orders WHERE id = ?', [orderId], (err, row) => {
        if (err || !row) {
          console.error('Order not found for inventory update', err);
          return;
        }

        let items = [];
        try { items = JSON.parse(row.items_json || '[]'); } catch {}

        items.forEach(it => {
          const qty = Number(it.quantity) || 0;
          db.run(
            'UPDATE products SET inventory = MAX(inventory - ?, 0) WHERE id = ?',
            [qty, it.id],
            e => { if (e) console.error('Inventory update error for product', it.id, e.message); }
          );
        });

        db.run('UPDATE orders SET status = ? WHERE id = ?', ['paid', orderId], err2 => {
          if (err2) console.error('DB update error', err2);
        });
      });
    }
  }

  res.json({ received: true });
});

/* ===========================
   Middlewares
   =========================== */
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Sessions (httpOnly cookie; secure=false for local HTTP)
app.use(session({
  secret: process.env.SESSION_SECRET || 'changeme',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,          // set true behind HTTPS/proxy in production
    httpOnly: true,
    sameSite: 'lax'
  }
}));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Serve uploaded images statically
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
app.use('/uploads', express.static(uploadDir));

// Image upload via multer -> saves in /uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) =>
    cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g, '_'))
});
const upload = multer({ storage });

/* ===========================
   Helpers
   =========================== */
function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

/* ===========================
   Admin auth
   =========================== */
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });

  db.get('SELECT id, username, password_hash FROM admins WHERE username = ?', [username], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(401).json({ error: 'Invalid credentials' });

    bcrypt.compare(password, row.password_hash, (err2, ok) => {
      if (err2) return res.status(500).json({ error: 'bcrypt error' });
      if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
      req.session.admin = { id: row.id, username: row.username };
      res.json({ ok: true });
    });
  });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/admin/me', (req, res) => {
  if (req.session && req.session.admin) return res.json({ admin: req.session.admin });
  res.status(401).json({ admin: null });
});

/* ===========================
   Products
   =========================== */
// GET /api/products
app.get('/api/products', (req, res) => {
  db.all('SELECT id, title, description, price, image, inventory FROM products', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// POST /api/products  (admin only) + image upload
app.post('/api/products', requireAdmin, upload.single('image'), (req, res) => {
  const { title, description, price, inventory } = req.body || {};
  const priceNum = Number(price);
  const invNum = Number.isFinite(Number(inventory)) ? Number(inventory) : 0;
  if (!title || !Number.isFinite(priceNum)) {
    return res.status(400).json({ error: 'Title and valid price are required' });
  }
  const imagePath = req.file ? '/uploads/' + path.basename(req.file.path) : null;

  const stmt = db.prepare(
    'INSERT INTO products (title, description, price, image, inventory) VALUES (?,?,?,?,?)'
  );
  stmt.run(title, description || '', priceNum, imagePath, invNum, function (err2) {
    if (err2) return res.status(500).json({ error: err2.message });
    res.json({ id: this.lastID });
  });
});

// PUT /api/products/:id (admin)
app.put('/api/products/:id', requireAdmin, upload.single('image'), (req, res) => {
  const id = req.params.id;
  const { title, description, price, inventory } = req.body || {};
  let imagePath = null;
  if (req.file) imagePath = '/uploads/' + path.basename(req.file.path);

  const fields = [];
  const vals = [];

  if (title !== undefined) { fields.push('title = ?'); vals.push(title); }
  if (description !== undefined) { fields.push('description = ?'); vals.push(description); }

  if (price !== undefined) {
    const p = Number(price);
    if (!Number.isFinite(p)) return res.status(400).json({ error: 'Invalid price' });
    fields.push('price = ?'); vals.push(p);
  }

  if (inventory !== undefined) {
    const q = Number(inventory);
    if (!Number.isFinite(q)) return res.status(400).json({ error: 'Invalid inventory' });
    fields.push('inventory = ?'); vals.push(q);
  }

  if (imagePath) { fields.push('image = ?'); vals.push(imagePath); }
  if (fields.length === 0) return res.status(400).json({ error: 'Nothing to update' });

  vals.push(id);
  const sql = `UPDATE products SET ${fields.join(', ')} WHERE id = ?`;
  db.run(sql, vals, function (err2) {
    if (err2) return res.status(500).json({ error: err2.message });
    res.json({ changed: this.changes });
  });
});

// DELETE /api/products/:id (admin)
app.delete('/api/products/:id', requireAdmin, (req, res) => {
  const id = req.params.id;
  db.run('DELETE FROM products WHERE id = ?', [id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ deleted: this.changes });
  });
});

/* ===========================
   Multi-provider Checkout (Task 2)
   =========================== */
// POST /api/checkout  { items:[{id,quantity}], customer_email, provider }
app.post('/api/checkout', async (req, res) => {
  try {
    const { items, customer_email, provider = 'stripe' } = req.body || {};
    if (!items || !items.length) return res.status(400).json({ error: 'No items' });

    // Load products (trust server price)
    const placeholders = items.map(() => '?').join(',');
    const ids = items.map(it => it.id);
    const rows = await new Promise((resolve, reject) => {
      db.all(
        `SELECT id, title, price FROM products WHERE id IN (${placeholders})`,
        ids,
        (err, rows2) => (err ? reject(err) : resolve(rows2))
      );
    });

    // Normalize items
    const line_items = items.map(it => {
      const prod = rows.find(r => String(r.id) === String(it.id));
      if (!prod) throw new Error('Product not found: ' + it.id);
      return {
        name: prod.title,
        unit_amount_cents: Math.round(Number(prod.price) * 100),
        quantity: Number(it.quantity) || 1
      };
    });

    const total_cents = line_items.reduce((s, i) => s + i.unit_amount_cents * i.quantity, 0);

    // Create local "pending" order
    const orderId = await new Promise((resolve, reject) => {
      const stmt = db.prepare(
        'INSERT INTO orders (email, items_json, total_cents, status) VALUES (?,?,?,?)'
      );
      stmt.run(customer_email || null, JSON.stringify(items), total_cents, 'pending', function (err2) {
        if (err2) reject(err2); else resolve(this.lastID);
      });
    });

    // Route by provider
    let redirectUrl = null;

    switch (provider) {
      case 'stripe': {
        const stripeLineItems = line_items.map(li => ({
          price_data: {
            currency: 'usd',
            product_data: { name: li.name },
            unit_amount: li.unit_amount_cents
          },
          quantity: li.quantity
        }));

        const sessionObj = await stripe.checkout.sessions.create({
          payment_method_types: ['card'],
          mode: 'payment',
          line_items: stripeLineItems,
          success_url: `${req.protocol}://${req.get('host')}/success.html?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${req.protocol}://${req.get('host')}/cancel.html`,
          metadata: { order_id: orderId }
        });

        redirectUrl = sessionObj.url;
        break;
      }

      case 'adyen':
        return res.status(501).json({ error: 'Adyen integration stub. Configure API call and return redirect URL.' });

      case 'payone':
        return res.status(501).json({ error: 'Payone integration stub. Configure API call and return redirect URL.' });

      case 'paysafe':
        return res.status(501).json({ error: 'Paysafe integration stub. Configure API call and return redirect URL.' });

      case 'computop':
        return res.status(501).json({ error: 'Computop integration stub. Configure API call and return redirect URL.' });

      case 'paymenttree':
        return res.status(501).json({ error: 'Paymenttree integration stub. Configure API call and return redirect URL.' });

      default:
        return res.status(400).json({ error: 'Unsupported provider' });
    }

    return res.json({ url: redirectUrl });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

/* ===========================
   Legacy Stripe-only Checkout (kept for compatibility)
   =========================== */
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { items, customer_email } = req.body || {};
    if (!items || !items.length) return res.status(400).json({ error: 'No items' });

    const placeholders = items.map(() => '?').join(',');
    const ids = items.map(it => it.id);
    const rows = await new Promise((resolve, reject) => {
      db.all(
        `SELECT id, title, price FROM products WHERE id IN (${placeholders})`,
        ids,
        (err, rows2) => (err ? reject(err) : resolve(rows2))
      );
    });

    const line_items = items.map(it => {
      const prod = rows.find(r => String(r.id) === String(it.id));
      if (!prod) throw new Error('Product not found: ' + it.id);
      return {
        price_data: {
          currency: 'usd',
          product_data: { name: prod.title },
          unit_amount: Math.round(Number(prod.price) * 100),
        },
        quantity: Number(it.quantity) || 1
      };
    });

    const insertOrder = await new Promise((resolve, reject) => {
      const stmt = db.prepare('INSERT INTO orders (email, items_json, total_cents, status) VALUES (?,?,?,?)');
      const total_cents = line_items.reduce((s, i) => s + i.price_data.unit_amount * i.quantity, 0);
      stmt.run(customer_email || null, JSON.stringify(items), total_cents, 'pending', function (err2) {
        if (err2) reject(err2); else resolve({ orderId: this.lastID, total_cents });
      });
    });

    const sessionObj = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items,
      success_url: `${req.protocol}://${req.get('host')}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.protocol}://${req.get('host')}/cancel.html`,
      metadata: { order_id: insertOrder.orderId }
    });

    res.json({ url: sessionObj.url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

/* ===========================
   Orders (admin)
   =========================== */
// GET /api/orders (admin) - list orders
app.get('/api/orders', requireAdmin, (req, res) => {
  db.all(
    'SELECT id, email, items_json, total_cents, status, created_at FROM orders ORDER BY created_at DESC',
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      rows.forEach(r => { try { r.items = JSON.parse(r.items_json || '[]'); } catch { r.items = []; } });
      res.json(rows);
    }
  );
});

// PUT /api/orders/:id (admin) - update status (processing/shipped/delivered/cancelled)
app.put('/api/orders/:id', requireAdmin, (req, res) => {
  const id = req.params.id;
  const { status, tracking_number } = req.body || {};
  db.run(
    'UPDATE orders SET status = ?, tracking_number = ? WHERE id = ?',
    [status || 'processing', tracking_number || null, id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ changed: this.changes });
    }
  );
});

// DELETE /api/orders/:id (admin) - hard delete
app.delete('/api/orders/:id', requireAdmin, (req, res) => {
  const id = req.params.id;
  db.run('DELETE FROM orders WHERE id = ?', [id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ deleted: this.changes });
  });
});

/* ===========================
   Health & startup
   =========================== */
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use((req, res) => res.status(404).send('Not found'));

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
