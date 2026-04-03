require('dotenv').config();
const { Telegraf } = require('telegraf');
const cronJobs = require('./src/cronJobs');
const handlers = require('./src/handlers');

// ── Validasi ENV kritis ───────────────────────────────────────────────────────
if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN belum diisi di file .env');
  process.exit(1);
}

if (!process.env.GEMINI_API_KEY) {
  console.warn('⚠️  GEMINI_API_KEY belum diisi — fitur AI tidak akan berfungsi');
}

if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
  console.warn('⚠️  Google OAuth belum dikonfigurasi — fitur Classroom tidak akan berfungsi');
}

if (!process.env.TELEGRAM_OWNER_ID) {
  console.warn('⚠️  TELEGRAM_OWNER_ID belum diisi — notifikasi otomatis tidak akan terkirim');
  console.warn('    Jalankan bot lalu ketik /start untuk mendapatkan ID kamu.');
}

// ── Init Bot ─────────────────────────────────────────────────────────────────
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Export bot ke global agar bisa diakses dari modul lain
global.bot = bot;

// ── Register Handlers ────────────────────────────────────────────────────────
handlers.register(bot);

// ── Error Handler Global ─────────────────────────────────────────────────────
bot.catch((err, ctx) => {
  console.error(`[Bot Error] Update ${ctx.updateType}:`, err.message);
  try {
    ctx.reply('⚠️ Terjadi kesalahan. Silakan coba lagi.');
  } catch (_) {}
});

// ── Start Cron Jobs ──────────────────────────────────────────────────────────
cronJobs.start();

// ── Launch Bot ───────────────────────────────────────────────────────────────
bot.launch({ dropPendingUpdates: true })
  .then(() => {
    console.log('');
    console.log('╔══════════════════════════════════════╗');
    console.log('║  🤖 Orion AI Agent — RUNNING         ║');
    console.log('╠══════════════════════════════════════╣');
    console.log(`║  📬 Bot Token: ...${process.env.TELEGRAM_BOT_TOKEN.slice(-8)}    ║`);
    console.log(`║  👤 Owner ID: ${process.env.TELEGRAM_OWNER_ID || 'BELUM DIISI       '}    ║`);
    console.log(`║  🧠 Gemini AI: ${process.env.GEMINI_API_KEY ? '✅ OK              ' : '❌ Belum diisi     '}║`);
    console.log(`║  🎓 Google: ${process.env.GOOGLE_CLIENT_ID ? '✅ OK                 ' : '❌ Belum diisi        '}║`);
    console.log('╚══════════════════════════════════════╝');
    console.log('');
  })
  .catch((err) => {
    console.error('❌ Gagal menjalankan bot:', err.message);
    process.exit(1);
  });

// ── Graceful stop ─────────────────────────────────────────────────────────────
process.once('SIGINT', () => {
  console.log('\n👋 Bot dihentikan (SIGINT)');
  bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
  console.log('\n👋 Bot dihentikan (SIGTERM)');
  bot.stop('SIGTERM');
});
