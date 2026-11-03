const nodemailer = require('nodemailer');
const config = require('./config');
const { formatRand, formatDate, periodLabel } = require('./money');
const { paymentReference } = require('./billing');

const emailConfigured = () => Boolean(config.smtp.host && config.smtp.from);
const whatsappApiConfigured = () => Boolean(config.whatsapp.token && config.whatsapp.phoneNumberId && config.whatsapp.template);

let transport;
function transporter() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  }
  return transport;
}

function invoiceUrl(invoice) {
  return `${config.baseUrl}/i/${invoice.token}`;
}

function messageText(invoice, agreement) {
  const s = config.seller;
  return [
    `Good day ${agreement.full_names.split(' ')[0]} (${agreement.call_sign}),`,
    '',
    `Your ${s.shortName} radio invoice ${invoice.number} for ${periodLabel(invoice.period)}:`,
    `${invoice.instalment_label}: ${formatRand(invoice.instalment_cents)}`,
    ...(invoice.arrears_cents > 0 ? [`Arrears: ${formatRand(invoice.arrears_cents)}`] : []),
    `Amount due: ${formatRand(invoice.amount_due_cents)} by ${formatDate(invoice.due_on)}`,
    `Outstanding balance: ${formatRand(invoice.balance_cents)}`,
    '',
    `Pay into: ${s.accountName}, ${s.bank}, Acc ${s.accountNumber}, Branch ${s.branchCode}`,
    `Reference: ${paymentReference(agreement)}`,
    '',
    `Invoice PDF: ${invoiceUrl(invoice)}`,
    `Please send proof of payment to ${s.email}.`,
    '',
    `Thank you – ${s.name}`,
  ].join('\n');
}

async function sendInvoiceEmail(invoice, agreement, pdfBuffer) {
  if (!emailConfigured()) throw new Error('E-mail is not set up yet (SMTP settings missing in .env).');
  if (!agreement.email) throw new Error(`${agreement.call_sign} has no e-mail address.`);
  await transporter().sendMail({
    from: config.smtp.from,
    to: agreement.email,
    replyTo: config.seller.email,
    subject: `${config.seller.shortName} radio invoice ${invoice.number} – ${formatRand(invoice.amount_due_cents)} due ${formatDate(invoice.due_on)}`,
    text: messageText(invoice, agreement),
    attachments: [{ filename: `${invoice.number}.pdf`, content: pdfBuffer, contentType: 'application/pdf' }],
  });
}

/** Normalises a local number (e.g. 082 123 4567) to international digits (27821234567). */
function waNumber(cell) {
  let d = String(cell || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = config.whatsapp.countryCode + d.slice(1);
  return d.length >= 10 ? d : null;
}

/** Click-to-send link: opens WhatsApp (web/app) with the message ready to send. */
function whatsappLink(invoice, agreement) {
  const n = waNumber(agreement.cellphone);
  if (!n) return null;
  return `https://wa.me/${n}?text=${encodeURIComponent(messageText(invoice, agreement))}`;
}

/**
 * Optional automatic sending through the WhatsApp Cloud API. Business-initiated messages
 * must use a Meta-approved template: document header + body params
 * {{1}} name, {{2}} invoice no, {{3}} amount due, {{4}} due date, {{5}} payment reference.
 */
async function sendInvoiceWhatsApp(invoice, agreement) {
  if (!whatsappApiConfigured()) throw new Error('WhatsApp Cloud API is not set up.');
  const to = waNumber(agreement.cellphone);
  if (!to) throw new Error(`${agreement.call_sign} has no valid cellphone number.`);
  const w = config.whatsapp;
  const text = (t) => ({ type: 'text', text: t });
  const res = await fetch(`https://graph.facebook.com/v21.0/${w.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${w.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: w.template,
        language: { code: w.templateLang },
        components: [
          { type: 'header', parameters: [{ type: 'document', document: { link: `${invoiceUrl(invoice)}.pdf`, filename: `${invoice.number}.pdf` } }] },
          { type: 'body', parameters: [
            text(agreement.full_names.split(' ')[0]),
            text(invoice.number),
            text(formatRand(invoice.amount_due_cents)),
            text(formatDate(invoice.due_on)),
            text(paymentReference(agreement)),
          ] },
        ],
      },
    }),
  });
  if (!res.ok) throw new Error(`WhatsApp API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

module.exports = { emailConfigured, whatsappApiConfigured, sendInvoiceEmail, sendInvoiceWhatsApp, whatsappLink, messageText, invoiceUrl, waNumber };
