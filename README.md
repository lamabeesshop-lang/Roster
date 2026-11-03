# SCPF Radio Agreements

A small web app for managing **Radio Sale Agreements** (Kirisun PT570, R1 400 on a 3- or 6-month plan):

- **Agreements**: capture Part A (purchaser) and Part B (radio, serial, plan) from the paper form.
- **Signed agreements**: upload the signed PDF or a photo/scan to each agreement. Files are only visible to logged-in users.
- **Instalment schedule**: the first instalment is due on the signing date and the rest by the last day of each following month. Rounding cents go on the last instalment (R466.66 + R466.66 + R466.68 = R1 400).
- **Payments**: capture payments (reference `CALLSIGN RADIO`). An agreement is marked *paid* automatically once R1 400 is covered.
- **Monthly invoices**: on the *Invoices* page, click **Generate** once a month. Each invoice shows that month's instalment plus any arrears and the FNB payment details, as a PDF.
- **Send by e-mail**: one click e-mails every unsent invoice with the PDF attached.
- **Send by WhatsApp**: click **💬 WhatsApp** on a row. WhatsApp opens with the message and a link to the invoice PDF already filled in, and you press send. You can also turn on fully automatic sending through the WhatsApp Business Cloud API (see below).
- **Team access**: you plus your team members each get their own login. Every action is logged with who did it.
- Dashboard with arrears, the amount outstanding, what was collected this month, and agreements still missing a signed copy.

## Run it

Requires Node.js 20+.

```bash
npm install
cp .env.example .env      # then edit: BASE_URL, SESSION_SECRET, SMTP settings
npm start                 # http://localhost:3000
```

The first visit asks you to create the **administrator** account. Then go to **Team** and add your two team members (username and temporary password). They can change their password after logging in.

All data (SQLite database and uploaded files) lives in `DATA_DIR` (default `./data`). **Back this folder up.**

Run the tests with `npm test`.

## Hosting

Members open invoice links from their phones, so the site must be reachable on the internet over **HTTPS**. Set `BASE_URL` to that address. Any host with a persistent disk works:

- **Docker** (VPS, Railway, Fly.io, Render with a disk): `docker build -t radios . && docker run -p 3000:3000 -v radios-data:/data --env-file .env radios`
- **Plain VPS**: `npm ci --omit=dev && npm start` behind nginx/Caddy (Caddy gives free HTTPS automatically).

Do not use a host without a persistent disk, or the database and uploads are lost on every redeploy.

## E-mail setup

Any SMTP account works. For Gmail/Google Workspace: `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_USER=<address>`, `SMTP_PASS=<App Password>` (create one under Google Account → Security → App passwords). Replies go to `SELLER_EMAIL` (admin@scpf.co.za).

## WhatsApp

**Default (no setup):** click-to-send. The button opens `wa.me/<number>` on your phone or in WhatsApp Web with the invoice message pre-typed, and you press send. Messages come from your own WhatsApp number and cost nothing. Numbers like `082 123 4567` are converted to `27821234567`.

**Optional: automatic sending** through the WhatsApp Business Cloud API (Meta). It needs a Meta Business account, a dedicated phone number, and an approved *utility* message template:

- Header: **Document**
- Body with 5 variables, for example:
  `Good day {{1}}, your SCPF radio invoice {{2}} is attached. Amount due: {{3}} by {{4}}. Please pay into FNB 632 032 095 56 (branch 251037) with reference {{5}} and send proof of payment to admin@scpf.co.za.`

Then set `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` and `WHATSAPP_TEMPLATE` (and `WHATSAPP_TEMPLATE_LANG` if it isn't `en`). **🤖 Auto** buttons and a **WhatsApp all unsent** button then appear. Meta charges per message.

## Notes

- The invoice link sent to members (`/i/<random token>`) opens only that invoice's PDF without logging in. Everything else requires a login.
- Captured a payment after the invoice was made? Use **⋯ → Recalculate** on the invoice before sending it.
- *Terminate* an agreement when the radio is collected for non-payment. It then drops out of monthly invoicing.
- Only administrators can add or remove users and permanently delete agreements.
