const PDFDocument = require('pdfkit');
const config = require('./config');
const { formatRand, formatDate, periodLabel } = require('./money');
const { paymentReference } = require('./billing');

/** Renders an invoice to a PDF Buffer. */
function invoicePdf(invoice, agreement) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Invoice ${invoice.number}` } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const s = config.seller;
    const left = 50;
    const width = doc.page.width - 100;

    doc.fontSize(18).font('Helvetica-Bold').text(s.name, left, 50);
    doc.fontSize(10).font('Helvetica').fillColor('#555').text(`Radio Sale Agreement – ${s.email}`);
    doc.fillColor('#000').fontSize(22).font('Helvetica-Bold').text('INVOICE', left, 50, { width, align: 'right' });
    doc.fontSize(10).font('Helvetica')
      .text(`Invoice no: ${invoice.number}`, { width, align: 'right' })
      .text(`Date: ${formatDate(invoice.issued_on)}`, { width, align: 'right' })
      .text(`Period: ${periodLabel(invoice.period)}`, { width, align: 'right' });

    doc.moveDown(2);
    const y = doc.y;
    doc.font('Helvetica-Bold').text('Bill to', left, y);
    doc.font('Helvetica')
      .text(`${agreement.full_names} ${agreement.surname}`)
      .text(`Call sign: ${agreement.call_sign}`);
    [agreement.address, [agreement.suburb, agreement.postal_code].filter(Boolean).join(' '), agreement.cellphone, agreement.email]
      .filter(Boolean).forEach((l) => doc.text(l));
    doc.font('Helvetica-Bold').text('Radio', 330, y);
    doc.font('Helvetica')
      .text(agreement.radio_model, 330)
      .text(`Serial no: ${agreement.serial_number || '—'}`, 330)
      .text(`Purchase price: ${formatRand(agreement.price_cents)}`, 330)
      .text(`Plan: ${agreement.plan_months} months`, 330)
      .text(`Agreement date: ${formatDate(agreement.start_date)}`, 330);

    doc.moveDown(2);
    let ty = Math.max(doc.y, y + 110);
    const row = (label, amount, bold) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(11);
      doc.text(label, left + 8, ty, { width: width - 140 });
      doc.text(amount, left, ty, { width: width - 8, align: 'right' });
      ty += 22;
    };
    doc.rect(left, ty - 6, width, 22).fill('#eef2f7').fillColor('#000');
    doc.font('Helvetica-Bold').fontSize(10).text('Description', left + 8, ty).text('Amount', left, ty, { width: width - 8, align: 'right' });
    ty += 24;
    row(invoice.instalment_label, formatRand(invoice.instalment_cents));
    if (invoice.arrears_cents > 0) row('Arrears from previous months', formatRand(invoice.arrears_cents));
    doc.moveTo(left, ty - 4).lineTo(left + width, ty - 4).strokeColor('#999').stroke();
    ty += 4;
    row(`Amount due by ${formatDate(invoice.due_on)}`, formatRand(invoice.amount_due_cents), true);
    ty += 6;
    doc.fontSize(10).font('Helvetica').fillColor('#444');
    doc.text(`Paid to date: ${formatRand(invoice.paid_to_date_cents)}     Outstanding on purchase price: ${formatRand(invoice.balance_cents)}`, left + 8, ty);
    doc.fillColor('#000');

    ty += 40;
    doc.rect(left, ty, width, 110).strokeColor('#1f4e79').lineWidth(1.2).stroke();
    doc.font('Helvetica-Bold').fontSize(11).text('Payment details', left + 12, ty + 10);
    doc.font('Helvetica').fontSize(10)
      .text(`Account name: ${s.accountName}`, left + 12, ty + 30)
      .text(`Bank: ${s.bank}`)
      .text(`Account number: ${s.accountNumber}`)
      .text(`Branch code: ${s.branchCode}`);
    doc.font('Helvetica-Bold').text(`Payment reference: ${paymentReference(agreement)}`);

    ty += 130;
    doc.font('Helvetica').fontSize(8.5).fillColor('#555').text(
      'Instalments are due on or before the last day of each month. Ownership of the radio remains with the Seller until the full ' +
      'purchase price has been paid. If an instalment is not paid on the due date, the Seller may demand immediate payment of all ' +
      'outstanding instalments or collect the radio without further notice (Radio Sale Agreement, Part C). ' +
      `Please e-mail proof of payment to ${s.email}.`,
      left, ty, { width });

    doc.end();
  });
}

module.exports = { invoicePdf };
