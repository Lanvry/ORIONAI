const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const TOKEN_DIR = path.join(__dirname, '../data/users');

function getTokenPath(userId) {
  if (!fs.existsSync(TOKEN_DIR)) {
    fs.mkdirSync(TOKEN_DIR, { recursive: true });
  }
  return path.join(TOKEN_DIR, `${userId}.json`);
}

const SCOPES = [
  'https://www.googleapis.com/auth/classroom.courses.readonly',
  'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
  'https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly',
  'https://www.googleapis.com/auth/classroom.student-submissions.me.readonly',
  'https://www.googleapis.com/auth/classroom.student-submissions.students.readonly',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive',
];

/**
 * Membuat OAuth2 client
 */
function createOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

/**
 * Generate URL otorisasi Google
 */
function getAuthUrl() {
  const oAuth2Client = createOAuthClient();
  return oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });
}

/**
 * Menyimpan token ke file
 */
async function saveToken(code, userId) {
  const oAuth2Client = createOAuthClient();
  const { tokens } = await oAuth2Client.getToken(code);
  oAuth2Client.setCredentials(tokens);
  
  const tokenPath = getTokenPath(userId);
  fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
  console.log(`✅ Token Google berhasil disimpan untuk user ${userId}.`);
  return oAuth2Client;
}

/**
 * Cek apakah token sudah expired
 */
function isTokenExpired(token) {
  if (!token.expiry_date) return false;
  // Anggap expired jika sisa waktu < 5 menit
  return Date.now() > token.expiry_date - 5 * 60 * 1000;
}

/**
 * Load token dari file & return client yang sudah terautentikasi
 * Auto-refresh token jika expired
 */
async function getAuthenticatedClient(userId) {
  const tokenPath = getTokenPath(userId);
  if (!fs.existsSync(tokenPath)) return null;

  const oAuth2Client = createOAuthClient();
  let token = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));

  // Auto-refresh jika expired
  if (isTokenExpired(token) && token.refresh_token) {
    try {
      oAuth2Client.setCredentials(token);
      const { credentials } = await oAuth2Client.refreshAccessToken();
      token = credentials;
      fs.writeFileSync(tokenPath, JSON.stringify(token, null, 2));
      console.log(`🔄 Token Google berhasil diperbarui untuk user ${userId}.`);
    } catch (err) {
      console.error(`⚠️ Gagal refresh token untuk ${userId}:`, err.message);
      // Tetap coba pakai token lama
    }
  }

  oAuth2Client.setCredentials(token);
  return oAuth2Client;
}

/**
 * Versi sinkron (untuk backward-compat, tidak auto-refresh)
 */
function getAuthenticatedClientSync(userId) {
  const tokenPath = getTokenPath(userId);
  if (!fs.existsSync(tokenPath)) return null;
  const oAuth2Client = createOAuthClient();
  const token = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
  oAuth2Client.setCredentials(token);
  return oAuth2Client;
}

/**
 * Cek apakah sudah login Google
 */
function isAuthenticated(userId) {
  return fs.existsSync(getTokenPath(userId));
}

module.exports = {
  getAuthUrl,
  saveToken,
  getAuthenticatedClient,
  getAuthenticatedClientSync,
  isAuthenticated,
};
