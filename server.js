// server.js
require('dotenv').config();

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');

// ✅ Mollie import (CJS compatibility)
const MollieLib = require('@mollie/api-client');
const createMollieClient =
  MollieLib.createMollieClient || MollieLib.default || MollieLib;
const mollie = createMollieClient({ apiKey: process.env.MOLLIE_API_KEY });

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

// ---- data paths ----
const DATA_DIR    = process.env.DATA_DIR    || __dirname;
const DB_FILE     = process.env.DB_PATH     || path.join(DATA_DIR, 'shop.db');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// --- DB
const db = new sqlite3.Database(DB_FILE);

// Ensure orders table has provider columns
db.serialize(() => {
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
  db.get(`SELECT 1 FROM pragma_table_info('orders') WHERE name='provider'`, (err, row) => {
    if (!row) db.run(`ALTER TABLE orders ADD COLUMN provider TEXT`);
  });
  db.get(`SELECT 1 FROM pragma_table_info('orders') WHERE name='provider_payment_id'`, (err, row) => {
    if (!row) db.run(`ALTER TABLE orders ADD COLUMN provider_payment_id TEXT`);
  });
});

/* ===========================
   Webhooks
   =========================== */
app.post('/webhook/mollie', express.urlencoded({ extended: true }), async (req, res) => {
  const paymentId = req.body.id;
  try {
    const payment = await mollie.payments.get(paymentId);
    const orderId = payment.metadata && payment.metadata.order_id;

    if (orderId) {
      if (payment.status === 'paid') {
        db.get('SELECT items_json FROM orders WHERE id = ?', [orderId], (err, row) => {
          if (!err && row) {
            let items = [];
            try { items = JSON.parse(row.items_json || '[]'); } catch {}
            items.forEach(it => {
              const qty = Number(it.quantity) || 0;
              db.run('UPDATE products SET inventory = MAX(inventory - ?, 0) WHERE id = ?', [qty, it.id]);
            });
          }
          db.run('UPDATE orders SET status = ? WHERE id = ?', ['paid', orderId]);
        });
      } else if (['canceled','expired','failed'].includes(payment.status)) {
        db.run('UPDATE orders SET status = ? WHERE id = ?', [payment.status, orderId]);
      }
    }
  } catch (e) {
    console.error('Mollie webhook error:', e.message);
  }
  res.sendStatus(200);
});

/* ===========================
   Global middlewares
   =========================== */
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
if (IS_PROD) app.set('trust proxy', 1);
app.use(session({
  secret: process.env.SESSION_SECRET || 'changeme',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: IS_PROD, httpOnly: true, sameSite: IS_PROD ? 'none' : 'lax' }
}));

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// Multer uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g,'_'))
});
const upload = multer({ storage });

/* ===========================
   Helpers
   =========================== */
function requireAdmin(req, res, next){ if(req.session && req.session.admin) return next(); res.status(401).json({ error:'Unauthorized' }); }
const toCents = (n) => Math.round(Number(n) * 100);

/* ===========================
   Admin auth
   =========================== */
app.post('/api/admin/login', (req,res) => {
  const { username, password } = req.body || {};
  if(!username || !password) return res.status(400).json({ error:'Missing fields' });
  db.get('SELECT id, username, password_hash FROM admins WHERE username=?', [username], (err,row) => {
    if(err) return res.status(500).json({ error:err.message });
    if(!row) return res.status(401).json({ error:'Invalid credentials' });
    bcrypt.compare(password, row.password_hash, (e, ok) => {
      if(e) return res.status(500).json({ error:'bcrypt error' });
      if(!ok) return res.status(401).json({ error:'Invalid credentials' });
      req.session.admin = { id: row.id, username: row.username };
      res.json({ ok:true });
    });
  });
});
app.post('/api/admin/logout', (req,res)=> req.session.destroy(()=> res.json({ok:true})));
app.get('/api/admin/me', (req,res)=> req.session && req.session.admin ? res.json({admin:req.session.admin}) : res.status(401).json({admin:null}));

/* ===========================
   Products
   =========================== */
app.get('/api/products', (req,res)=>{
  db.all('SELECT id, title, description, price, image, inventory FROM products', [], (err,rows)=>{
    if(err) return res.status(500).json({ error:err.message });
    res.json(rows);
  });
});
app.post('/api/products', requireAdmin, upload.single('image'), (req,res)=>{
  const { title, description, price, inventory } = req.body || {};
  const priceNum = Number(price);
  const invNum = Number.isFinite(Number(inventory)) ? Number(inventory) : 0;
  if(!title || !Number.isFinite(priceNum)) return res.status(400).json({ error:'Title and valid price are required' });
  const imagePath = req.file ? '/uploads/' + path.basename(req.file.path) : null;
  db.run('INSERT INTO products (title, description, price, image, inventory) VALUES (?,?,?,?,?)',
    [title, description||'', priceNum, imagePath, invNum],
    function(err){ if(err) return res.status(500).json({ error:err.message }); res.json({ id:this.lastID }); });
});
app.put('/api/products/:id', requireAdmin, upload.single('image'), (req,res)=>{
  const id = req.params.id;
  const { title, description, price, inventory } = req.body || {};
  const fields=[], vals=[];
  if(title !== undefined){ fields.push('title=?'); vals.push(title); }
  if(description !== undefined){ fields.push('description=?'); vals.push(description); }
  if(price !== undefined){ const p=Number(price); if(!Number.isFinite(p)) return res.status(400).json({ error:'Invalid price' }); fields.push('price=?'); vals.push(p); }
  if(inventory !== undefined){ const q=Number(inventory); if(!Number.isFinite(q)) return res.status(400).json({ error:'Invalid inventory' }); fields.push('inventory=?'); vals.push(q); }
  if(req.file){ fields.push('image=?'); vals.push('/uploads/' + path.basename(req.file.path)); }
  if(!fields.length) return res.status(400).json({ error:'Nothing to update' });
  vals.push(id);
  db.run(`UPDATE products SET ${fields.join(', ')} WHERE id=?`, vals, function(err){ if(err) return res.status(500).json({ error:err.message }); res.json({ changed:this.changes }); });
});
app.delete('/api/products/:id', requireAdmin, (req,res)=>{
  db.run('DELETE FROM products WHERE id=?', [req.params.id], function(err){
    if(err) return res.status(500).json({ error:err.message });
    res.json({ deleted:this.changes });
  });
});

/* ===========================
   Checkout (Mollie)
   =========================== */
app.post('/api/checkout', async (req,res) => {
  try{
    const { items, customer_email } = req.body || {};
    if(!items || !items.length) return res.status(400).json({ error:'No items' });

    // fetch server-side prices
    const placeholders = items.map(()=>'?').join(',');
    const ids = items.map(it => it.id);
    const rows = await new Promise((resolve,reject)=>{
      db.all(`SELECT id, title, price FROM products WHERE id IN (${placeholders})`, ids, (err,rows)=> err ? reject(err) : resolve(rows));
    });

    const normalized = items.map(it => {
      const prod = rows.find(r => String(r.id) === String(it.id));
      if(!prod) throw new Error('Product not found: ' + it.id);
      return { name: prod.title, unit_amount_cents: toCents(prod.price), quantity: Number(it.quantity)||1 };
    });
    const total_cents = normalized.reduce((s,i)=> s + i.unit_amount_cents*i.quantity, 0);

    // create local order
    const orderId = await new Promise((resolve,reject)=>{
      db.run('INSERT INTO orders (email, items_json, total_cents, status, provider) VALUES (?,?,?,?,?)',
        [customer_email||null, JSON.stringify(items), total_cents, 'pending', 'mollie'],
        function(err){ err ? reject(err) : resolve(this.lastID); });
    });

    const currency = 'EUR';
    const publicWebhook = process.env.MOLLIE_WEBHOOK_URL || null;

    const payment = await mollie.payments.create({
      amount: { value: (total_cents/100).toFixed(2), currency },
      description: `Order ${orderId}`,
      redirectUrl: `${req.protocol}://${req.get('host')}/success.html?order=${orderId}`,
      ...(publicWebhook ? { webhookUrl: publicWebhook } : {}),
      metadata: { order_id: orderId }
    });

    db.run('UPDATE orders SET provider_payment_id = ? WHERE id = ?', [payment.id, orderId]);

    return res.json({ url: payment.getCheckoutUrl() });
  }catch(e){
    console.error(e);
    res.status(500).json({ error:e.message });
  }
});

// Local verify (when webhooks not available)
app.get('/api/verify-mollie', async (req, res) => {
  const orderId = req.query.order;
  if (!orderId) return res.status(400).json({ error: 'Missing order' });

  db.get('SELECT provider_payment_id, status FROM orders WHERE id = ?', [orderId], async (err, row) => {
    if (err || !row) return res.status(404).json({ error: 'Order not found' });

    try {
      const payment = await mollie.payments.get(row.provider_payment_id);
      if (payment.status === 'paid' && row.status !== 'paid') {
        db.run('UPDATE orders SET status = ? WHERE id = ?', ['paid', orderId]);
      }
      return res.json({ status: payment.status });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });
});

/* ===========================
   Orders (admin)
   =========================== */
app.get('/api/orders', requireAdmin, (req,res)=>{
  db.all('SELECT id, email, items_json, total_cents, status, created_at FROM orders ORDER BY created_at DESC', [], (err,rows)=>{
    if(err) return res.status(500).json({ error:err.message });
    rows.forEach(r => { try{ r.items = JSON.parse(r.items_json||'[]'); } catch { r.items=[]; } });
    res.json(rows);
  });
});
app.put('/api/orders/:id', requireAdmin, (req,res)=>{
  const { status, tracking_number } = req.body || {};
  db.run('UPDATE orders SET status=?, tracking_number=? WHERE id=?', [status||'processing', tracking_number||null, req.params.id], function(err){
    if(err) return res.status(500).json({ error:err.message });
    res.json({ changed:this.changes });
  });
});
app.delete('/api/orders/:id', requireAdmin, (req,res)=>{
  db.run('DELETE FROM orders WHERE id=?', [req.params.id], function(err){
    if(err) return res.status(500).json({ error:err.message });
    res.json({ deleted:this.changes });
  });
});

/* ===========================
   Health & startup
   =========================== */
app.get('/api/health', (req,res)=> res.json({ ok:true }));
app.use((req,res)=> res.status(404).send('Not found'));

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`DB: ${DB_FILE}`);
  console.log(`Uploads: ${UPLOADS_DIR}`);
  if (!process.env.MOLLIE_WEBHOOK_URL) {
    console.log('ℹ️ No MOLLIE_WEBHOOK_URL set — webhooks disabled, using /api/verify-mollie.');
  }
});
