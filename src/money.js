// Small date + money helpers. Dates are ISO strings (YYYY-MM-DD), money is integer cents.

function formatRand(cents) {
  const sign = cents < 0 ? '-' : '';
  const [r, c] = (Math.abs(cents) / 100).toFixed(2).split('.');
  return `${sign}R${r.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}.${c}`;
}

function parseRand(input) {
  const n = Number(String(input || '').replace(/[R\s,]/gi, (m) => (m === ',' ? '.' : '')));
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}

const pad = (n) => String(n).padStart(2, '0');

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function currentPeriod() {
  return today().slice(0, 7);
}

function addMonths(period, n) {
  const [y, m] = period.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${pad((idx % 12) + 1)}`;
}

function lastDayOfPeriod(period) {
  const [y, m] = period.split('-').map(Number);
  return `${period}-${pad(new Date(y, m, 0).getDate())}`;
}

function periodLabel(period) {
  const [y, m] = period.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('en-ZA', { month: 'long', year: 'numeric' });
}

function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
}

module.exports = { formatRand, parseRand, today, currentPeriod, addMonths, lastDayOfPeriod, periodLabel, formatDate };
