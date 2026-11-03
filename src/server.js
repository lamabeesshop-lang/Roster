const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcryptjs');

const config = require('./config');
const db = require('./db');
const SqliteStore = require('./session-store');
const billing = require('./billing');
const notify = require('./notify');
const { invoicePdf } = require('./pdf');
const m = require('./money');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({ 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
  next();
});
app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1d' }));
app.use(express.urlencoded({ extended: false, limit: '200kb' }));
app.use(session({
  store: new SqliteStore(),
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  name: 'scpf.sid',
  cookie: { httpOnly: true, sameSite: 'lax', secure: config.baseUrl.startsWith('https://'), maxAge: 12 * 3600e3 },
}));

const upload = multer({
  storage: multer.diskStorage({
    destination: config.uploadDir,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(pdf|jpe?g|png|heic|webp)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only PDF or image files (jpg, png, heic, webp) can be uploaded.'), ok);
  },
});

// ---------- helpers ----------
const flash = (req, type, text) => { (req.session.flash ||= []).push({ type, text }); };
const back = (req, fallback = '/') => {
  const ref = req.get('referer');
  return ref && ref.startsWith(config.baseUrl) ? ref : fallback;
};
const getAgreement = (id) => db.prepare('SELECT * FROM agreements WHERE id = ?').get(id);
const getInvoice = (id) => db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
const validPeriod = (p) => (/^\d{4}-(0[1-9]|1[0-2])$/.test(p || '') ? p : m.currentPeriod());

app.use((req, res, next) => {
  req.session.csrf ||= crypto.randomBytes(16).toString('hex');
  res.locals.csrf = req.session.csrf;
  res.locals.user = req.session.userId ? db.prepare('SELECT id, username, name, is_admin FROM users WHERE id = ?').get(req.session.userId) : null;
  res.locals.flash = req.session.flash || [];
  req.session.flash = [];
  res.locals.m = m;
  res.locals.config = config;
  res.locals.path = req.path;
  res.locals.emailReady = notify.emailConfigured();
  res.locals.waApiReady = notify.whatsappApiConfigured();
  next();
});

function checkCsrf(req, res, next) {
  if (req.method === 'POST' && (!req.body || req.body._csrf !== req.session.csrf)) {
    return res.status(403).send('Form expired – go back, refresh the page and try again.');
  }
  next();
}
// multipart forms are checked after multer has parsed them
app.use((req, res, next) => (req.is('multipart/form-data') ? next() : checkCsrf(req, res, next)));

function requireLogin(req, res, next) {
  if (res.locals.user) return next();
  req.session.returnTo = req.originalUrl;
  res.redirect('/login');
}
function requireAdmin(req, res, next) {
  if (res.locals.user && res.locals.user.is_admin) return next();
  res.status(403).send('Only an administrator can do this.');
}

// ---------- public: shareable invoice PDF (link sent via WhatsApp / e-mail) ----------
app.get('/i/:token', async (req, res) => {
  const token = req.params.token.replace(/\.pdf$/, '');
  const inv = db.prepare('SELECT * FROM invoices WHERE token = ?').get(token);
  if (!inv) return res.status(404).send('Invoice not found.');
  const pdf = await invoicePdf(inv, getAgreement(inv.agreement_id));
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${inv.number}.pdf"`, 'Cache-Control': 'no-store' });
  res.send(pdf);
});

// ---------- auth ----------
const userCount = () => db.prepare('SELECT COUNT(*) AS c FROM users').get().c;

app.get('/setup', (req, res) => (userCount() ? res.redirect('/login') : res.render('setup')));
app.post('/setup', (req, res) => {
  if (userCount()) return res.redirect('/login');
  const { name, username, password } = req.body;
  if (!name || !username || (password || '').length < 8) {
    flash(req, 'error', 'Fill in all fields; the password must be at least 8 characters.');
    return res.redirect('/setup');
  }
  const info = db.prepare('INSERT INTO users (name, username, password_hash, is_admin) VALUES (?, ?, ?, 1)')
    .run(name.trim(), username.trim(), bcrypt.hashSync(password, 12));
  req.session.regenerate(() => {
    req.session.userId = info.lastInsertRowid;
    flash(req, 'success', 'Administrator account created. Add your two team members under “Team”.');
    res.redirect('/');
  });
});

const attempts = new Map();
app.get('/login', (req, res) => {
  if (!userCount()) return res.redirect('/setup');
  if (res.locals.user) return res.redirect('/');
  res.render('login');
});
app.post('/login', (req, res) => {
  const key = `${req.ip}|${(req.body.username || '').toLowerCase()}`;
  const a = attempts.get(key) || { n: 0, until: 0 };
  if (a.until > Date.now()) {
    flash(req, 'error', 'Too many failed attempts. Try again in 15 minutes.');
    return res.redirect('/login');
  }
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get((req.body.username || '').trim());
  if (!u || !bcrypt.compareSync(req.body.password || '', u.password_hash)) {
    a.n += 1;
    if (a.n >= 5) Object.assign(a, { n: 0, until: Date.now() + 15 * 60e3 });
    attempts.set(key, a);
    flash(req, 'error', 'Wrong username or password.');
    return res.redirect('/login');
  }
  attempts.delete(key);
  const returnTo = req.session.returnTo;
  req.session.regenerate(() => {
    req.session.userId = u.id;
    res.redirect(returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/');
  });
});
app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

app.use(requireLogin);

// ---------- dashboard ----------
app.get('/', (req, res) => {
  const period = m.currentPeriod();
  const active = db.prepare("SELECT * FROM agreements WHERE status = 'active' ORDER BY call_sign").all();
  let outstanding = 0;
  const arrears = [];
  for (const a of active) {
    const p = billing.position(a);
    outstanding += p.balance_cents;
    if (p.arrears_cents > 0) arrears.push({ a, p });
  }
  const counts = db.prepare('SELECT status, COUNT(*) c FROM agreements GROUP BY status').all()
    .reduce((o, r) => ({ ...o, [r.status]: r.c }), {});
  const inv = db.prepare(`SELECT COUNT(*) total, SUM(emailed_at IS NOT NULL OR whatsapp_at IS NOT NULL) sent
    FROM invoices WHERE period = ?`).get(period);
  const missingSigned = db.prepare("SELECT * FROM agreements WHERE signed_file IS NULL AND status != 'terminated' ORDER BY call_sign").all();
  const collected = db.prepare("SELECT COALESCE(SUM(amount_cents),0) s FROM payments WHERE substr(paid_on,1,7) = ?").get(period).s;
  const recent = db.prepare(`SELECT act.*, u.name user_name, a.call_sign FROM activity act
    LEFT JOIN users u ON u.id = act.user_id LEFT JOIN agreements a ON a.id = act.agreement_id
    ORDER BY act.id DESC LIMIT 12`).all();
  res.render('dashboard', { period, counts, outstanding, arrears, inv, missingSigned, collected, recent });
});

// ---------- agreements ----------
const FIELDS = ['call_sign', 'id_number', 'surname', 'full_names', 'initials', 'address', 'suburb', 'postal_code',
  'cellphone', 'email', 'radio_model', 'serial_number', 'notes'];

function readAgreementForm(body) {
  const a = {};
  for (const f of FIELDS) a[f] = (body[f] || '').trim();
  a.call_sign = a.call_sign.toUpperCase();
  a.price_cents = m.parseRand(body.price);
  a.plan_months = Number(body.plan_months);
  a.start_date = body.start_date;
  const errors = [];
  if (!a.call_sign) errors.push('Call sign is required.');
  if (!a.surname || !a.full_names) errors.push('Surname and full names are required.');
  if (!a.radio_model) errors.push('Radio make and model is required.');
  if (!(a.price_cents > 0)) errors.push('Purchase price must be a positive amount.');
  if (!(a.plan_months >= 1 && a.plan_months <= 24)) errors.push('Choose a payment plan.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.start_date || '')) errors.push('Agreement date is required.');
  if (a.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.email)) errors.push('E-mail address looks wrong.');
  if (a.cellphone && !notify.waNumber(a.cellphone)) errors.push('Cellphone number looks wrong.');
  return { a, errors };
}

app.get('/agreements', (req, res) => {
  const q = (req.query.q || '').trim();
  const status = ['active', 'paid', 'terminated'].includes(req.query.status) ? req.query.status : '';
  let sql = 'SELECT * FROM agreements WHERE 1=1';
  const args = [];
  if (status) { sql += ' AND status = ?'; args.push(status); }
  if (q) {
    sql += ' AND (call_sign LIKE ? OR surname LIKE ? OR full_names LIKE ? OR serial_number LIKE ? OR cellphone LIKE ?)';
    args.push(...Array(5).fill(`%${q}%`));
  }
  const rows = db.prepare(sql + ' ORDER BY call_sign').all(...args).map((a) => ({ ...a, pos: billing.position(a) }));
  res.render('agreements', { rows, q, status });
});

app.get('/agreements/new', (req, res) => {
  res.render('agreement-form', {
    a: { radio_model: config.defaults.radioModel, price_cents: config.defaults.priceCents, plan_months: 3, start_date: m.today() },
    errors: [],
  });
});

app.post('/agreements', upload.single('signed'), checkCsrf, (req, res) => {
  const { a, errors } = readAgreementForm(req.body);
  if (errors.length) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).render('agreement-form', { a, errors });
  }
  const info = db.prepare(`INSERT INTO agreements (${FIELDS.join(', ')}, price_cents, plan_months, start_date, created_by,
    signed_file, signed_file_name, signed_uploaded_at)
    VALUES (${FIELDS.map((f) => '@' + f).join(', ')}, @price_cents, @plan_months, @start_date, @created_by,
    @signed_file, @signed_file_name, @signed_uploaded_at)`).run({
    ...a,
    created_by: req.session.userId,
    signed_file: req.file ? req.file.filename : null,
    signed_file_name: req.file ? req.file.originalname : null,
    signed_uploaded_at: req.file ? new Date().toISOString() : null,
  });
  db.log(req.session.userId, info.lastInsertRowid, 'Created agreement' + (req.file ? ' with signed copy' : ''));
  flash(req, 'success', `Agreement for ${a.call_sign} saved.`);
  res.redirect(`/agreements/${info.lastInsertRowid}`);
});

app.get('/agreements/:id', (req, res) => {
  const a = getAgreement(req.params.id);
  if (!a) return res.status(404).send('Agreement not found.');
  const pos = billing.position(a);
  const payments = db.prepare(`SELECT p.*, u.name user_name FROM payments p LEFT JOIN users u ON u.id = p.created_by
    WHERE agreement_id = ? ORDER BY paid_on DESC, id DESC`).all(a.id);
  const invoices = db.prepare('SELECT * FROM invoices WHERE agreement_id = ? ORDER BY period DESC').all(a.id)
    .map((i) => ({ ...i, email: a.email, wa: notify.whatsappLink(i, a) }));
  const activity = db.prepare(`SELECT act.*, u.name user_name FROM activity act LEFT JOIN users u ON u.id = act.user_id
    WHERE agreement_id = ? ORDER BY act.id DESC LIMIT 30`).all(a.id);
  res.render('agreement', { a, pos, payments, invoices, activity, reference: billing.paymentReference(a) });
});

app.get('/agreements/:id/edit', (req, res) => {
  const a = getAgreement(req.params.id);
  if (!a) return res.status(404).send('Agreement not found.');
  res.render('agreement-form', { a, errors: [] });
});

app.post('/agreements/:id', (req, res) => {
  const existing = getAgreement(req.params.id);
  if (!existing) return res.status(404).send('Agreement not found.');
  const { a, errors } = readAgreementForm(req.body);
  if (errors.length) return res.status(400).render('agreement-form', { a: { ...a, id: existing.id }, errors });
  db.prepare(`UPDATE agreements SET ${FIELDS.map((f) => `${f} = @${f}`).join(', ')},
    price_cents = @price_cents, plan_months = @plan_months, start_date = @start_date WHERE id = @id`).run({ ...a, id: existing.id });
  billing.refreshStatus(existing.id);
  db.log(req.session.userId, existing.id, 'Edited agreement details');
  flash(req, 'success', 'Agreement updated. Invoices already issued keep their amounts – use “Recalculate” on unsent ones if needed.');
  res.redirect(`/agreements/${existing.id}`);
});

app.post('/agreements/:id/upload', upload.single('signed'), checkCsrf, (req, res) => {
  const a = getAgreement(req.params.id);
  if (!a || !req.file) {
    if (req.file) fs.unlink(req.file.path, () => {});
    flash(req, 'error', 'Choose a file to upload.');
    return res.redirect(a ? `/agreements/${a.id}` : '/agreements');
  }
  if (a.signed_file) fs.unlink(path.join(config.uploadDir, a.signed_file), () => {});
  db.prepare('UPDATE agreements SET signed_file = ?, signed_file_name = ?, signed_uploaded_at = ? WHERE id = ?')
    .run(req.file.filename, req.file.originalname, new Date().toISOString(), a.id);
  db.log(req.session.userId, a.id, `Uploaded signed agreement (${req.file.originalname})`);
  flash(req, 'success', 'Signed agreement uploaded.');
  res.redirect(`/agreements/${a.id}`);
});

app.get('/agreements/:id/signed', (req, res) => {
  const a = getAgreement(req.params.id);
  if (!a || !a.signed_file) return res.status(404).send('No signed agreement uploaded.');
  const ext = path.extname(a.signed_file);
  res.set('Cache-Control', 'private, no-store');
  res.sendFile(path.join(config.uploadDir, a.signed_file), {
    headers: { 'Content-Disposition': `inline; filename="Agreement-${a.call_sign.replace(/[^\w-]/g, '')}${ext}"` },
  });
});

app.post('/agreements/:id/status', (req, res) => {
  const a = getAgreement(req.params.id);
  if (!a) return res.status(404).send('Agreement not found.');
  if (req.body.status === 'terminated') {
    db.prepare("UPDATE agreements SET status = 'terminated' WHERE id = ?").run(a.id);
    db.log(req.session.userId, a.id, 'Terminated agreement');
  } else {
    db.prepare("UPDATE agreements SET status = 'active' WHERE id = ?").run(a.id);
    billing.refreshStatus(a.id);
    db.log(req.session.userId, a.id, 'Re-activated agreement');
  }
  res.redirect(`/agreements/${a.id}`);
});

app.post('/agreements/:id/delete', requireAdmin, (req, res) => {
  const a = getAgreement(req.params.id);
  if (!a) return res.status(404).send('Agreement not found.');
  if (req.body.confirm !== a.call_sign) {
    flash(req, 'error', `Type the call sign (${a.call_sign}) to confirm deleting.`);
    return res.redirect(`/agreements/${a.id}`);
  }
  if (a.signed_file) fs.unlink(path.join(config.uploadDir, a.signed_file), () => {});
  db.prepare('DELETE FROM agreements WHERE id = ?').run(a.id);
  db.log(req.session.userId, null, `Deleted agreement ${a.call_sign} (${a.full_names} ${a.surname})`);
  flash(req, 'success', `Agreement ${a.call_sign} deleted.`);
  res.redirect('/agreements');
});

// ---------- payments ----------
app.post('/agreements/:id/payments', (req, res) => {
  const a = getAgreement(req.params.id);
  if (!a) return res.status(404).send('Agreement not found.');
  const amount = m.parseRand(req.body.amount);
  if (!(amount > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(req.body.paid_on || '')) {
    flash(req, 'error', 'Enter a payment date and an amount.');
    return res.redirect(`/agreements/${a.id}`);
  }
  db.prepare('INSERT INTO payments (agreement_id, paid_on, amount_cents, reference, note, created_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(a.id, req.body.paid_on, amount, (req.body.reference || '').trim(), (req.body.note || '').trim(), req.session.userId);
  billing.refreshStatus(a.id);
  db.log(req.session.userId, a.id, `Captured payment of ${m.formatRand(amount)}`);
  const after = getAgreement(a.id);
  flash(req, 'success', after.status === 'paid'
    ? `Payment captured – ${a.call_sign} has now paid in full. The agreement is complete.`
    : `Payment of ${m.formatRand(amount)} captured.`);
  res.redirect(`/agreements/${a.id}`);
});

app.post('/payments/:id/delete', (req, res) => {
  const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).send('Payment not found.');
  db.prepare('DELETE FROM payments WHERE id = ?').run(p.id);
  billing.refreshStatus(p.agreement_id);
  db.log(req.session.userId, p.agreement_id, `Removed payment of ${m.formatRand(p.amount_cents)} (${p.paid_on})`);
  flash(req, 'success', 'Payment removed.');
  res.redirect(`/agreements/${p.agreement_id}`);
});

// ---------- invoices ----------
app.get('/invoices', (req, res) => {
  const period = validPeriod(req.query.period);
  const rows = db.prepare(`SELECT i.*, a.call_sign, a.full_names, a.surname, a.email, a.cellphone, a.status
    FROM invoices i JOIN agreements a ON a.id = i.agreement_id WHERE i.period = ? ORDER BY a.call_sign`).all(period)
    .map((i) => ({ ...i, wa: notify.whatsappLink(i, getAgreement(i.agreement_id)) }));
  const pending = db.prepare("SELECT * FROM agreements WHERE status = 'active' AND id NOT IN (SELECT agreement_id FROM invoices WHERE period = ?)")
    .all(period).filter((a) => billing.buildInvoice(a, period)).length;
  res.render('invoices', { period, rows, pending, prev: m.addMonths(period, -1), next: m.addMonths(period, 1) });
});

app.post('/invoices/generate', (req, res) => {
  const period = validPeriod(req.body.period);
  const created = billing.generateForPeriod(period, req.session.userId);
  for (const id of created) db.log(req.session.userId, getInvoice(id).agreement_id, `Generated invoice ${getInvoice(id).number}`);
  flash(req, 'success', created.length ? `${created.length} invoice(s) created for ${m.periodLabel(period)}.` : 'No new invoices needed – everyone is invoiced or up to date.');
  res.redirect(`/invoices?period=${period}`);
});

app.post('/agreements/:id/invoice', (req, res) => {
  const a = getAgreement(req.params.id);
  if (!a) return res.status(404).send('Agreement not found.');
  const period = validPeriod(req.body.period);
  if (db.prepare('SELECT 1 FROM invoices WHERE agreement_id = ? AND period = ?').get(a.id, period)) {
    flash(req, 'error', `There is already an invoice for ${m.periodLabel(period)}.`);
  } else {
    const inv = billing.buildInvoice(a, period);
    if (!inv) flash(req, 'error', `Nothing is owed for ${m.periodLabel(period)}.`);
    else {
      const id = billing.saveInvoice(inv, req.session.userId);
      db.log(req.session.userId, a.id, `Generated invoice ${getInvoice(id).number}`);
      flash(req, 'success', 'Invoice created.');
    }
  }
  res.redirect(`/agreements/${a.id}`);
});

app.get('/invoices/:id/pdf', async (req, res) => {
  const inv = getInvoice(req.params.id);
  if (!inv) return res.status(404).send('Invoice not found.');
  const pdf = await invoicePdf(inv, getAgreement(inv.agreement_id));
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${inv.number}.pdf"` });
  res.send(pdf);
});

async function emailInvoice(inv, userId) {
  const a = getAgreement(inv.agreement_id);
  await notify.sendInvoiceEmail(inv, a, await invoicePdf(inv, a));
  db.prepare("UPDATE invoices SET emailed_at = datetime('now') WHERE id = ?").run(inv.id);
  db.log(userId, a.id, `E-mailed invoice ${inv.number} to ${a.email}`);
}

app.post('/invoices/:id/email', async (req, res) => {
  const inv = getInvoice(req.params.id);
  if (!inv) return res.status(404).send('Invoice not found.');
  try {
    await emailInvoice(inv, req.session.userId);
    flash(req, 'success', `Invoice ${inv.number} e-mailed.`);
  } catch (e) {
    flash(req, 'error', `E-mail failed: ${e.message}`);
  }
  res.redirect(back(req, `/invoices?period=${inv.period}`));
});

app.post('/invoices/email-all', async (req, res) => {
  const period = validPeriod(req.body.period);
  const rows = db.prepare(`SELECT i.* FROM invoices i JOIN agreements a ON a.id = i.agreement_id
    WHERE i.period = ? AND i.emailed_at IS NULL AND a.email != '' AND a.email IS NOT NULL`).all(period);
  let ok = 0;
  const failed = [];
  for (const inv of rows) {
    try { await emailInvoice(inv, req.session.userId); ok++; } catch (e) { failed.push(`${inv.number}: ${e.message}`); }
  }
  if (ok) flash(req, 'success', `${ok} invoice(s) e-mailed.`);
  if (failed.length) flash(req, 'error', `Not sent – ${failed.join('; ')}`);
  if (!rows.length) flash(req, 'info', 'No unsent invoices with an e-mail address for this month.');
  res.redirect(`/invoices?period=${period}`);
});

// Click-to-send: records the send and opens WhatsApp with the message pre-filled.
app.get('/invoices/:id/whatsapp', (req, res) => {
  const inv = getInvoice(req.params.id);
  if (!inv) return res.status(404).send('Invoice not found.');
  const a = getAgreement(inv.agreement_id);
  const link = notify.whatsappLink(inv, a);
  if (!link) {
    flash(req, 'error', `${a.call_sign} has no valid cellphone number.`);
    return res.redirect(back(req, `/agreements/${a.id}`));
  }
  db.prepare("UPDATE invoices SET whatsapp_at = datetime('now') WHERE id = ?").run(inv.id);
  db.log(req.session.userId, a.id, `Opened WhatsApp message for invoice ${inv.number}`);
  res.redirect(link);
});

app.post('/invoices/:id/whatsapp-api', async (req, res) => {
  const inv = getInvoice(req.params.id);
  if (!inv) return res.status(404).send('Invoice not found.');
  const a = getAgreement(inv.agreement_id);
  try {
    await notify.sendInvoiceWhatsApp(inv, a);
    db.prepare("UPDATE invoices SET whatsapp_at = datetime('now') WHERE id = ?").run(inv.id);
    db.log(req.session.userId, a.id, `Sent invoice ${inv.number} via WhatsApp API`);
    flash(req, 'success', `Invoice ${inv.number} sent on WhatsApp.`);
  } catch (e) {
    flash(req, 'error', e.message);
  }
  res.redirect(back(req, `/invoices?period=${inv.period}`));
});

app.post('/invoices/whatsapp-all', async (req, res) => {
  const period = validPeriod(req.body.period);
  const rows = db.prepare('SELECT * FROM invoices WHERE period = ? AND whatsapp_at IS NULL').all(period);
  let ok = 0;
  const failed = [];
  for (const inv of rows) {
    try {
      await notify.sendInvoiceWhatsApp(inv, getAgreement(inv.agreement_id));
      db.prepare("UPDATE invoices SET whatsapp_at = datetime('now') WHERE id = ?").run(inv.id);
      db.log(req.session.userId, inv.agreement_id, `Sent invoice ${inv.number} via WhatsApp API`);
      ok++;
    } catch (e) { failed.push(`${inv.number}: ${e.message}`); }
  }
  if (ok) flash(req, 'success', `${ok} invoice(s) sent on WhatsApp.`);
  if (failed.length) flash(req, 'error', `Not sent – ${failed.join('; ')}`);
  res.redirect(`/invoices?period=${period}`);
});

app.post('/invoices/:id/recalc', (req, res) => {
  const inv = getInvoice(req.params.id);
  if (!inv) return res.status(404).send('Invoice not found.');
  if (billing.recalcInvoice(inv.id)) flash(req, 'success', `Invoice ${inv.number} recalculated.`);
  else flash(req, 'info', `Nothing is owed any more for ${m.periodLabel(inv.period)} – you can delete invoice ${inv.number}.`);
  res.redirect(back(req, `/invoices?period=${inv.period}`));
});

app.post('/invoices/:id/delete', (req, res) => {
  const inv = getInvoice(req.params.id);
  if (!inv) return res.status(404).send('Invoice not found.');
  db.prepare('DELETE FROM invoices WHERE id = ?').run(inv.id);
  db.log(req.session.userId, inv.agreement_id, `Deleted invoice ${inv.number}`);
  flash(req, 'success', `Invoice ${inv.number} deleted.`);
  res.redirect(back(req, `/invoices?period=${inv.period}`));
});

// ---------- team ----------
app.get('/team', (req, res) => {
  const users = db.prepare('SELECT id, name, username, email, is_admin, created_at FROM users ORDER BY id').all();
  res.render('team', { users });
});

app.post('/team', requireAdmin, (req, res) => {
  const { name, username, email, password } = req.body;
  if (!name || !username || (password || '').length < 8) {
    flash(req, 'error', 'Name, username and a password of at least 8 characters are required.');
    return res.redirect('/team');
  }
  try {
    db.prepare('INSERT INTO users (name, username, email, password_hash, is_admin) VALUES (?, ?, ?, ?, ?)')
      .run(name.trim(), username.trim(), (email || '').trim(), bcrypt.hashSync(password, 12), req.body.is_admin ? 1 : 0);
    flash(req, 'success', `${name} can now log in as “${username.trim()}”.`);
  } catch (e) {
    flash(req, 'error', 'That username is already taken.');
  }
  res.redirect('/team');
});

app.post('/team/:id/password', (req, res) => {
  const id = Number(req.params.id);
  const me = res.locals.user;
  if (id !== me.id && !me.is_admin) return res.status(403).send('Only an administrator can do this.');
  if ((req.body.password || '').length < 8) {
    flash(req, 'error', 'Password must be at least 8 characters.');
    return res.redirect('/team');
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(req.body.password, 12), id);
  if (id !== me.id) db.prepare("DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?").run(id);
  flash(req, 'success', 'Password changed.');
  res.redirect('/team');
});

app.post('/team/:id/delete', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === res.locals.user.id) {
    flash(req, 'error', 'You cannot remove your own account.');
    return res.redirect('/team');
  }
  db.prepare('UPDATE agreements SET created_by = NULL WHERE created_by = ?').run(id);
  db.prepare('UPDATE payments SET created_by = NULL WHERE created_by = ?').run(id);
  db.prepare('UPDATE invoices SET created_by = NULL WHERE created_by = ?').run(id);
  db.prepare("DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?").run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  flash(req, 'success', 'Team member removed.');
  res.redirect('/team');
});

// ---------- errors ----------
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || /can be uploaded/.test(err.message)) {
    flash(req, 'error', err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (max 15 MB).' : err.message);
    return res.redirect(back(req, '/agreements'));
  }
  console.error(err);
  res.status(500).send('Something went wrong. Please try again.');
});

if (require.main === module) {
  if (config.sessionSecret === 'change-me-in-production') console.warn('WARNING: set SESSION_SECRET in .env before going live.');
  app.listen(config.port, () => console.log(`Radio agreements running on ${config.baseUrl} (port ${config.port})`));
}

module.exports = app;
