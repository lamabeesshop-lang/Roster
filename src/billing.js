const crypto = require('crypto');
const db = require('./db');
const { addMonths, lastDayOfPeriod, today } = require('./money');

/**
 * Instalment schedule per the agreement: the first instalment is due on signing,
 * each later one by the last day of the following months. Rounding cents go on the
 * last instalment so the total always equals the purchase price
 * (e.g. R1 400 / 3 = 466.66 + 466.66 + 466.68).
 */
function schedule(agreement) {
  const n = agreement.plan_months;
  const base = Math.floor(agreement.price_cents / n);
  const startPeriod = agreement.start_date.slice(0, 7);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const period = addMonths(startPeriod, i);
    rows.push({
      number: i + 1,
      period,
      due_on: i === 0 ? agreement.start_date : lastDayOfPeriod(period),
      amount_cents: i === n - 1 ? agreement.price_cents - base * (n - 1) : base,
    });
  }
  return rows;
}

function paidCents(agreementId) {
  return db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS s FROM payments WHERE agreement_id = ?').get(agreementId).s;
}

/** Financial position of an agreement on a given date (default today). */
function position(agreement, asOf = today()) {
  const sched = schedule(agreement);
  const paid = paidCents(agreement.id);
  const dueToDate = sched.filter((r) => r.due_on <= asOf).reduce((s, r) => s + r.amount_cents, 0);
  let remaining = paid;
  const rows = sched.map((r) => {
    const covered = Math.min(remaining, r.amount_cents);
    remaining -= covered;
    const state = covered >= r.amount_cents ? 'paid' : r.due_on < asOf ? 'overdue' : covered > 0 ? 'part-paid' : 'upcoming';
    return { ...r, covered_cents: covered, state };
  });
  return {
    schedule: rows,
    paid_cents: paid,
    balance_cents: Math.max(agreement.price_cents - paid, 0),
    arrears_cents: Math.max(dueToDate - paid, 0),
    next: rows.find((r) => r.state !== 'paid') || null,
  };
}

/** Marks agreements as paid once the purchase price is covered (and re-opens them if a payment is removed). */
function refreshStatus(agreementId) {
  const a = db.prepare('SELECT * FROM agreements WHERE id = ?').get(agreementId);
  if (!a || a.status === 'terminated') return;
  const status = paidCents(a.id) >= a.price_cents ? 'paid' : 'active';
  if (status !== a.status) db.prepare('UPDATE agreements SET status = ? WHERE id = ?').run(status, a.id);
}

function nextInvoiceNumber(period) {
  const prefix = `INV-${period.replace('-', '')}-`;
  const last = db.prepare('SELECT number FROM invoices WHERE number LIKE ? ORDER BY number DESC LIMIT 1').get(prefix + '%');
  const seq = last ? Number(last.number.slice(prefix.length)) + 1 : 1;
  return prefix + String(seq).padStart(3, '0');
}

/**
 * Builds (but does not save) the invoice for an agreement for a month.
 * Returns null when nothing is owed for that month.
 */
function buildInvoice(agreement, period) {
  if (agreement.status !== 'active') return null;
  const sched = schedule(agreement);
  if (period < sched[0].period) return null;
  const paid = paidCents(agreement.id);
  const expectedBefore = sched.filter((r) => r.period < period).reduce((s, r) => s + r.amount_cents, 0);
  const current = sched.find((r) => r.period === period);
  const instalment = current ? current.amount_cents : 0;
  const arrears = Math.max(expectedBefore - paid, 0);
  // Payments beyond what was due earlier reduce this month's instalment.
  const credit = Math.max(paid - expectedBefore, 0);
  const instalmentDue = Math.max(instalment - credit, 0);
  const amountDue = arrears + instalmentDue;
  if (amountDue <= 0) return null;
  return {
    agreement_id: agreement.id,
    period,
    issued_on: today(),
    due_on: current ? current.due_on : lastDayOfPeriod(period),
    instalment_label: current ? `Instalment ${current.number} of ${agreement.plan_months}` : 'Outstanding balance (plan term ended)',
    instalment_cents: instalmentDue,
    arrears_cents: arrears,
    amount_due_cents: amountDue,
    paid_to_date_cents: paid,
    balance_cents: Math.max(agreement.price_cents - paid, 0),
  };
}

function saveInvoice(inv, userId) {
  const row = {
    ...inv,
    number: nextInvoiceNumber(inv.period),
    token: crypto.randomBytes(18).toString('base64url'),
    created_by: userId || null,
  };
  const info = db.prepare(`INSERT INTO invoices
    (number, agreement_id, period, issued_on, due_on, instalment_label, instalment_cents, arrears_cents,
     amount_due_cents, paid_to_date_cents, balance_cents, token, created_by)
    VALUES (@number, @agreement_id, @period, @issued_on, @due_on, @instalment_label, @instalment_cents, @arrears_cents,
     @amount_due_cents, @paid_to_date_cents, @balance_cents, @token, @created_by)`).run(row);
  return info.lastInsertRowid;
}

/** Creates invoices for every active agreement that owes money for the month and has no invoice yet. */
const generateForPeriod = db.transaction((period, userId) => {
  const agreements = db.prepare(`SELECT * FROM agreements WHERE status = 'active'
    AND id NOT IN (SELECT agreement_id FROM invoices WHERE period = ?)`).all(period);
  const created = [];
  for (const a of agreements) {
    const inv = buildInvoice(a, period);
    if (inv) created.push(saveInvoice(inv, userId));
  }
  return created;
});

/** Re-calculates an unsent invoice (e.g. after a payment was captured). */
function recalcInvoice(invoiceId) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  const a = db.prepare('SELECT * FROM agreements WHERE id = ?').get(inv.agreement_id);
  const fresh = buildInvoice({ ...a, status: 'active' }, inv.period);
  if (!fresh) return false;
  db.prepare(`UPDATE invoices SET issued_on=@issued_on, due_on=@due_on, instalment_label=@instalment_label,
    instalment_cents=@instalment_cents, arrears_cents=@arrears_cents, amount_due_cents=@amount_due_cents,
    paid_to_date_cents=@paid_to_date_cents, balance_cents=@balance_cents WHERE id=@id`).run({ ...fresh, id: invoiceId });
  return true;
}

function paymentReference(agreement) {
  return `${agreement.call_sign} RADIO`.toUpperCase();
}

module.exports = { schedule, position, paidCents, refreshStatus, buildInvoice, saveInvoice, generateForPeriod, recalcInvoice, paymentReference };
