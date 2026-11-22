require('dotenv').config();
const path = require('path');
const express = require('express');
const { Pool, types } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');

types.setTypeParser(1700, parseFloat); // NUMERIC -> number
const { DATABASE_URL, JWT_SECRET, PORT = 3000, NODE_ENV } = process.env;
if (!DATABASE_URL || !JWT_SECRET) { console.error('Missing DATABASE_URL or JWT_SECRET. Copy .env.example to .env and fill it in.'); process.exit(1); }
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

const app = express();
app.use(express.json());
app.use(cookieParser());

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const slugify = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const COOKIE = 'charms_token';
const publicUser = u => ({ id: u.id, full_name: u.full_name, email: u.email, role: u.role });
const issue = (res, u) => res.cookie(COOKIE, jwt.sign({ id: u.id, role: u.role }, JWT_SECRET, { expiresIn: '7d' }),
  { httpOnly: true, sameSite: 'lax', secure: NODE_ENV === 'production', maxAge: 7 * 24 * 3600 * 1000 });

app.use((req, res, next) => { try { req.user = jwt.verify(req.cookies[COOKIE], JWT_SECRET); } catch { req.user = null; } next(); });
const requireAdmin = (req, res, next) => req.user?.role === 'admin' ? next() : res.status(req.user ? 403 : 401).json({ error: 'Admin access required.' });

/* ---------- auth ---------- */
app.post('/api/auth/register', wrap(async (req, res) => {
  const { full_name, email, password } = req.body;
  if (!full_name?.trim() || !email?.includes('@') || (password || '').length < 6) throw new HttpError(400, 'Enter your name, a valid email and a password of at least 6 characters.');
  const { rows: [u] } = await pool.query('INSERT INTO users (full_name,email,password_hash) VALUES ($1,$2,$3) RETURNING *',
    [full_name.trim(), email.trim().toLowerCase(), await bcrypt.hash(password, 10)]).catch(e => { if (e.code === '23505') throw new HttpError(409, 'An account with that email already exists.'); throw e; });
  issue(res, u); res.status(201).json({ user: publicUser(u) });
}));
app.post('/api/auth/login', wrap(async (req, res) => {
  const { rows: [u] } = await pool.query('SELECT * FROM users WHERE email=$1', [String(req.body.email || '').trim().toLowerCase()]);
  if (!u || !(await bcrypt.compare(String(req.body.password || ''), u.password_hash))) throw new HttpError(401, 'Email or password is incorrect.');
  issue(res, u); res.json({ user: publicUser(u) });
}));
app.post('/api/auth/logout', (req, res) => { res.clearCookie(COOKIE); res.json({ ok: true }); });
app.get('/api/auth/me', wrap(async (req, res) => {
  if (!req.user) return res.json({ user: null });
  const { rows: [u] } = await pool.query('SELECT * FROM users WHERE id=$1', [req.user.id]);
  res.json({ user: u ? publicUser(u) : null });
}));

/* ---------- storefront ---------- */
app.get('/api/products', wrap(async (req, res) => {
  const { category, search } = req.query, where = [], vals = [];
  if (category) { vals.push(category); where.push(`category=$${vals.length}`); }
  if (search) { vals.push(`%${search}%`); where.push(`(name ILIKE $${vals.length} OR description ILIKE $${vals.length})`); }
  const { rows } = await pool.query(`SELECT * FROM products ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id`, vals);
  res.json(rows);
}));
app.get('/api/products/:slug', wrap(async (req, res) => {
  const { rows: [p] } = await pool.query('SELECT * FROM products WHERE slug=$1', [req.params.slug]);
  if (!p) throw new HttpError(404, 'Product not found.');
  res.json(p);
}));
app.post('/api/discounts/validate', wrap(async (req, res) => {
  const { rows: [d] } = await pool.query('SELECT code,type,value FROM discounts WHERE code=$1 AND is_active', [String(req.body.code || '').trim().toUpperCase()]);
  if (!d) throw new HttpError(404, 'That discount code isn’t valid.');
  res.json(d);
}));

app.post('/api/orders', wrap(async (req, res) => {
  const { customer_name, customer_email, phone, shipping_address, payment_method, discount_code, items } = req.body;
  if (!customer_name || !customer_email || !shipping_address || !Array.isArray(items) || !items.length) throw new HttpError(400, 'Fill in your contact details, address and add at least one item.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const qtyById = {};
    for (const i of items) { const q = parseInt(i.quantity, 10); if (!(q > 0)) throw new HttpError(400, 'Invalid quantity.'); qtyById[i.product_id] = (qtyById[i.product_id] || 0) + q; }
    const { rows: prods } = await client.query('SELECT * FROM products WHERE id = ANY($1) ORDER BY id FOR UPDATE', [Object.keys(qtyById).map(Number)]);
    const byId = Object.fromEntries(prods.map(p => [p.id, p]));
    for (const [id, q] of Object.entries(qtyById)) {
      const p = byId[id];
      if (!p) throw new HttpError(400, 'A product in your bag is no longer available.');
      if (p.stock < q) throw new HttpError(409, `${p.name}: only ${p.stock} left in stock.`);
    }
    const subtotal = items.reduce((s, i) => s + byId[i.product_id].price * parseInt(i.quantity, 10), 0);
    let discount = 0, code = null;
    if (discount_code) {
      const { rows: [d] } = await client.query('SELECT * FROM discounts WHERE code=$1 AND is_active FOR UPDATE', [String(discount_code).toUpperCase()]);
      if (!d) throw new HttpError(400, 'That discount code is no longer valid.');
      discount = d.type === 'percent' ? Math.round(subtotal * d.value / 100) : Math.min(d.value, subtotal);
      code = d.code;
      await client.query('UPDATE discounts SET usage_count = usage_count + 1 WHERE id=$1', [d.id]);
    }
    const total = Math.max(0, subtotal - discount);
    const { rows: [o] } = await client.query(`INSERT INTO orders (user_id,customer_name,customer_email,phone,shipping_address,payment_method,discount_code,total_amount)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [req.user?.id || null, customer_name, customer_email, phone || null, shipping_address, payment_method || 'cod', code, total]);
    for (const i of items) {
      const p = byId[i.product_id];
      await client.query('INSERT INTO order_items (order_id,product_id,product_name,selected_shade,quantity,unit_price) VALUES ($1,$2,$3,$4,$5,$6)',
        [o.id, p.id, p.name, i.selected_shade || null, parseInt(i.quantity, 10), p.price]);
    }
    for (const [id, q] of Object.entries(qtyById)) await client.query('UPDATE products SET stock = stock - $1 WHERE id=$2', [q, id]);
    await client.query('COMMIT');
    res.status(201).json({ id: o.id, total });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}));

/* ---------- order lookup & cancellation ---------- */
const withItems = `SELECT o.*, COALESCE((SELECT json_agg(json_build_object('name',product_name,'shade',selected_shade,'quantity',quantity,'unit_price',unit_price)) FROM order_items WHERE order_id=o.id),'[]'::json) AS items FROM orders o`;
async function cancelOrder(id, allowed) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [o] } = await client.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [parseInt(id, 10) || 0]);
    if (!o || !allowed(o)) throw new HttpError(404, 'Order not found.');
    if (o.status !== 'placed') throw new HttpError(409, `This order is already ${o.status} and can’t be cancelled.`);
    await client.query(`UPDATE products p SET stock = p.stock + s.q FROM (SELECT product_id, SUM(quantity)::int AS q FROM order_items WHERE order_id=$1 AND product_id IS NOT NULL GROUP BY product_id) s WHERE p.id = s.product_id`, [o.id]);
    if (o.discount_code) await client.query('UPDATE discounts SET usage_count = GREATEST(usage_count - 1, 0) WHERE code=$1', [o.discount_code]);
    await client.query("UPDATE orders SET status='cancelled' WHERE id=$1", [o.id]);
    await client.query('COMMIT');
    return { id: o.id, status: 'cancelled' };
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}
app.get('/api/orders/mine', wrap(async (req, res) => {
  if (!req.user) throw new HttpError(401, 'Sign in to see your orders.');
  res.json((await pool.query(`${withItems} WHERE o.user_id=$1 ORDER BY o.created_at DESC`, [req.user.id])).rows);
}));
app.post('/api/orders/lookup', wrap(async (req, res) => {
  const { rows: [o] } = await pool.query(`${withItems} WHERE o.id=$1 AND lower(o.customer_email)=lower($2)`, [parseInt(req.body.id, 10) || 0, String(req.body.email || '')]);
  if (!o) throw new HttpError(404, 'No order found with that number and email.');
  res.json(o);
}));
app.post('/api/orders/:id/cancel', wrap(async (req, res) => {
  const email = String(req.body.email || '').toLowerCase();
  res.json(await cancelOrder(req.params.id, o => (req.user && o.user_id === req.user.id) || (email && o.customer_email.toLowerCase() === email)));
}));

/* ---------- admin ---------- */
const admin = express.Router();
admin.use(requireAdmin);
admin.post('/products', wrap(async (req, res) => {
  const b = req.body;
  if (!b.name || !b.category || b.price === undefined || b.stock === undefined) throw new HttpError(400, 'Name, category, price and stock are required.');
  const { rows: [p] } = await pool.query(`INSERT INTO products (slug,name,category,price,stock,description,shades,image_url,badge,images) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [b.slug || slugify(b.name), b.name, b.category, b.price, b.stock, b.description || '', JSON.stringify(b.shades || []), b.image_url || '', b.badge || null, JSON.stringify(b.images || [])]);
  res.status(201).json(p);
}));
admin.patch('/products/:id', wrap(async (req, res) => {
  const sets = [], vals = [];
  for (const f of ['name', 'category', 'price', 'stock', 'description', 'shades', 'image_url', 'badge', 'images'])
    if (f in req.body) { vals.push(f === 'shades' || f === 'images' ? JSON.stringify(req.body[f]) : req.body[f]); sets.push(`${f}=$${vals.length}`); }
  if (!sets.length) throw new HttpError(400, 'Nothing to update.');
  vals.push(req.params.id);
  const { rows: [p] } = await pool.query(`UPDATE products SET ${sets.join(',')} WHERE id=$${vals.length} RETURNING *`, vals);
  if (!p) throw new HttpError(404, 'Product not found.');
  res.json(p);
}));
admin.delete('/products/:id', wrap(async (req, res) => { await pool.query('DELETE FROM products WHERE id=$1', [req.params.id]); res.json({ ok: true }); }));

admin.get('/discounts', wrap(async (req, res) => res.json((await pool.query('SELECT * FROM discounts ORDER BY id')).rows)));
admin.post('/discounts', wrap(async (req, res) => {
  const { code, type, value, is_active = true } = req.body;
  if (!code || !['percent', 'flat'].includes(type) || !(value > 0) || (type === 'percent' && value > 100)) throw new HttpError(400, 'Enter a code, a type and a valid value (percentages max out at 100).');
  const { rows: [d] } = await pool.query('INSERT INTO discounts (code,type,value,is_active) VALUES ($1,$2,$3,$4) RETURNING *', [code.toUpperCase(), type, value, is_active]);
  res.status(201).json(d);
}));
admin.patch('/discounts/:id', wrap(async (req, res) => {
  const sets = [], vals = [];
  for (const f of ['code', 'type', 'value', 'is_active']) if (f in req.body) { vals.push(req.body[f]); sets.push(`${f}=$${vals.length}`); }
  if (!sets.length) throw new HttpError(400, 'Nothing to update.');
  vals.push(req.params.id);
  const { rows: [d] } = await pool.query(`UPDATE discounts SET ${sets.join(',')} WHERE id=$${vals.length} RETURNING *`, vals);
  if (!d) throw new HttpError(404, 'Discount not found.');
  res.json(d);
}));
admin.delete('/discounts/:id', wrap(async (req, res) => { await pool.query('DELETE FROM discounts WHERE id=$1', [req.params.id]); res.json({ ok: true }); }));
admin.get('/orders', wrap(async (req, res) => res.json((await pool.query(
  `SELECT o.*, COALESCE(SUM(i.quantity),0)::int AS items_count FROM orders o LEFT JOIN order_items i ON i.order_id=o.id GROUP BY o.id ORDER BY o.created_at DESC LIMIT 200`)).rows)));
admin.post('/orders/:id/cancel', wrap(async (req, res) => res.json(await cancelOrder(req.params.id, () => true))));
app.use('/api/admin', admin);

/* ---------- static frontend + errors ---------- */
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use('/images', express.static(path.join(__dirname, 'images')));
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((err, req, res, next) => {
  if (err.code === '23505') return res.status(409).json({ error: 'That value already exists (duplicate slug, email or code).' });
  if (err.code === '23514') return res.status(400).json({ error: 'A value is out of range.' });
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(err); res.status(500).json({ error: 'Server error. Try again.' });
});
app.listen(PORT, () => console.log(`Charms running at http://localhost:${PORT}`));