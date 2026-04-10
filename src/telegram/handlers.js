const { getAuthUrl, saveToken, isAuthenticated } = require('../googleAuth');
const {
  getPendingAssignments,
  refreshAssignments,
  submitAssignment,
  uploadFileToDrive,
  finalizeSubmission,
  getCourses,
  getCourseStream,
} = require('../classroomService');
const {
  formatAssignmentList,
  formatAssignmentMessage,
  formatAssignmentDetail,
  getMimeType,
  escapeMd,
  formatStreamItemDetail,
} = require('../utils');
const { saveCredentials, getCredentials, deleteCredentials, hasCredentials } = require('../etholCredentials');
const { agenticQueue } = require('../agenticQueue');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');

// In-memory state untuk alur setup multi-step /ethollogin
// key: userId (string), value: { step: 'email'|'password', email?: string }
const pendingEtholSetup = new Map();


// ─── Safe Edit Message (ignore "not modified" error, log sisanya) ─────────────
async function safeEdit(ctx, msgId, text, opts) {
  try {
    await ctx.telegram.editMessageText(ctx.chat.id, msgId, null, text, opts || {});
  } catch (err) {
    if (err.message && err.message.includes('message is not modified')) return;
    
    // Fallback jika formatting markdown cacat dari bawaan AI
    if (err.message && err.message.includes("can't parse entities") && (opts && opts.parse_mode)) {
      try {
        const plainOpts = Object.assign({}, opts);
        delete plainOpts.parse_mode;
        await ctx.telegram.editMessageText(ctx.chat.id, msgId, null, text, plainOpts);
      } catch (err2) {
        if (!err2.message?.includes('modified')) console.error('[safeEdit Plain Error]', err2.message);
      }
      return;
    }
    
    console.error('[safeEdit Error]', err.message ? err.message.slice(0, 120) : err);
  }
}

// ─── State Sementara Per User ─────────────────────────────────────────────────
const userState = {}; // { [chatId]: { step, assignments, selectedAssignment } }

const { askAI, ringkasAssignment } = require('../aiService');
// ─── Download File dari Telegram ─────────────────────────────────────────────
async function downloadTelegramFile(fileId, fileName) {
  const bot = global.bot;
  const fileInfo = await bot.telegram.getFile(fileId);
  const fileUrl = 'https://api.telegram.org/file/bot' + process.env.TELEGRAM_BOT_TOKEN + '/' + fileInfo.file_path;

  const tempPath = path.join(os.tmpdir(), fileName);
  const response = await axios({ method: 'GET', url: fileUrl, responseType: 'stream' });

  return new Promise(function(resolve, reject) {
    const writer = fs.createWriteStream(tempPath);
    response.data.pipe(writer);
    writer.on('finish', function() { resolve(tempPath); });
    writer.on('error', reject);
  });
}

const { Markup } = require('telegraf');

// ─── Keyboard Menu Utama ──────────────────────────────────────────────────────
const mainMenuKeyboard = {
  reply_markup: {
    keyboard: [
      [{ text: '\uD83D\uDCCB Daftar Tugas' }, { text: '\uD83D\uDD17 Login Google' }],
      [{ text: '\u2705 Kumpulkan Tugas' }, { text: '\uD83E\uDD16 Tanya AI' }],
      [{ text: '\uD83D\uDCDA Daftar Mapel' }, { text: '\uD83C\uDF93 Absen ETHOL' }],
      [{ text: '📖 Lihat Materi' }, { text: '📅 Lihat Jadwal' }],
      [{ text: '\u2753 Bantuan' }, { text: '\u274C Tutup Menu' }]
    ],
    resize_keyboard: true,
    is_persistent: false
  }
};

// Keyboard minimal hanya tombol buka menu
const openMenuKeyboard = {
  reply_markup: {
    keyboard: [[{ text: '\uD83D\uDCCB Buka Menu' }]],
    resize_keyboard: true,
    is_persistent: true
  }
};

// ─── Register Semua Command & Handler ────────────────────────────────────────
function register(bot) {

  // /start
  bot.start(async function(ctx) {
    const name = escapeMd(ctx.from.first_name || 'Kak');
    const ownerId = ctx.from.id;
    await ctx.reply(
      '\uD83D\uDC4B Halo, *' + name + '*! Saya *Orion* \u2014 asisten AI akademis pribadimu.\n\n' +
      '\uD83D\uDCCC *ID Telegram kamu:* `' + ownerId + '`\n' +
      '\n\n' +
      '\u2728 Aku bisa:\n' +
      '\u2022 Cek & notifikasi tugas Classroom\n' +
      '\u2022 Kumpulkan tugas langsung dari Telegram\n' +
      '\u2022 Ringkaskan deskripsi tugas\n' +
      '\u2022 Jawab pertanyaan pelajaran apa saja\n\n' +
      'Pilih menu di bawah untuk memulai:',
      {
        parse_mode: 'Markdown',
        reply_markup: mainMenuKeyboard.reply_markup
      }
    );
  });

  // /help atau tombol Bantuan
  bot.hears(['\u2753 Bantuan', '/help'], async function(ctx) {
    await ctx.reply(
      '\uD83E\uDD16 Orion - Panduan Penggunaan\n\n' +
      '\uD83D\uDCCB Daftar Tugas - Lihat semua tugas yang belum dikumpulkan\n' +
      '\uD83D\uDD17 Login Google - Hubungkan akun Google untuk akses Classroom\n' +
      '\u2705 Kumpulkan Tugas - Upload file langsung dari Telegram ke Classroom\n' +
      '\uD83E\uDD16 Tanya AI - Ngobrol atau tanya apa saja ke AI\n' +
      '\uD83D\uDCDA Daftar Mapel - Lihat semua mata kuliah aktif\n' +
      '\uD83C\uDF93 Absen ETHOL - Otomatis eksekusi absen di ETHOL PENS (dianalisa AI)\n\n' +
      'Perintah khusus:\n' +
      '/detail <nomor> - Detail lengkap tugas\n' +
      '/ringkas <nomor> - AI ringkaskan tugas untuk kamu\n' +
      '/refresh - Paksa refresh data dari Classroom\n\n' +
      'Cara kumpulkan tugas:\n' +
      '1. Tekan tombol Kumpulkan Tugas\n' +
      '2. Pilih tugas dari daftar\n' +
      '3. Kirim file-nya ke sini\n' +
      '4. Bot akan otomatis upload & kumpulkan ke Classroom\n\n' +
      '🔐 Perintah ETHOL:\n' +
      '/ethollogin - Setup kredensial ETHOL Anda (aman & terenkripsi)\n' +
      '/ethollogout - Hapus kredensial ETHOL Anda'
    );
  });

  // ─── ETHOL Login Setup ─────────────────────────────────────────────────────
  bot.command('ethollogin', async (ctx) => {
    const userId = String(ctx.from.id);
    if (hasCredentials(userId)) {
      pendingEtholSetup.set(userId, { step: 'confirm_overwrite' });
      return ctx.reply(
        '⚠️ Anda sudah punya kredensial ETHOL yang tersimpan.\n\nKirim *ya* untuk menggantinya, atau *batal* untuk membatalkan.',
        { parse_mode: 'Markdown' }
      );
    }
    pendingEtholSetup.set(userId, { step: 'email' });
    await ctx.reply('🔐 *Setup ETHOL Login*\n\nLangkah 1/2: Kirim *email* ETHOL Anda:\n_(Contoh: 123456@student.pens.ac.id)_', { parse_mode: 'Markdown' });
  });

  bot.command('ethollogout', async (ctx) => {
    const userId = String(ctx.from.id);
    const deleted = deleteCredentials(userId);
    if (deleted) {
      await ctx.reply('✅ Kredensial ETHOL Anda telah dihapus dari sistem.');
    } else {
      await ctx.reply('ℹ️ Tidak ada kredensial ETHOL yang tersimpan untuk akun Anda.');
    }
  });

  // ─── Handler pesan multi-step untuk /ethollogin ────────────────────────────
  bot.on('text', async (ctx, next) => {
    const userId = String(ctx.from.id);
    const state = pendingEtholSetup.get(userId);
    if (!state) return next(); // bukan sedang dalam alur setup, lanjutkan ke handler lain

    const text = ctx.message.text.trim();

    if (state.step === 'confirm_overwrite') {
      if (text.toLowerCase() === 'ya') {
        pendingEtholSetup.set(userId, { step: 'email' });
        return ctx.reply('📧 Kirim *email* ETHOL baru Anda:', { parse_mode: 'Markdown' });
      } else {
        pendingEtholSetup.delete(userId);
        return ctx.reply('❌ Dibatalkan. Kredensial lama tetap tersimpan.');
      }
    }

    if (state.step === 'email') {
      if (!text.includes('@')) {
        return ctx.reply('⚠️ Format email tidak valid. Coba lagi:');
      }
      pendingEtholSetup.set(userId, { step: 'password', email: text });
      return ctx.reply(
        '🔑 Langkah 2/2: Kirim *password* ETHOL Anda:\n_(Pesan ini akan langsung dihapus setelah tersimpan)_',
        { parse_mode: 'Markdown' }
      );
    }

    if (state.step === 'password') {
      const { email } = state;
      // Hapus pesan password user SESEGERA MUNGKIN
      await ctx.deleteMessage(ctx.message.message_id).catch(() => {});
      try {
        saveCredentials(userId, email, text);
        pendingEtholSetup.delete(userId);
        await ctx.reply(
          '✅ *Kredensial ETHOL berhasil disimpan!*\n\n🔐 Email dan password Anda dienkripsi dengan AES-256 dan disimpan secara lokal.\n\nSekarang Anda bisa menggunakan 🎓 *Absen ETHOL*!',
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        pendingEtholSetup.delete(userId);
        await ctx.reply('❌ Gagal menyimpan kredensial: ' + err.message);
      }
      return;
    }

    return next();
  });

  // /login atau tombol Login Google
  bot.hears(['\uD83D\uDD17 Login Google', '/login'], async function(ctx) {
    if (!process.env.GOOGLE_CLIENT_ID) {
      return ctx.reply('Mohon isi GOOGLE_CLIENT_ID di file .env terlebih dahulu.');
    }
    const url = getAuthUrl();
    await ctx.reply(
      '\uD83D\uDD17 Login Google Classroom\n\n' +
      'Klik link berikut untuk memberikan akses ke bot:\n' + url + '\n\n' +
      'Setelah login, salin kode dari URL dan kirim ke sini dengan format:\n' +
      '/auth KODE_YANG_DISALIN'
    );
  });

  // /auth <code>
  bot.command('auth', async function(ctx) {
    const code = ctx.message.text.split(' ').slice(1).join(' ').trim();
    if (!code) return ctx.reply('Format: /auth KODE_OTORISASI');
    const userId = ctx.from.id;

    try {
      await ctx.reply('\uD83D\uDD04 Memverifikasi kode...');
      await saveToken(code, userId);
      await ctx.reply('\u2705 Login Google berhasil! Sekarang Orion bisa mengakses Classroom kamu.', mainMenuKeyboard);
    } catch (err) {
      await ctx.reply('Gagal login: ' + err.message);
    }
  });

  // /refresh
  bot.command('refresh', async function(ctx) {
    const userId = ctx.from.id;
    if (!isAuthenticated(userId)) return ctx.reply('Belum login Google.');
    const msg = await ctx.reply('\uD83D\uDD04 Memperbarui data dari Classroom...');
    try {
      const assignments = await refreshAssignments(userId);
      await safeEdit(ctx, msg.message_id, '\u2705 Data diperbarui! Ditemukan ' + assignments.length + ' tugas aktif.');
    } catch (err) {
      await safeEdit(ctx, msg.message_id, 'Gagal refresh: ' + err.message);
    }
  });

  // ─── Tutup & Buka Menu ───────────────────────────────────────────────────────
  bot.hears('❌ Tutup Menu', async (ctx) => {
    await ctx.reply('Menu disembunyikan. Ketik *Buka Menu* atau /menu untuk membukanya kembali.', {
      parse_mode: 'Markdown',
      reply_markup: {
        keyboard: [[{ text: '📋 Buka Menu' }]],
        resize_keyboard: true,
        is_persistent: true
      }
    });
  });

  bot.hears(['📋 Buka Menu', '/menu'], async (ctx) => {
    await ctx.reply('Menu dibuka kembali! 👋', mainMenuKeyboard);
  });

  // Daftar Tugas
  bot.hears(['\uD83D\uDCCB Daftar Tugas', '/tugas'], async function(ctx) {
    const userId = ctx.from.id;
    if (!isAuthenticated(userId)) {
      return ctx.reply('Kamu belum login Google. Tekan Login Google terlebih dahulu.');
    }
    const loadingMsg = await ctx.reply('\uD83D\uDD04 Sedang mengambil data tugas dari Classroom...');
    try {
      const { getAllAssignments } = require('../classroomService');
      const assignmentsObj = await getAllAssignments(userId);
      await safeEdit(ctx, loadingMsg.message_id, formatAssignmentList(assignmentsObj), { parse_mode: 'Markdown', disable_web_page_preview: true });
    } catch (err) {
      await safeEdit(ctx, loadingMsg.message_id, 'Gagal mengambil tugas: ' + err.message);
    }
  });

  // /detail <nomor>
  bot.command('detail', async function(ctx) {
    const userId = ctx.from.id;
    if (!isAuthenticated(userId)) return ctx.reply('Belum login Google.');
    const numStr = ctx.message.text.split(' ')[1];
    const num = parseInt(numStr);
    if (!numStr || isNaN(num)) {
      return ctx.reply('Format: /detail <nomor>\nContoh: /detail 1\n\nGunakan Daftar Tugas untuk lihat nomor tugas.');
    }
    const loadingMsg = await ctx.reply('\uD83D\uDD04 Mengambil detail tugas...');
    try {
      const assignments = await getPendingAssignments(userId);
      if (num < 1 || num > assignments.length) {
        return safeEdit(ctx, loadingMsg.message_id, 'Nomor tidak valid. Kamu punya ' + assignments.length + ' tugas aktif.');
      }
      const a = assignments[num - 1];
      await safeEdit(ctx, loadingMsg.message_id, formatAssignmentDetail(a), { parse_mode: 'Markdown', disable_web_page_preview: true });
    } catch (err) {
      await safeEdit(ctx, loadingMsg.message_id, 'Error: ' + err.message);
    }
  });

  // /ringkas <nomor>
  bot.command('ringkas', async function(ctx) {
    const userId = ctx.from.id;
    if (!isAuthenticated(userId)) return ctx.reply('Belum login Google.');
    const numStr = ctx.message.text.split(' ')[1];
    const num = parseInt(numStr);
    if (!numStr || isNaN(num)) {
      return ctx.reply('Format: /ringkas <nomor>\nContoh: /ringkas 1\n\nGunakan Daftar Tugas untuk lihat nomor tugas.');
    }
    const loadingMsg = await ctx.reply('\uD83E\uDD16 AI sedang membaca deskripsi tugas...');
    
    (async () => {
      try {
        const assignments = await getPendingAssignments(userId);
        if (num < 1 || num > assignments.length) {
          return safeEdit(ctx, loadingMsg.message_id, 'Nomor tidak valid. Kamu punya ' + assignments.length + ' tugas aktif.');
        }
        const a = assignments[num - 1];
        const ringkasan = await ringkasAssignment(a, async (streamingText) => {
          await safeEdit(ctx, loadingMsg.message_id, '\uD83E\uDD16 AI sedang meringkas tugas...\n\n_...mengetik..._', { parse_mode: 'Markdown' });
        });
        await safeEdit(ctx, loadingMsg.message_id, '\uD83D\uDCDD Ringkasan: *' + a.title + '*\n\n' + ringkasan, { parse_mode: 'Markdown' });
      } catch (err) {
        await safeEdit(ctx, loadingMsg.message_id, 'Error: ' + err.message);
      }
    })();
  });

  // ─── Absen ETHOL dengan Puppeteer + AI Vision ────────────────────────────────
  bot.hears(['\uD83C\uDF93 Absen ETHOL', '/absen'], async function(ctx) {
    const userId = String(ctx.from.id);
    const creds = getCredentials(userId);

    if (!creds) {
      return ctx.reply(
        '⚠️ Kredensial ETHOL Anda belum disimpan.\n\nGunakan perintah /ethollogin untuk menyimpan email dan password ETHOL Anda dengan aman.',
        { parse_mode: 'Markdown' }
      );
    }

    const { email, password } = creds;

    const chatId = ctx.chat.id;
    const loadingMsg = await ctx.reply('🚀 Membuka portal akademik untuk memindai daftar absensi...');

    (async () => {
      try {
        const queuePosition = agenticQueue.length;
        if (agenticQueue.isProcessing) {
            await safeEdit(ctx, loadingMsg.message_id, `⏳ *Sistem sedang memproses antrean...*\nKamu berada di urutan antrean ke-${queuePosition + 1}. Mohon tunggu sejenak.`, { parse_mode: 'Markdown' });
        }
        
        const { loginAndCheckEthol } = require('../etholService');
        
        const result = await agenticQueue.enqueue(() => loginAndCheckEthol(email, password, async (text) => {
          await safeEdit(ctx, loadingMsg.message_id, `🚀 *Status:* ${text}`, { parse_mode: 'Markdown' });
        }, 'scan'), userId);

        if (!result.success) {
          return await safeEdit(ctx, loadingMsg.message_id, `❌ *Gagal Scraping:* ${result.error}`, { parse_mode: 'Markdown' });
        }

        if (result.courses && result.courses.length > 0) {
          // Telegraf Inline Keyboard
          const buttons = result.courses.map(c => [{ text: c, callback_data: `absen_exec_${c.substring(0, 40)}` }]);
          
          await safeEdit(ctx, loadingMsg.message_id, `✅ *Terdapat Mata Kuliah yang bisa di-absen!*\n\nSilakan klik salah satu mata kuliah di bawah untuk mengonfirmasi kehadiran Anda:`, { 
             parse_mode: 'Markdown',
             reply_markup: { inline_keyboard: buttons }
          });
        } else {
           await ctx.telegram.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
           if (result.screenshot) {
             await ctx.replyWithPhoto(
               { source: result.screenshot },
               { caption: `✅ Pemindaian selesai. *Tidak ada jadwal presensi aktif* yang terdeteksi di dropdown notifikasi. Berikut adalah tangkapan layar lonceng notifikasi Anda.`, parse_mode: 'Markdown' }
             );
           } else {
             await ctx.reply(`✅ Pemindaian selesai. *Tidak ada jadwal presensi aktif* yang terdeteksi di notifikasi Anda saat ini.`, { parse_mode: 'Markdown' });
           }
        }
      } catch (err) {
        await safeEdit(ctx, loadingMsg.message_id, 'Error Absen: ' + err.message);
      }
    })();
  });

  // Action Eksekusi Absen
  bot.action(/^absen_exec_(.+)$/, async (ctx) => {
    const targetCourse = ctx.match[1];
    const chatId = ctx.chat.id;
    
    // Matikan tombol loading supaya tidak di-klik double
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    await ctx.answerCbQuery('Menjalankan eksekusi...').catch(() => {});
    
    const userId = String(ctx.from.id);
    const creds = getCredentials(userId);
    if (!creds) {
      return ctx.reply('⚠️ Kredensial ETHOL belum tersimpan. Gunakan /ethollogin terlebih dahulu.');
    }
    const { email, password } = creds;

    const loadingMsg = await ctx.reply(`🚀 Mengeksekusi presensi untuk *${targetCourse}*...\n\n_Bot akan mengirim foto di setiap langkah._`, { parse_mode: 'Markdown' });


    (async () => {
      try {
        const queuePosition = agenticQueue.length;
        if (agenticQueue.isProcessing) {
            await safeEdit(ctx, loadingMsg.message_id, `⏳ *Sistem sedang mengeksekusi presensi...*\nKamu berada di urutan antrean ke-${queuePosition + 1}. Mohon tunggu sejenak.`, { parse_mode: 'Markdown' });
        }
        const { loginAndCheckEthol } = require('../etholService');
        
        const result = await agenticQueue.enqueue(() => loginAndCheckEthol(
          email, 
          password, 
          async (text) => {
            await safeEdit(ctx, loadingMsg.message_id, `🚀 *Status:* ${text}`, { parse_mode: 'Markdown' });
          }, 
          'execute', 
          targetCourse,
          async (screenshotBuffer, caption) => {
            // Kirim foto langsung ke chat tanpa menghapus pesan loading
            await ctx.replyWithPhoto({ source: screenshotBuffer }, { caption, parse_mode: 'Markdown' }).catch(() => {});
          }
        ), userId);

        if (!result.success) {
          return await safeEdit(ctx, loadingMsg.message_id, `❌ *Gagal Scraping:* ${result.error}`, { parse_mode: 'Markdown' });
        }

        // Tentukan pesan akhir berdasarkan status tombol
        const isClosed = result.btnStatus && result.btnStatus.startsWith('CLOSED:');
        const isClicked = result.btnStatus && !result.btnStatus.startsWith('CLOSED:');

        await ctx.telegram.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
        
        if (isClicked) {
          await ctx.replyWithPhoto(
            { source: result.screenshot }, 
            { caption: `✅ *Absensi Berhasil!*\nBukti kehadiran untuk *${targetCourse}* telah dikonfirmasi.`, parse_mode: 'Markdown' }
          );
        } else if (isClosed) {
          await ctx.replyWithPhoto(
            { source: result.screenshot }, 
            { caption: `🔒 *Absensi Sudah Ditutup!*\nTombol presensi untuk *${targetCourse}* berwarna abu-abu. Dosen sudah menutup portal kehadiran.`, parse_mode: 'Markdown' }
          );
        } else {
          await ctx.replyWithPhoto(
            { source: result.screenshot }, 
            { caption: `⚠️ *Tombol Presensi Tidak Ditemukan*\nLog: ${result.logs.slice(-2).join(', ')}`, parse_mode: 'Markdown' }
          );
        }

      } catch (err) {
        await safeEdit(ctx, loadingMsg.message_id, 'Error Eksekusi Absen: ' + err.message);
      }
    })();
  });

  // ─── Flow Lihat Materi ──────────────────────────────────────────────────
  bot.hears(['📖 Lihat Materi', '/materi'], async function(ctx) {
    const userId = ctx.from.id;
    const chatId = ctx.chat.id;
    if (!isAuthenticated(userId)) {
      return ctx.reply('Kamu belum login Google. Tekan Login Google terlebih dahulu.');
    }
    const loadingMsg = await ctx.reply('⏳ Memuat daftar mata kuliah...');
    try {
      const courses = await getCourses(userId);
      if (!courses.length) {
         return safeEdit(ctx, loadingMsg.message_id, 'Tidak ada mata kuliah aktif.');
      }
      
      userState[chatId] = { step: 'SELECT_MATERI_COURSE', courses: courses };
      const buttons = courses.map((c, i) => [`${i + 1}. ${c.name}`]);
      buttons.push(['\u274C Batal']);
      
      await ctx.telegram.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
      await ctx.reply('📚 *PILIH MATA KULIAH*', {
        parse_mode: 'Markdown',
        reply_markup: {
          keyboard: buttons,
          resize_keyboard: true,
          one_time_keyboard: true
        }
      });
    } catch (err) {
      await safeEdit(ctx, loadingMsg.message_id, 'Error: ' + err.message);
    }
  });

  // ─── Flow Lihat Jadwal MIS PENS ─────────────────────────────────────────
  bot.hears(['📅 Lihat Jadwal', '/jadwal'], async function(ctx) {
    const userId = String(ctx.from.id);
    const creds = getCredentials(userId);

    if (!creds) {
      return ctx.reply(
        '⚠️ Kredensial belum disimpan.\n\nGunakan perintah /ethollogin untuk menyimpan email dan password secara aman (kredensial ini juga digunakan untuk MIS PENS).',
        { parse_mode: 'Markdown' }
      );
    }

    const { email, password } = creds;
    const loadingMsg = await ctx.reply('🚀 Membuka portal Akademik MIS PENS...', { parse_mode: 'Markdown' });

    (async () => {
      try {
        const queuePosition = agenticQueue.length;
        if (agenticQueue.isProcessing) {
            await safeEdit(ctx, loadingMsg.message_id, `⏳ *Sistem sedang memproses antrean...*\nKamu berada di urutan antrean ke-${queuePosition + 1}. Mohon tunggu sejenak.`, { parse_mode: 'Markdown' });
        }
        const { getScheduleMis } = require('../misService');
        
        const result = await agenticQueue.enqueue(() => getScheduleMis(email, password, async (text) => {
           await safeEdit(ctx, loadingMsg.message_id, `🚀 *Status:* ${text}`, { parse_mode: 'Markdown' });
        }), userId);

        await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});

        if (!result.success) {
           let errMsg = `❌ *Gagal Scraping Jadwal:* ${result.error}`;
           if (result.screenshot) {
              await ctx.replyWithPhoto(
                { source: result.screenshot },
                { caption: errMsg, parse_mode: 'Markdown' }
              );
           } else {
              await ctx.reply(errMsg, { parse_mode: 'Markdown' });
           }
           return;
        }

        await ctx.replyWithPhoto(
          { source: result.screenshot },
          { caption: '✅ *Jadwal Kuliah per-semester berhasil diambil!*', parse_mode: 'Markdown' }
        );

      } catch (err) {
        await safeEdit(ctx, loadingMsg.message_id, 'Error Lihat Jadwal: ' + err.message);
      }
    })();
  });

  // Daftar Mapel
  bot.hears(['\uD83D\uDCDA Daftar Mapel', '/mapel'], async function(ctx) {
    const userId = ctx.from.id;
    if (!isAuthenticated(userId)) {
      return ctx.reply('Kamu belum login Google. Tekan Login Google terlebih dahulu.');
    }
    try {
      const courses = await getCourses(userId);
      if (!courses.length) return ctx.reply('Tidak ada mata kuliah aktif.');
      let msg = '\uD83D\uDCDA MATA KULIAH AKTIF\n\n';
      courses.forEach(function(c, i) {
        msg += (i + 1) + '. ' + c.name;
        if (c.section) msg += ' - ' + c.section;
        msg += '\n';
      });
      await ctx.reply(msg);
    } catch (err) {
      await ctx.reply('Error: ' + err.message);
    }
  });

  // ─── Flow Kumpulkan Tugas ──────────────────────────────────────────────────
  bot.hears(['\u2705 Kumpulkan Tugas', '/kumpulkan'], async function(ctx) {
    const userId = ctx.from.id;
    if (!isAuthenticated(userId)) {
      return ctx.reply('Kamu belum login Google. Tekan Login Google terlebih dahulu.');
    }
    const chatId = ctx.chat.id;
    const loadingMsg = await ctx.reply('\uD83D\uDD04 Sedang memuat daftar tugas...');
    try {
      const assignments = await getPendingAssignments(userId);
      if (!assignments.length) {
        await safeEdit(ctx, loadingMsg.message_id, '\u2705 Tidak ada tugas yang perlu dikumpulkan!');
        return;
      }
      userState[chatId] = { step: 'SELECT_ASSIGNMENT', assignments: assignments };
      const buttons = assignments.map(function(a, i) {
        return [(i + 1) + '. ' + a.title + ' (' + a.courseName + ')'];
      });
      buttons.push(['\u274C Batal']);
      await safeEdit(ctx, loadingMsg.message_id, '\uD83D\uDCCB Pilih tugas yang ingin dikumpulkan:');
      await ctx.reply('Ketik nomor tugas (1-' + assignments.length + '):', {
        reply_markup: {
          keyboard: buttons,
          resize_keyboard: true,
          one_time_keyboard: true,
        }
      });
    } catch (err) {
      await safeEdit(ctx, loadingMsg.message_id, 'Error: ' + err.message);
    }
  });

  // ─── Tanya AI ─────────────────────────────────────────────────────────────
  bot.hears(['\uD83E\uDD16 Tanya AI', '/ai'], async function(ctx) {
    const chatId = ctx.chat.id;
    userState[chatId] = { step: 'AI_CHAT' };
    await ctx.reply(
      '\uD83E\uDD16 Mode Orion AI aktif! Tanyakan apa saja.\n\nKetik "selesai" atau tekan Kembali ke Menu untuk keluar.',
      { reply_markup: { keyboard: [['\uD83D\uDD19 Kembali ke Menu']], resize_keyboard: true } }
    );
  });

  // Kembali ke menu
  bot.hears(['\uD83D\uDD19 Kembali ke Menu', '/done', 'selesai', '\u274C Batal'], async function(ctx) {
    const chatId = ctx.chat.id;
    delete userState[chatId];
    await ctx.reply('\uD83C\uDFE0 Kembali ke menu utama.', mainMenuKeyboard);
  });

  // Tombol konfirmasi kumpulkan multi-file
  bot.hears('\u2705 Kumpulkan', async function(ctx) {
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;
    const state = userState[chatId];

    if (!state || state.step !== 'WAIT_FILE') {
      return ctx.reply('Tidak ada tugas yang sedang dalam antrian pengumpulan.');
    }

    const assignment = state.selectedAssignment;
    const pendingFiles = state.pendingFiles || [];

    if (!pendingFiles.length) {
      return ctx.reply('⚠️ Belum ada file yang dikirim! Kirim file terlebih dahulu lalu tekan Kumpulkan.');
    }

    const statusMsg = await ctx.reply(`📤 Mengupload ${pendingFiles.length} file ke Google Drive...`, { reply_markup: { remove_keyboard: true } });

    (async () => {
      const tempPaths = [];
      try {
        const uploadedFiles = [];
        
        for (let i = 0; i < pendingFiles.length; i++) {
          const { fileId, fileName, mimeType } = pendingFiles[i];
          await safeEdit(ctx, statusMsg.message_id, `📤 Mengupload file ${i + 1}/${pendingFiles.length}: ${fileName}...`);
          const tempPath = await downloadTelegramFile(fileId, `${Date.now()}_${fileName}`);
          tempPaths.push(tempPath);
          const uploaded = await uploadFileToDrive(userId, tempPath, fileName, mimeType);
          uploadedFiles.push(uploaded);
        }

        await safeEdit(ctx, statusMsg.message_id, '📤 Menghubungkan ke Classroom...');
        const result = await finalizeSubmission(userId, assignment.courseId, assignment.courseWorkId, assignment.submissionId, uploadedFiles);

        // Cleanup temp files
        for (const p of tempPaths) {
          try { fs.unlinkSync(p); } catch (e) {}
        }
        delete userState[chatId];

        const fileLinks = uploadedFiles.map((f, i) => `${i + 1}. [${escapeMd(f.fileName)}](${f.fileLink})`).join('\n');

        if (result && result.attached && !result.turnedIn) {
          // File terlampir ke Classroom tapi Turn In gagal – user cukup klik Serahkan
          await safeEdit(ctx, statusMsg.message_id, '\u2705 File terlampir! Tinggal klik Serahkan.');
          await ctx.reply(
            '\u2705 *File berhasil dilampirkan ke tugas Classroom!*\n\n' +
            '\ud83d\udccc *Tugas:* ' + escapeMd(assignment.title) + '\n' +
            '\ud83d\udcda *Mapel:* ' + escapeMd(assignment.courseName) + '\n\n' +
            '\ud83d\udcce *File terlampir:*\n' + fileLinks + '\n\n' +
            '\ud83d\udd14 *Satu langkah terakhir:*\n' +
            'File sudah ada di halaman tugasmu. Buka dan klik *Serahkan*:\n\n' +
            '\ud83d\udd17 [Buka Tugas & Klik Serahkan](' + assignment.alternateLink + ')',
            { parse_mode: 'Markdown', disable_web_page_preview: true }
          );
        } else if (result && !result.attached) {
          // modifyAttachments juga gagal – file hanya di Drive
          await safeEdit(ctx, statusMsg.message_id, '\u26a0\ufe0f File di Drive. Perlu add manual ke Classroom.');
          await ctx.reply(
            '\u26a0\ufe0f *File berhasil diupload ke Google Drive!*\n\n' +
            '\ud83d\udccc *Tugas:* ' + escapeMd(assignment.title) + '\n' +
            '\ud83d\udcda *Mapel:* ' + escapeMd(assignment.courseName) + '\n\n' +
            '\ud83d\udcce *File di Drive (klik untuk buka):*\n' + fileLinks + '\n\n' +
            '\ud83d\udd14 *Cara attach ke Classroom:*\n' +
            '1. Buka tugas di Classroom (link bawah)\n' +
            '2. Klik *Tambahkan atau buat* \u2192 *Google Drive*\n' +
            '3. Pilih file yang sudah diupload tadi\n' +
            '4. Klik *Serahkan*\n\n' +
            '\ud83d\udd17 [Buka Tugas di Classroom](' + assignment.alternateLink + ')',
            { parse_mode: 'Markdown', disable_web_page_preview: true }
          );
        } else {
          // Fully submitted!
          await safeEdit(ctx, statusMsg.message_id, '\u2705 Tugas berhasil dikumpulkan!');
          await ctx.reply(
            '\u2705 *Tugas berhasil dikumpulkan!*\n\n' +
            '\ud83d\udccc *Tugas:* ' + escapeMd(assignment.title) + '\n' +
            '\ud83d\udcda *Mapel:* ' + escapeMd(assignment.courseName) + '\n\n' +
            '\ud83d\udcce *File yang dikumpulkan:*\n' + fileLinks,
            { parse_mode: 'Markdown', disable_web_page_preview: true }
          );
        }

        await ctx.reply('Kembali ke menu utama:', mainMenuKeyboard);
      } catch (err) {
        for (const p of tempPaths) {
          try { fs.unlinkSync(p); } catch (e) {}
        }
        await safeEdit(ctx, statusMsg.message_id, '❌ Gagal mengupload.');
        await ctx.reply('❌ Gagal mengumpulkan tugas:\n' + err.message);
        await ctx.reply('Kembali ke menu utama:', mainMenuKeyboard);
        delete userState[chatId];
      }
    })();
  });



  // ─── Agentic Web Automation ────────────────────────────────
  bot.command('browse', async function(ctx) {
    const text = ctx.message.text;
    const parts = text.split(' ');
    if (parts.length < 3) {
      return ctx.reply('Format salah!\nGunakan: /browse <URL> <Instruksi>\n\nContoh: /browse https://google.com cari berita tentang AI terbaru');
    }
    
    const url = parts[1];
    if (!url.startsWith('http')) return ctx.reply('URL harus diawali dengan http:// atau https://');
    
    const instruction = parts.slice(2).join(' ');
    const userId = String(ctx.from.id);
    
    const loadingMsg = await ctx.reply('🚀 Menjalankan Orion Web Agent...\n\nTarget: ' + url + '\nMisi: ' + instruction);
    
    try {
      const queuePosition = agenticQueue.length;
      if (agenticQueue.isProcessing) {
          await safeEdit(ctx, loadingMsg.message_id, `⏳ *Sistem sedang memproses antrean...*\nKamu berada di urutan antrean ke-${queuePosition + 1}. Mohon tunggu sejenak.`, { parse_mode: 'Markdown' });
      }
      const { executeAgenticTask } = require('../agenticBrowser');
      await agenticQueue.enqueue(() => executeAgenticTask(
        url,
        instruction,
        async (progressText) => {
          await safeEdit(ctx, loadingMsg.message_id, `🤖 *Web Agent Status:*\n${progressText}`, { parse_mode: 'Markdown' });
        },
        async (screenshotBuffer, caption) => {
          if (screenshotBuffer) {
            await ctx.replyWithPhoto({ source: screenshotBuffer }, { caption, parse_mode: 'Markdown' }).catch(() => {});
          }
        }
      ), userId);
    } catch (err) {
      await safeEdit(ctx, loadingMsg.message_id, `❌ *Agent Error:*\n${err.message}`, { parse_mode: 'Markdown' });
    }
  });

  // ─── Handler Pesan Teks Umum ──────────────────────────────────────────────
  bot.on('text', async function(ctx) {
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;
    const text = ctx.message.text;
    const state = userState[chatId];
    
    if (text === '❌ Batal' || text === '\u274C Batal') {
       delete userState[chatId];
       await ctx.reply('Kembali ke menu utama.', mainMenuKeyboard);
       return;
    }

    if (state && state.step === 'SELECT_MATERI_COURSE') {
      const match = text.match(/^(\d+)\./);
      if (match) {
        const idx = parseInt(match[1]) - 1;
        const selected = state.courses[idx];
        if (selected) {
          const loadingMsg = await ctx.reply('⏳ Memuat materi & tugas...', { reply_markup: { remove_keyboard: true } });
          try {
            const stream = await getCourseStream(userId, selected.id);
            if (!stream.length) {
               await safeEdit(ctx, loadingMsg.message_id, 'Belum ada materi atau tugas di kelas ini.');
               userState[chatId] = undefined;
               return ctx.reply('Kembali ke menu utama.', mainMenuKeyboard);
            }
            
            userState[chatId] = { step: 'SELECT_MATERI_ITEM', courseId: selected.id, stream: stream };
            const buttons = stream.map((s, i) => {
              const icon = s.type === 'ASSIGNMENT' ? '📝' : '📖';
              const titleText = (s.title || 'Tanpa Judul').substring(0, 30);
              return [`${i + 1}. ${icon} ${titleText}...`];
            });
            buttons.push(['\u274C Batal']); // \u274C Batal
            
            await ctx.telegram.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
            return ctx.reply(`📚 *STREAM KELAS (15 TERBARU)*\nPilih materi/tugas untuk melihat detail:`, {
              parse_mode: 'Markdown',
              reply_markup: { keyboard: buttons, resize_keyboard: true, one_time_keyboard: true }
            });
          } catch (err) {
             await safeEdit(ctx, loadingMsg.message_id, 'Gagal memuat materi: ' + err.message);
             userState[chatId] = undefined;
             return ctx.reply('Kembali ke menu utama.', mainMenuKeyboard);
          }
        }
      }
      return ctx.reply('Pilihan tidak valid. Ketik nomor mata kuliah yang sesuai.', {
        reply_markup: {
          keyboard: state.courses.map((c, i) => [`${i + 1}. ${c.name}`]).concat([['\u274C Batal']]),
          resize_keyboard: true,
          one_time_keyboard: true
        }
      });
    }

    if (state && state.step === 'SELECT_MATERI_ITEM') {
      const match = text.match(/^(\d+)\./);
      if (match) {
        const idx = parseInt(match[1]) - 1;
        const selected = state.stream[idx];
        if (selected) {
          try {
            const itemDetailStr = formatStreamItemDetail(selected);
            await ctx.reply(itemDetailStr, { parse_mode: 'Markdown', disable_web_page_preview: true });
            delete userState[chatId];
            return ctx.reply('Kembali ke menu utama.', mainMenuKeyboard);
          } catch (err) {
            return ctx.reply('Gagal memuat detail item: ' + err.message);
          }
        }
      }
      return ctx.reply('Pilihan tidak valid. Ketik nomor tugas yang sesuai.', {
        reply_markup: {
          keyboard: state.stream.map((s, i) => [`${i + 1}. ${s.type === 'ASSIGNMENT' ? '📝' : '📖'} ${(s.title || 'Tanpa Judul').substring(0, 30)}...`]).concat([['\u274C Batal']]),
          resize_keyboard: true,
          one_time_keyboard: true
        }
      });
    }

    // ... (State codes untu PILIH TUGAS)
    if (state && state.step === 'SELECT_ASSIGNMENT') {
      const match = text.match(/^(\d+)\./);
      if (match) {
        const idx = parseInt(match[1]) - 1;
        const selected = state.assignments[idx];
        if (selected) {
      userState[chatId] = { step: 'WAIT_FILE', selectedAssignment: selected, pendingFiles: [] };
          await ctx.reply(
            '📎 Siap! Kirim file untuk tugas:\n\n' +
            '*' + selected.title + '*\n' + selected.courseName + '\n\n' +
            '💡 Kamu bisa kirim lebih dari 1 file.\n' +
            'Tekan *✅ Kumpulkan* jika sudah selesai mengirim semua file.',
            { parse_mode: 'Markdown', reply_markup: { keyboard: [['\u2705 Kumpulkan'], ['\u274C Batal']], resize_keyboard: true } }
          );
          return;
        }
      }
      return ctx.reply('Pilihan tidak valid. Ketik nomor tugas yang sesuai.');
    }

    if (state && state.step === 'SELECT_ASSIGNMENT_FOR_UPLOAD') {
      const match = text.match(/^(\d+)\./);
      if (match) {
        const idx = parseInt(match[1]) - 1;
        const selected = state.assignments[idx];
        if (selected) {
          userState[chatId] = { step: 'WAIT_FILE', selectedAssignment: selected };
          const fileData = state.fileData;
          await ctx.reply('\uD83D\uDCCB Memproses pengumpulan file...', { reply_markup: { remove_keyboard: true } });
          await handleFileUpload(ctx, fileData.fileId, fileData.fileName, fileData.mimeType);
          return;
        }
      }
      return ctx.reply('Pilihan tidak valid. Pilih dari tombol di bawah, atau ketik \u274C Batal.', {
        reply_markup: {
          keyboard: state.assignments.map(function(a, i) { return [(i + 1) + '. ' + a.title + ' (' + a.courseName + ')']; }).concat([['\u274C Batal']]),
          resize_keyboard: true,
          one_time_keyboard: true
        }
      });
    }

    if (state && state.step === 'AI_CHAT') {
      const thinking = await ctx.reply('\uD83D\uDCAD Sedang berpikir...');
      (async () => {
        try {
          const answer = await askAI(chatId, text, [], [], async (streamingText) => {
            await safeEdit(ctx, thinking.message_id, streamingText + ' \u23F3', { parse_mode: 'Markdown' });
          });
          await safeEdit(ctx, thinking.message_id, answer, { parse_mode: 'Markdown' });
        } catch (err) {
          await safeEdit(ctx, thinking.message_id, 'Error AI: ' + err.message);
        }
      })();
      return;
    }

    const thinking = await ctx.reply('\uD83D\uDCAD Sedang berpikir...');
    (async () => {
      try {
        const answer = await askAI(chatId, text, [], [], async (streamingText) => {
          await safeEdit(ctx, thinking.message_id, streamingText + ' \u23F3', { parse_mode: 'Markdown' });
        });
        await safeEdit(ctx, thinking.message_id, answer, { parse_mode: 'Markdown' });
      } catch (err) {
        await safeEdit(ctx, thinking.message_id, 'Orion error: ' + err.message + '\n\nPastikan GEMINI_API_KEY sudah diisi di .env');
      }
    })();
  });

  async function handleFileUpload(ctx, fileId, fileName, mimeType, caption) {
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;
    const state = userState[chatId];

    // Jika sedang dalam proses WAIT_FILE: tampung file, tunggu konfirmasi
    if (state && state.step === 'WAIT_FILE') {
      if (!isAuthenticated(userId)) {
        return ctx.reply('Untuk mengumpulkan file ke Classroom, kamu harus Login Google terlebih dahulu.');
      }
      const assignment = state.selectedAssignment;
      if (!assignment) return ctx.reply('Silakan pilih tugas dari menu Kumpulkan Tugas terlebih dahulu.');
      if (!assignment.submissionId) return ctx.reply('Tidak ada submission ID. Pastikan kamu sudah terdaftar di mata kuliah ini.');

      // Tampung file di state
      if (!state.pendingFiles) state.pendingFiles = [];
      state.pendingFiles.push({ fileId, fileName, mimeType });

      const count = state.pendingFiles.length;
      await ctx.reply(
        `✅ File ke-${count} diterima: *${fileName}*\n\n` +
        `Total ${count} file menunggu.\n` +
        `Kirim file lagi atau tekan *✅ Kumpulkan* untuk mengumpulkan sekarang!`,
        { parse_mode: 'Markdown', reply_markup: { keyboard: [['\u2705 Kumpulkan'], ['\u274C Batal']], resize_keyboard: true } }
      );
      return;
    }

    // Jika sedang SELECT_ASSIGNMENT_FOR_UPLOAD (legacy flow)
    if (state && state.step === 'SELECT_ASSIGNMENT_FOR_UPLOAD') {
      if (!isAuthenticated(userId)) {
        return ctx.reply('Untuk mengumpulkan file ke Classroom, kamu harus Login Google terlebih dahulu.');
      }
      const assignment = state.selectedAssignment;
      if (!assignment) return ctx.reply('Silakan pilih tugas dari menu Kumpulkan Tugas terlebih dahulu.');
      if (!assignment.submissionId) return ctx.reply('Tidak ada submission ID. Pastikan kamu sudah terdaftar di mata kuliah ini.');

      if (!state.pendingFiles) state.pendingFiles = [];
      state.pendingFiles.push({ fileId, fileName, mimeType });
      userState[chatId] = { step: 'WAIT_FILE', selectedAssignment: assignment, pendingFiles: state.pendingFiles };

      const count = state.pendingFiles.length;
      await ctx.reply(
        `✅ File ke-${count} diterima: *${fileName}*\n\nTotal ${count} file menunggu.\nTekan *✅ Kumpulkan* untuk mengumpulkan sekarang!`,
        { parse_mode: 'Markdown', reply_markup: { keyboard: [['\u2705 Kumpulkan'], ['\u274C Batal']], resize_keyboard: true } }
      );
      return;
    }

    // Jika tidak sedang mengumpulkan tugas, jadikan input untuk Gemini AI
    const thinking = await ctx.reply('👀 Memeriksa file/gambar...');
    
    (async () => {
      try {
        const tempFileName = 'temp_' + Date.now() + '_' + fileName;
        const tempPath = await downloadTelegramFile(fileId, tempFileName);
        
        let assignmentsObj = { pending: [], finished: [] };
        let courses = [];
        if (isAuthenticated(userId)) {
          const { getAllAssignments, getCourses } = require('../classroomService');
          try { assignmentsObj = await getAllAssignments(userId); } catch (e) {}
          try { courses = await getCourses(userId); } catch (e) {}
        }

        const parts = [];
        if (mimeType.startsWith('text/') || mimeType === 'application/javascript' || mimeType === 'application/json' || mimeType.includes('xml')) {
            const textContent = fs.readFileSync(tempPath, 'utf8');
            parts.push('Isi file (' + fileName + '):\n```\n' + textContent.slice(0, 10000) + '\n```\n\n' + (caption || 'Tolong jelaskan file ini.'));
        } else {
            const base64data = fs.readFileSync(tempPath).toString('base64');
            parts.push({
              inlineData: {
                data: base64data,
                mimeType: mimeType
              }
            });
            parts.push(caption || 'Tolong analisa file/media ini.');
        }
        fs.unlinkSync(tempPath);

        const answer = await askAI(chatId, parts, assignmentsObj, courses, async (streamingText) => {
          await safeEdit(ctx, thinking.message_id, streamingText + ' \u23F3', { parse_mode: 'Markdown' });
        });
        await safeEdit(ctx, thinking.message_id, answer, { parse_mode: 'Markdown' });
      } catch (err) {
        await safeEdit(ctx, thinking.message_id, 'Error AI memproses file: ' + err.message);
      }
    })();
  }

  // Handler dokumen
  bot.on('document', async function(ctx) {
    const doc = ctx.message.document;
    const mimeType = doc.mime_type || getMimeType(doc.file_name || 'file');
    await handleFileUpload(ctx, doc.file_id, doc.file_name || ('dokumen_' + Date.now()), mimeType, ctx.message.caption);
  });

  // Handler foto
  bot.on('photo', async function(ctx) {
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];
    const fileName = 'foto_' + Date.now() + '.jpg';
    await handleFileUpload(ctx, largest.file_id, fileName, 'image/jpeg', ctx.message.caption);
  });

  // Handler video
  bot.on('video', async function(ctx) {
    const video = ctx.message.video;
    const fileName = video.file_name || ('video_' + Date.now() + '.mp4');
    const mimeType = video.mime_type || 'video/mp4';
    await handleFileUpload(ctx, video.file_id, fileName, mimeType, ctx.message.caption);
  });

  // Handler audio
  bot.on('audio', async function(ctx) {
    const audio = ctx.message.audio;
    const fileName = audio.file_name || ('audio_' + Date.now() + '.mp3');
    await handleFileUpload(ctx, audio.file_id, fileName, audio.mime_type || 'audio/mpeg', ctx.message.caption);
  });

  bot.telegram.setMyCommands([
    { command: 'start', description: 'Buka menu utama' },
    { command: 'tugas', description: 'Lihat daftar tugas ujian/PR' },
    { command: 'kumpulkan', description: 'Kumpul tugas dengan upload file' },
    { command: 'mapel', description: 'Lihat mata kuliah yang aktif' },
    { command: 'ai', description: 'Nyalakan Asisten Orion AI' },
    { command: 'browse', description: 'Minta AI menjelajahi / automasi website apa saja' },
    { command: 'refresh', description: 'Perbarui data terbaru dari Google Classroom' },
    { command: 'login', description: 'Login atau hubungkan akun Google' },
    { command: 'help', description: 'Panduan penggunaan bot' }
  ]).catch(function(err) {
    console.error('Gagal set commands:', err.message);
  });

  console.log('\u2705 Semua handler terdaftar.');
}

module.exports = { register };
