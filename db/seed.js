require('dotenv').config();
const fs = require('fs'), path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const slugify = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const P = (c, ...f) => f.map(x => `/images/${c}/${x}`);
const IMAGES = {
 'skin-veil-tinted-serum': P('base','anastasiia-ornarin-dJJ7AfUFFPE-unsplash.jpg','montatip-lilitsanong--M8j8jxrhvU-unsplash.jpg','montatip-lilitsanong-31t5trj9esg-unsplash.jpg'),
 'cloud-matte-lip-tint': P('lip','lip tint.png','lipstick (1).jpg','lipstick (2).jpg','lipstick (3).jpg'),
 'dew-flush-liquid-blush': P('cheek','alejandra-rios-70SXr5l-lGU-unsplash.jpg','ashley-piszek-crSkE1CKQL0-unsplash.jpg','theodora-ispas-IxTdDOJnnio-unsplash.jpg'),
 'micro-define-brow-gel': P('eye','brow-gel (1).jpg','brow-gel (2).jpg','brow-gel (3).jpg','pexels-n-voitkevich-8558532.jpg'),
 'silk-press-setting-powder': P('base','setting powder (1).jpg','setting powder (2).jpg','setting powder (3).jpg'),
 'lash-lift-tubing-mascara': P('eye','mascara.png','mascara 2.png','masara 3.png')
};
const rows = [
 ['Skin Veil Tinted Serum','Base',1299,['Ivory 01:#f3dcc4','Warm Sand 02:#e3b98f','Honey 03:#c68d5f','Espresso 04:#5b3a29'],'Sheer mineral skin tint with breathable squalane hydration.',45,'Bestseller'],
 ['Cloud Matte Lip Tint','Lip',799,['Rose Clay:#c47a78','Spiced Fig:#8a4054','Terracotta:#b9593b','Berry Stain:#8e2a4a'],'Soft-focus blurred lip pigment that wears without drying.',60,null],
 ['Dew Flush Liquid Blush','Cheek',899,['Petal Pink:#f2a3b3','Sunlit Peach:#f4a77f','Mauve Mist:#b98396'],'Weightless serum blush that melts into bare or tinted skin.',38,null],
 ['Micro-Define Brow Gel','Eye',699,['Clear:#e8e8e8','Soft Taupe:#a58f7c','Warm Brown:#7a5236','Espresso:#3d2a20'],'Flexible-hold peptide brow gel with a precision spoolie.',50,null],
 ['Silk Press Setting Powder','Base',1150,['Translucent Fair:#f6e7d6','Medium:#dcb48c','Deep:#9a6a47'],'Talc-free micro-milled powder that softens shine naturally.',25,null],
 ['Lash Lift Tubing Mascara','Eye',950,['Carbon Black:#1a1a1a','Rich Espresso:#3b2a22'],'Smudge-resistant polymer tubing mascara; removes with warm water.',42,'New']
];
(async () => {
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  for (const [name, category, price, shades, description, stock, badge] of rows) {
    const sh = shades.map(s => { const [n, hex] = s.split(':'); return { name: n, hex }; });
    await pool.query(`INSERT INTO products (slug,name,category,price,stock,description,shades,badge,images)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (slug) DO UPDATE SET images = EXCLUDED.images`, [slugify(name), name, category, price, stock, description, JSON.stringify(sh), badge, JSON.stringify(IMAGES[slugify(name)] || [])]);
  }
  await pool.query(`INSERT INTO discounts (code,type,value) VALUES ('CHARMS15','percent',15) ON CONFLICT (code) DO NOTHING`);
  const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
  if (ADMIN_EMAIL && ADMIN_PASSWORD) {
    await pool.query(`INSERT INTO users (full_name,email,password_hash,role) VALUES ('Admin',$1,$2,'admin')
      ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'admin'`, [ADMIN_EMAIL.toLowerCase(), await bcrypt.hash(ADMIN_PASSWORD, 10)]);
  }
  console.log('Database ready: tables created, 6 products, CHARMS15 code, admin user.');
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });