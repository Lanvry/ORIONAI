/**
 * Server kecil untuk menangani callback OAuth dari Google
 * Jalankan SEKALI di awal untuk mendapatkan token Google
 * 
 * Usage: node setup/oauth-server.js
 */

const http = require('http');
const url = require('url');
const { getAuthUrl } = require('../src/googleAuth');

const PORT = 3000;

function startOAuthServer() {
  const server = http.createServer(async (req, res) => {
    // Hindari favicon.ico spam
    if (req.url === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }

    const host = req.headers.host || 'localhost:3000';
    const parsedUrl = new URL(req.url, `http://${host}`);

    if (parsedUrl.pathname.endsWith('/oauth/callback')) {
      const code = parsedUrl.searchParams.get('code');

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<h1>❌ Tidak ada kode otorisasi</h1>');
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <html>
          <body style="font-family: sans-serif; text-align: center; padding: 50px; background: #0f172a; color: white;">
            <h1>✅ Autentikasi Google Berhasil!</h1>
            <p>Silakan salin kode rahasia di bawah ini, dan kembali ke aplikasi Telegram.</p>
            <div style="background: #1e293b; padding: 20px; border-radius: 10px; display: inline-block; margin: 20px 0;">
              <code style="font-size: 24px; color: #38bdf8;">${code}</code>
            </div>
            <p>Kirimkan ke bot Orion dengan format:</p>
            <div style="background: #334155; padding: 15px; border-radius: 8px; display: inline-block;">
              <code style="font-size: 18px; color: #4ade80;">/auth ${code}</code>
            </div>
            <p style="margin-top: 40px; color:#94a3b8">Boleh tutup halaman ini setelah disalin.</p>
          </body>
        </html>
      `);
      console.log('[OAuth Client] Seorang user meminta dan berhasil mendapatkan kode otentikasi.');
    } else {
      res.writeHead(302, { Location: getAuthUrl() });
      res.end();
    }
  });

  server.listen(PORT, () => {
    console.log('\n' + '='.repeat(60));
    console.log('🔐  Google OAuth Callbacks Server Running');
    console.log('='.repeat(60));
    console.log(`\n🌐 Mendengarkan callback di:\n   http://localhost:${PORT}\n`);
    console.log('='.repeat(60) + '\n');
  });
}

module.exports = { startOAuthServer };
