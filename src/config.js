require('dotenv').config({ quiet: true });
const path = require('path');

const env = process.env;
const DATA_DIR = path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data'));

module.exports = {
  port: Number(env.PORT || 3000),
  baseUrl: (env.BASE_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
  setupCode: env.SETUP_CODE || '',
  sessionSecret: env.SESSION_SECRET || 'change-me-in-production',
  dataDir: DATA_DIR,
  uploadDir: path.join(DATA_DIR, 'uploads'),
  dbFile: path.join(DATA_DIR, 'radio.db'),

  // Defaults taken from the Radio Sale Agreement (version 20260929)
  seller: {
    name: env.SELLER_NAME || 'Sinoville Community Police Forum',
    shortName: env.SELLER_SHORT_NAME || 'SCPF',
    email: env.SELLER_EMAIL || 'admin@scpf.co.za',
    bank: env.BANK_NAME || 'First National Bank',
    accountName: env.BANK_ACCOUNT_NAME || 'Sinoville Community Police Forum',
    accountNumber: env.BANK_ACCOUNT_NUMBER || '632 032 095 56',
    branchCode: env.BANK_BRANCH_CODE || '251037',
  },
  defaults: {
    radioModel: env.DEFAULT_RADIO_MODEL || 'Kirisun PT570',
    priceCents: Math.round(Number(env.DEFAULT_PRICE || 1400) * 100),
    plans: [3, 6],
  },

  smtp: {
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT || 587),
    secure: env.SMTP_SECURE === 'true',
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: env.MAIL_FROM || env.SMTP_USER,
  },

  // Optional: WhatsApp Cloud API (Meta). Without it, the app uses click-to-send wa.me links.
  whatsapp: {
    token: env.WHATSAPP_TOKEN,
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
    template: env.WHATSAPP_TEMPLATE,
    templateLang: env.WHATSAPP_TEMPLATE_LANG || 'en',
    countryCode: env.DEFAULT_COUNTRY_CODE || '27',
  },
};
