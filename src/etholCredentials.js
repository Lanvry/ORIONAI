const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CREDS_FILE = path.join(DATA_DIR, 'ethol_credentials.json');
const ALGO = 'aes-256-gcm';

// Pastikan direktori data ada
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function getKey() {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) throw new Error('ENCRYPTION_KEY tidak ditemukan di .env. Tambahkan 64 karakter hex acak.');
  if (key.length !== 64) throw new Error('ENCRYPTION_KEY harus 64 karakter hex (32 bytes).');
  return Buffer.from(key, 'hex');
}

function encrypt(text) {
  const key = getKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Gabungkan iv + authTag + encrypted dalam satu string base64
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

function decrypt(data) {
  const key = getKey();
  const buf = Buffer.from(data, 'base64');
  const iv = buf.slice(0, 16);
  const authTag = buf.slice(16, 32);
  const encrypted = buf.slice(32);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted) + decipher.final('utf8');
}

function loadAll() {
  if (!fs.existsSync(CREDS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveAll(data) {
  fs.writeFileSync(CREDS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Simpan kredensial user (terenkripsi).
 * @param {string|number} userId - Telegram User ID
 * @param {string} email
 * @param {string} password
 */
function saveCredentials(userId, email, password) {
  const all = loadAll();
  all[String(userId)] = {
    email: encrypt(email),
    password: encrypt(password),
    updatedAt: new Date().toISOString()
  };
  saveAll(all);
}

/**
 * Ambil kredensial user (didekripsi).
 * @param {string|number} userId
 * @returns {{ email: string, password: string } | null}
 */
function getCredentials(userId) {
  const all = loadAll();
  const entry = all[String(userId)];
  if (!entry) return null;
  try {
    return {
      email: decrypt(entry.email),
      password: decrypt(entry.password)
    };
  } catch {
    return null; // Kunci enkripsi berubah atau data corrupt
  }
}

/**
 * Hapus kredensial user.
 * @param {string|number} userId
 * @returns {boolean} true jika berhasil dihapus
 */
function deleteCredentials(userId) {
  const all = loadAll();
  if (!all[String(userId)]) return false;
  delete all[String(userId)];
  saveAll(all);
  return true;
}

/**
 * Cek apakah user sudah punya kredensial tersimpan.
 * @param {string|number} userId
 */
function hasCredentials(userId) {
  const all = loadAll();
  return !!all[String(userId)];
}

module.exports = { saveCredentials, getCredentials, deleteCredentials, hasCredentials };
