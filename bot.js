require('dotenv').config();
const { startOAuthServer } = require('./setup/oauth-server');
const cronJobs = require('./src/cronJobs');
const { startTelegramBot } = require('./src/telegram/telegramBot');
const { startDiscordBot } = require('./src/discord/discordBot');

// ── Validasi ENV kritis ───────────────────────────────────────────────────────
if (!process.env.GEMINI_API_KEY) {
  console.warn('⚠️  GEMINI_API_KEY belum diisi — fitur AI tidak akan berfungsi');
}
if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
  console.warn('⚠️  Google OAuth belum dikonfigurasi — fitur Classroom tidak akan berfungsi');
}
if (!process.env.TELEGRAM_OWNER_ID) {
  console.warn('⚠️  TELEGRAM_OWNER_ID belum diisi — notifikasi otomatis tidak akan terkirim');
}

const enableTelegram = process.env.ENABLE_TELEGRAM !== 'false'; // Default true unless explicitly false
const enableDiscord = process.env.ENABLE_DISCORD === 'true' || !!process.env.DISCORD_BOT_TOKEN;

console.log('╔══════════════════════════════════════╗');
console.log('║  🤖 Orion AI Agent — BOOTING         ║');
console.log('╠══════════════════════════════════════╣');

let telBot = null;
if (enableTelegram) {
   process.stdout.write('║  ➤ Membaca Telegram Bot...           ');
   telBot = startTelegramBot();
   if (telBot) console.log('✅ OK'); else console.log('❌ FAIL');
   
   // Cronjob butuh global.bot Telegram untuk notifikasi beroperasi
   cronJobs.start();
} else {
   console.log('║  ➤ Telegram Bot                      ❌ DISABLED');
}

if (enableDiscord) {
   process.stdout.write('║  ➤ Membaca Discord Bot...            ');
   const disBot = startDiscordBot();
   if (disBot) console.log('✅ OK'); else console.log('❌ FAIL');
} else {
   console.log('║  ➤ Discord Bot                       ❌ DISABLED');
}

console.log('╚══════════════════════════════════════╝');
console.log('');

// OAuth Web Server
try {
  startOAuthServer();
} catch (e) {
  console.log('⚠️ Gagal memulai OAuth Server:', e.message);
}

// Graceful stop
process.once('SIGINT', () => {
  console.log('\n👋 Aplikasi dihentikan (SIGINT)');
  if (telBot) telBot.stop('SIGINT');
  process.exit(0);
});
process.once('SIGTERM', () => {
  console.log('\n👋 Aplikasi dihentikan (SIGTERM)');
  if (telBot) telBot.stop('SIGTERM');
  process.exit(0);
});
