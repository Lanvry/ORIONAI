const { getAuthUrl, saveToken, isAuthenticated } = require('./googleAuth');
const {
  getPendingAssignments,
  refreshAssignments,
  submitAssignment,
  getCourses,
} = require('./classroomService');
const {
  formatAssignmentList,
  formatAssignmentMessage,
  formatAssignmentDetail,
  getMimeType,
  escapeMd,
} = require('./utils');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Safe Edit Message (ignore "not modified" error, log sisanya) ─────────────
async function safeEdit(ctx, msgId, text, opts) {
  try {
    await ctx.telegram.editMessageText(ctx.chat.id, msgId, null, text, opts || {});
  } catch (err) {
    if (err.message && err.message.includes('message is not modified')) return;
    console.error('[safeEdit Error]', err.message ? err.message.slice(0, 120) : err);
  }
}

// ─── State Sementara Per User ─────────────────────────────────────────────────
const userState = {}; // { [chatId]: { step, assignments, selectedAssignment } }

// ─── AI Instance ──────────────────────────────────────────────────────────────
let genAIInstance = null;

function getGenAI() {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!genAIInstance) {
    genAIInstance = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return genAIInstance;
}

// ─── AI Chat ──────────────────────────────────────────────────────────────────
const chatHistories = {};

async function askAI(chatId, userMessage, assignmentsObj, courses) {
  const genAI = getGenAI();
  if (!genAI) {
    return 'Gemini API Key belum dikonfigurasi. Tambahkan GEMINI_API_KEY di file .env';
  }

  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  let tugasContext = '';
  if (courses && courses.length > 0) {
    tugasContext += '\n\n=== DAFTAR KELAS (COURSES) PEMILIK ===\n';
    courses.forEach(function(c, i) {
      tugasContext += (i + 1) + '. ' + c.name + (c.section ? ' (' + c.section + ')' : '') + '\n';
    });
  }

  const pending = Array.isArray(assignmentsObj) ? assignmentsObj : assignmentsObj.pending || [];
  const finished = Array.isArray(assignmentsObj) ? [] : assignmentsObj.finished || [];

  if (pending.length > 0) {
    tugasContext += '\n=== TUGAS AKTIF PENGGUNA (BELUM SELESAI) ===\n';
    pending.slice(0, 10).forEach(function(a, i) {
      const deadline = a.dueDate
        ? a.dueDate.toLocaleString('id-ID', {
            day: '2-digit', month: 'short', year: 'numeric',
            hour: '2-digit', minute: '2-digit',
          })
        : 'Tanpa deadline';
      tugasContext += (i + 1) + '. ' + a.title + ' (' + a.courseName + ') — Deadline: ' + deadline + '\n';
      if (a.description) tugasContext += '   Deskripsi: ' + a.description.slice(0, 100) + '...\n';
    });
    tugasContext += '===========================\n';
  }

  if (finished.length > 0) {
    tugasContext += '\n=== TUGAS SUDAH SELESAI PENGGUNA (RIWAYAT) ===\n';
    finished.slice(0, 10).forEach(function(a, i) {
      tugasContext += (i + 1) + '. ' + a.title + ' (' + a.courseName + ') — Sudah dikumpulkan/dinilai\n';
    });
    tugasContext += '===========================\n';
  }

  // Ambil history chat sebelumnya (jika ada) supaya konteks obrolan tidak hilang
  const pastHistory = chatHistories[chatId] ? await chatHistories[chatId].getHistory() : [];

  // Selalu inisiasi ulang startChat dengan systemInstruction terbaru (yg berisi tugas aktif)
  chatHistories[chatId] = model.startChat({
    history: pastHistory,
    generationConfig: { maxOutputTokens: 2048, temperature: 0.7 },
    systemInstruction: {
      role: 'user',
      parts: [{
        text:
          'Kamu adalah Orion, asisten AI pribadi yang cerdas, ramah, dan proaktif mendampingi pemilikmu dalam perkuliahan.\n\n' +
          'Instruksi Gaya Bahasa & Formatting (SANGAT PENTING):\n' +
          '1. Gunakan gaya bahasa yang bersahabat, hangat, dan suportif (layaknya sahabat belajar terbaik).\n' +
          '2. ✨ SELALU gunakan emoji yang menarik dan bervariasi di setiap kalimat atau daftar untuk mempercantik pesan.\n' +
          '3. 📌 Jika menyebutkan daftar tugas atau materi, WAJIB gunakan bullet points atau daftar bernomor agar terlihat rapi dan elegan.\n' +
          '4. Berikan spasi (enter/baris baru) antar paragraf supaya tidak sumpek dibaca di layar HP.\n' +
          '5. Gunakan *huruf tebal (bold)* bebas untuk menebalkan judul tugas/mata kuliah, tetapi HINDARI _italic_ dan format markdown yang bertumpuk agar tidak memicu error parsing Telegram.\n' +
          '6. Akhiri pesan dengan sapaan hangat atau semangat memotivasi! 🚀\n\n' +
          tugasContext
      }]
    }
  });

  const result = await chatHistories[chatId].sendMessage(userMessage);
  return result.response.text();
}

// ─── Ringkas Tugas dengan AI ──────────────────────────────────────────────────
async function ringkasAssignment(assignment) {
  const genAI = getGenAI();
  if (!genAI) return 'GEMINI_API_KEY belum dikonfigurasi.';

  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
  const prompt =
    'Tolong ringkas tugas kuliah berikut dalam 3-5 poin singkat dan jelas. ' +
    'Jelaskan apa yang harus dikerjakan tanpa menggunakan format markdown yang berlebihan.\n\n' +
    'Judul: ' + assignment.title + '\n' +
    'Mata Kuliah: ' + assignment.courseName + '\n' +
    'Deskripsi: ' + (assignment.description || '(tidak ada deskripsi)');

  const result = await model.generateContent(prompt);
  return result.response.text();
}

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
      [{ text: '\uD83D\uDCDA Daftar Mapel' }, { text: '\u2753 Bantuan' }]
    ],
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
      '(Salin ID ini ke file .env pada variabel `TELEGRAM_OWNER_ID`)\n\n' +
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
      '\uD83D\uDCDA Daftar Mapel - Lihat semua mata kuliah aktif\n\n' +
      'Perintah khusus:\n' +
      '/detail <nomor> - Detail lengkap tugas\n' +
      '/ringkas <nomor> - AI ringkaskan tugas untuk kamu\n' +
      '/refresh - Paksa refresh data dari Classroom\n\n' +
      'Cara kumpulkan tugas:\n' +
      '1. Tekan tombol Kumpulkan Tugas\n' +
      '2. Pilih tugas dari daftar\n' +
      '3. Kirim file-nya ke sini\n' +
      '4. Bot akan otomatis upload & kumpulkan ke Classroom'
    );
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

  // Daftar Tugas
  bot.hears(['\uD83D\uDCCB Daftar Tugas', '/tugas'], async function(ctx) {
    const userId = ctx.from.id;
    if (!isAuthenticated(userId)) {
      return ctx.reply('Kamu belum login Google. Tekan Login Google terlebih dahulu.');
    }
    const loadingMsg = await ctx.reply('\uD83D\uDD04 Sedang mengambil data tugas dari Classroom...');
    try {
      const { getAllAssignments } = require('./classroomService');
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
    try {
      const assignments = await getPendingAssignments(userId);
      if (num < 1 || num > assignments.length) {
        return safeEdit(ctx, loadingMsg.message_id, 'Nomor tidak valid. Kamu punya ' + assignments.length + ' tugas aktif.');
      }
      const a = assignments[num - 1];
      const ringkasan = await ringkasAssignment(a);
      await safeEdit(ctx, loadingMsg.message_id, '\uD83D\uDCDD Ringkasan: ' + a.title + '\n\n' + ringkasan);
    } catch (err) {
      await safeEdit(ctx, loadingMsg.message_id, 'Error: ' + err.message);
    }
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

  // ─── Handler Pesan Teks Umum ──────────────────────────────────────────────
  bot.on('text', async function(ctx) {
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;
    const text = ctx.message.text;
    const state = userState[chatId];

    // ... (State codes untu PILIH TUGAS)
    if (state && state.step === 'SELECT_ASSIGNMENT') {
      const match = text.match(/^(\d+)\./);
      if (match) {
        const idx = parseInt(match[1]) - 1;
        const selected = state.assignments[idx];
        if (selected) {
          userState[chatId] = { step: 'WAIT_FILE', selectedAssignment: selected };
          await ctx.reply(
            '\uD83D\uDCCE Siap! Kirim file untuk tugas:\n\n' +
            selected.title + '\n' + selected.courseName + '\n\n' +
            '(Kirim file sebagai lampiran/dokumen, foto, atau video)',
            { reply_markup: { keyboard: [['\u274C Batal']], resize_keyboard: true } }
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
      try {
        let assignmentsObj = { pending: [], finished: [] };
        let courses = [];
        if (isAuthenticated(userId)) {
          const { getAllAssignments } = require('./classroomService');
          try { assignmentsObj = await getAllAssignments(userId); } catch (e) {}
          try { courses = await getCourses(userId); } catch (e) {}
        }
        const answer = await askAI(chatId, text, assignmentsObj, courses);
        await safeEdit(ctx, thinking.message_id, answer);
      } catch (err) {
        await safeEdit(ctx, thinking.message_id, 'Error AI: ' + err.message);
      }
      return;
    }

    const thinking = await ctx.reply('\uD83D\uDCAD Sedang berpikir...');
    try {
      let assignmentsObj = { pending: [], finished: [] };
      let courses = [];
      if (isAuthenticated(userId)) {
        const { getAllAssignments } = require('./classroomService');
        try { assignmentsObj = await getAllAssignments(userId); } catch (e) {}
        try { courses = await getCourses(userId); } catch (e) {}
      }
      const answer = await askAI(chatId, text, assignmentsObj, courses);
      await safeEdit(ctx, thinking.message_id, answer);
    } catch (err) {
      await safeEdit(ctx, thinking.message_id, 'Orion error: ' + err.message + '\n\nPastikan GEMINI_API_KEY sudah diisi di .env');
    }
  });

  async function handleFileUpload(ctx, fileId, fileName, mimeType) {
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;
    const state = userState[chatId];

    if (!state || state.step !== 'WAIT_FILE') {
      if (!isAuthenticated(userId)) {
        return ctx.reply('Untuk mengumpulkan file, kamu harus Login Google terlebih dahulu.');
      }
      const loadingMsg = await ctx.reply('\uD83D\uDD04 Mengecek tugas untuk file ' + fileName + '...');
      try {
        const assignments = await getPendingAssignments(userId);
        if (!assignments.length) {
          return safeEdit(ctx, loadingMsg.message_id, '\u2705 Kamu tidak punya tugas tertunda untuk dikumpulkan saat ini.');
        }

        userState[chatId] = {
          step: 'SELECT_ASSIGNMENT_FOR_UPLOAD',
          assignments: assignments,
          fileData: { fileId, fileName, mimeType }
        };

        const buttons = assignments.map(function(a, i) {
          return [(i + 1) + '. ' + a.title + ' (' + a.courseName + ')'];
        });
        buttons.push(['\u274C Batal']);

        await safeEdit(ctx, loadingMsg.message_id, '\uD83D\uDCCB Mau dikumpulkan ke tugas yang mana?');
        await ctx.reply('Pilih tugas:', {
          reply_markup: { keyboard: buttons, resize_keyboard: true, one_time_keyboard: true }
        });
        return;
      } catch (err) {
        return safeEdit(ctx, loadingMsg.message_id, 'Error saat menyiapkan upload: ' + err.message);
      }
    }

    const assignment = state.selectedAssignment;

    if (!assignment.submissionId) {
      return ctx.reply('Tidak ada submission ID. Pastikan kamu sudah terdaftar di mata kuliah ini.');
    }

    const statusMsg = await ctx.reply('\uD83D\uDCE4 Mengupload ke Google Drive...');

    try {
      const tempPath = await downloadTelegramFile(fileId, fileName);
      await safeEdit(ctx, statusMsg.message_id, '\uD83D\uDCE4 Mengumpulkan ke Classroom...');

      const link = await submitAssignment(
        userId,
        assignment.courseId,
        assignment.courseWorkId,
        assignment.submissionId,
        tempPath,
        fileName,
        mimeType
      );

      try { fs.unlinkSync(tempPath); } catch (e) {}
      delete userState[chatId];

      await safeEdit(
        ctx,
        statusMsg.message_id,
        '\u2705 Tugas berhasil dikumpulkan!\n\n' +
        'Tugas: ' + assignment.title + '\n' +
        'Mapel: ' + assignment.courseName + '\n' +
        'File: ' + fileName
      );
      await ctx.reply('Kembali ke menu utama:', mainMenuKeyboard);
    } catch (err) {
      try { fs.unlinkSync(path.join(os.tmpdir(), fileName)); } catch (e) {}
      await safeEdit(ctx, statusMsg.message_id, 'Gagal mengumpulkan tugas: ' + err.message);
    }
  };

  // Handler dokumen
  bot.on('document', async function(ctx) {
    const doc = ctx.message.document;
    const mimeType = doc.mime_type || getMimeType(doc.file_name || 'file');
    await handleFileUpload(ctx, doc.file_id, doc.file_name || ('dokumen_' + Date.now()), mimeType);
  });

  // Handler foto
  bot.on('photo', async function(ctx) {
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];
    const fileName = 'foto_' + Date.now() + '.jpg';
    await handleFileUpload(ctx, largest.file_id, fileName, 'image/jpeg');
  });

  // Handler video
  bot.on('video', async function(ctx) {
    const video = ctx.message.video;
    const fileName = video.file_name || ('video_' + Date.now() + '.mp4');
    const mimeType = video.mime_type || 'video/mp4';
    await handleFileUpload(ctx, video.file_id, fileName, mimeType);
  });

  // Handler audio
  bot.on('audio', async function(ctx) {
    const audio = ctx.message.audio;
    const fileName = audio.file_name || ('audio_' + Date.now() + '.mp3');
    await handleFileUpload(ctx, audio.file_id, fileName, audio.mime_type || 'audio/mpeg');
  });

  bot.telegram.setMyCommands([
    { command: 'start', description: 'Buka menu utama' },
    { command: 'tugas', description: 'Lihat daftar tugas ujian/PR' },
    { command: 'kumpulkan', description: 'Kumpul tugas dengan upload file' },
    { command: 'mapel', description: 'Lihat mata kuliah yang aktif' },
    { command: 'ai', description: 'Nyalakan Asisten Orion AI' },
    { command: 'refresh', description: 'Perbarui data terbaru dari Google Classroom' },
    { command: 'login', description: 'Login atau hubungkan akun Google' },
    { command: 'help', description: 'Panduan penggunaan bot' }
  ]).catch(function(err) {
    console.error('Gagal set commands:', err.message);
  });

  console.log('\u2705 Semua handler terdaftar.');
}

module.exports = { register };
