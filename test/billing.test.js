const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-test-'));
const db = require('../src/db');
const billing = require('../src/billing');
const { parseRand, formatRand } = require('../src/money');

function agreement(fields) {
  const info = db.prepare(`INSERT INTO agreements (call_sign, surname, full_names, radio_model, price_cents, plan_months, start_date)
    VALUES (@call_sign, 'Test', 'Pat', 'Kirisun PT570', 140000, @plan_months, @start_date)`).run(fields);
  return db.prepare('SELECT * FROM agreements WHERE id = ?').get(info.lastInsertRowid);
}
const pay = (a, cents, on) => db.prepare('INSERT INTO payments (agreement_id, paid_on, amount_cents) VALUES (?, ?, ?)').run(a.id, on, cents);

test('schedule matches the agreement and totals the purchase price', () => {
  const a3 = agreement({ call_sign: 'S1', plan_months: 3, start_date: '2026-10-15' });
  const s = billing.schedule(a3);
  assert.deepStrictEqual(s.map((r) => r.amount_cents), [46666, 46666, 46668]);
  assert.deepStrictEqual(s.map((r) => r.due_on), ['2026-10-15', '2026-11-30', '2026-12-31']);
  const a6 = agreement({ call_sign: 'S2', plan_months: 6, start_date: '2026-11-01' });
  const s6 = billing.schedule(a6);
  assert.strictEqual(s6.reduce((t, r) => t + r.amount_cents, 0), 140000);
  assert.strictEqual(s6[0].amount_cents, 23333);
  assert.strictEqual(s6[5].due_on, '2027-04-30');
});

test('invoice includes arrears and credits overpayments', () => {
  const a = agreement({ call_sign: 'S3', plan_months: 3, start_date: '2026-09-10' });
  // nothing paid: November invoice = Nov instalment (3rd) + arrears of first two
  let inv = billing.buildInvoice(a, '2026-11');
  assert.strictEqual(inv.instalment_cents, 46668);
  assert.strictEqual(inv.arrears_cents, 93332);
  assert.strictEqual(inv.amount_due_cents, 140000);
  // pays first two plus R100 extra
  pay(a, 93332 + 10000, '2026-10-20');
  inv = billing.buildInvoice(a, '2026-11');
  assert.strictEqual(inv.arrears_cents, 0);
  assert.strictEqual(inv.amount_due_cents, 36668);
  assert.strictEqual(inv.balance_cents, 36668);
  // before the plan starts: nothing
  assert.strictEqual(billing.buildInvoice(a, '2026-08'), null);
});

test('fully paid agreements are marked paid and not invoiced', () => {
  const a = agreement({ call_sign: 'S4', plan_months: 3, start_date: '2026-11-01' });
  pay(a, 140000, '2026-11-01');
  billing.refreshStatus(a.id);
  const fresh = db.prepare('SELECT * FROM agreements WHERE id = ?').get(a.id);
  assert.strictEqual(fresh.status, 'paid');
  assert.strictEqual(billing.buildInvoice(fresh, '2026-11'), null);
});

test('generateForPeriod is idempotent and numbers invoices', () => {
  const first = billing.generateForPeriod('2026-12', null);
  assert.ok(first.length > 0);
  assert.strictEqual(billing.generateForPeriod('2026-12', null).length, 0);
  const nums = db.prepare("SELECT number FROM invoices WHERE period = '2026-12' ORDER BY number").all().map((r) => r.number);
  assert.strictEqual(nums[0], 'INV-202612-001');
});

test('money helpers', () => {
  assert.strictEqual(parseRand('R1 400,50'), 140050);
  assert.strictEqual(parseRand('466.66'), 46666);
  assert.strictEqual(formatRand(140000), 'R1 400.00');
});
