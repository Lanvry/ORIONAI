/**
 * Server kecil untuk menangani callback OAuth dari Google
 * Jalankan SEKALI di awal untuk mendapatkan token Google
 * 
 * Usage: node setup/oauth-server.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const http = require('http');
const url = require('url');
const { saveToken, getAuthUrl } = require('../src/googleAuth');

const PORT = 3000;

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);

  if (parsedUrl.pathname === '/oauth/callback') {
    const code = parsedUrl.query.code;

    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<h1>❌ Tidak ada kode otorisasi</h1>');
    }

    try {
      await saveToken(code);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <html>
          <body style="font-family: sans-serif; text-align: center; padding: 50px; background: #0f172a; color: white;">
            <h1>✅ Login Google Berhasil!</h1>
            <p>Token telah disimpan. Kamu bisa menutup tab ini dan kembali ke terminal.</p>
            <p style="color:#94a3b8">Sekarang jalankan bot dengan: <code>npm start</code></p>
          </body>
        </html>
      `);
      console.log('\n✅ Token berhasil disimpan! Kamu bisa menutup server ini (Ctrl+C) dan jalankan bot.\n');
      setTimeout(() => server.close(), 2000);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h1>❌ Error: ${err.message}</h1>`);
    }
  } else {
    res.writeHead(302, { Location: getAuthUrl() });
    res.end();
  }
});

server.listen(PORT, () => {
  console.log('\n' + '='.repeat(60));
  console.log('🔐  Google OAuth Setup Server');
  console.log('='.repeat(60));
  console.log(`\n🌐 Buka browser dan akses:\n\n   http://localhost:${PORT}\n`);
  console.log('Ikuti langkah login Google, lalu tunggu konfirmasi di sini.');
  console.log('='.repeat(60) + '\n');
});
