const { Telegraf } = require('telegraf');
const handlers = require('./handlers');

function startTelegramBot() {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.error('❌ TELEGRAM_BOT_TOKEN belum diisi di file .env');
    return null;
  }

  const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
  global.bot = bot;

  handlers.register(bot);

  bot.catch((err, ctx) => {
    console.error(`[Telegram Error] Update ${ctx.updateType}:`, err.message);
    try {
      ctx.reply('⚠️ Terjadi kesalahan. Silakan coba lagi.');
    } catch (_) {}
  });

  bot.launch({ dropPendingUpdates: true })
    .then(() => {})
    .catch((err) => {
      console.error('❌ Gagal menjalankan Telegram bot:', err.message);
    });

  return bot;
}

module.exports = { startTelegramBot };
