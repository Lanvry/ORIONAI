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
const { saveCredentials, getCredentials, deleteCredentials, hasCredentials } = require('./etholCredentials');
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

// ─── AI Instance (Multi-Key Rotation) ─────────────────────────────────────────
const GEMINI_KEYS = [];
const genAIInstances = {};

function initGeminiKeys() {
  if (GEMINI_KEYS.length > 0) return;
  if (process.env.GEMINI_API_KEY) GEMINI_KEYS.push(process.env.GEMINI_API_KEY);
  if (process.env.GEMINI_API_KEY_2) GEMINI_KEYS.push(process.env.GEMINI_API_KEY_2);
}

function getGenAI(keyIndex = 0) {
  initGeminiKeys();
  if (keyIndex >= GEMINI_KEYS.length) return null;
  const key = GEMINI_KEYS[keyIndex];
  if (!genAIInstances[key]) {
    genAIInstances[key] = new GoogleGenerativeAI(key);
  }
  return genAIInstances[key];
}

// ─── AI Chat & Fallback ─────────────────────────────────────────────
const chatHistories = {};

async function askSiputzxGLM(chatId, userParts, systemInstruction, pastHistory, onStream) {
  let hasImage = false;
  let textPrompt = '';
  
  if (typeof userParts === 'string') {
    textPrompt = userParts;
  } else if (Array.isArray(userParts)) {
    for (const part of userParts) {
      if (typeof part === 'string') textPrompt += part + '\n';
      else if (part.text) textPrompt += part.text + '\n';
      else if (part.inlineData) hasImage = true;
    }
  }

  // Jika ada gambar, lempar error karena endpoint ini umumnya hanya teks GET param
  if (hasImage) {
    throw new Error('Siputzx GLM-4 tidak mendukung input gambar. Lanjut ke fallback berikutnya.');
  }

  let historyText = '';
  if (pastHistory && pastHistory.length > 0) {
    historyText += '--- RIWAYAT CHAT ---\n';
    for (const msg of pastHistory) {
      const role = msg.role === 'model' ? 'Orion' : 'User';
      const partsText = msg.parts.map(p => p.text).join('\n');
      historyText += `${role}: ${partsText}\n`;
    }
    historyText += '--------------------\n\n';
  }
  
  const finalPrompt = historyText + 'User: ' + textPrompt;

  const url = `https://api.siputzx.my.id/api/ai/gptoss120b?prompt=${encodeURIComponent(finalPrompt)}&system=${encodeURIComponent(systemInstruction)}&temperature=0.7`;

  if (onStream) onStream('Waiting for response...');

  const response = await axios.get(url, { timeout: 30000 });
  
  if (response.data && response.data.status === true && response.data.data && response.data.data.response) {
    return response.data.data.response;
  } else {
    throw new Error('Respons tidak valid dari Siputzx.');
  }
}

async function askOpenRouter(chatId, userParts, systemInstruction, pastHistory, onStream) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('API Key OpenRouter tidak ada (.env).');

  const messages = [];
  messages.push({ role: 'system', content: systemInstruction });

  for (const msg of pastHistory) {
    const role = msg.role === 'model' ? 'assistant' : 'user';
    const textParts = msg.parts.map(p => p.text).join('\n');
    messages.push({ role, content: textParts });
  }

  let hasImage = false;
  let currentUserContent;
  
  if (typeof userParts === 'string') {
    currentUserContent = userParts;
  } else if (Array.isArray(userParts)) {
    currentUserContent = [];
    for (const part of userParts) {
      if (typeof part === 'string') {
        currentUserContent.push({ type: 'text', text: part });
      } else if (part.text) {
        currentUserContent.push({ type: 'text', text: part.text });
      } else if (part.inlineData) {
        hasImage = true;
        currentUserContent.push({
          type: 'image_url',
          image_url: { url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}` }
        });
      }
    }
  }

  messages.push({ role: 'user', content: currentUserContent });
  const modelQuery = 'qwen/qwen3.6-plus:free';

  try {
    const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
      model: process.env.OPENROUTER_MODEL || modelQuery,
      messages: messages,
      temperature: 0.7,
      stream: true,
    }, {
      responseType: 'stream',
      timeout: 60000,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/Lanvry/ORIONAI',
        'X-Title': 'Orion AI'
      }
    });

    return new Promise((resolve, reject) => {
      let fullText = '';
      let lastEditTime = Date.now();
      let partialChunk = '';

      response.data.on('data', (chunk) => {
        partialChunk += chunk.toString('utf8');
        const lines = partialChunk.split('\n');
        partialChunk = lines.pop() || ''; 

        for (let line of lines) {
          line = line.trim();
          if (line === 'data: [DONE]') continue;
          if (line.startsWith('data: ')) {
            try {
              const parsed = JSON.parse(line.slice(6));
              if (parsed.choices && parsed.choices[0].delta && parsed.choices[0].delta.content) {
                fullText += parsed.choices[0].delta.content;
              }
            } catch (e) {
              // Abaikan parse error per baris SSE
            }
          }
        }

        const now = Date.now();
        // Update UI tiap 1500ms agar tidak over-limit API Telegram
        if (now - lastEditTime > 1500) {
          lastEditTime = now;
          if (onStream && fullText) onStream(fullText);
        }
      });

      response.data.on('end', () => resolve(fullText));
      response.data.on('error', reject);
    });
  } catch (err) {
    // Karena responseType='stream', error message biasanya tidak berupa JSON objek
    const is429 = err.response && err.response.status === 429;
    const retryCount = typeof this.retryCount === 'number' ? this.retryCount : 0;
    
    if (is429 && retryCount < 2) {
      if (onStream) onStream('\u23F3 Server Qwen (OpenRouter) sedang penuh antrian (429). Mencoba ulang dalam 3 detik...');
      await new Promise(r => setTimeout(r, 3000));
      const boundFn = askOpenRouter.bind({ retryCount: retryCount + 1 });
      return await boundFn(chatId, userParts, systemInstruction, pastHistory, onStream);
    }
    
    let errMsg = err.message;
    if (is429) {
      errMsg = 'Terlalu banyak permintaan (Rate limit OpenRouter versi gratis tercapai). Silakan coba lagi nanti.';
    }
    throw new Error(`OpenRouter gagal: ${errMsg}`);
  }
}

async function askGeminiWithKey(keyIndex, chatId, userMessage, systemInstructionText, pastHistory) {
  const genAI = getGenAI(keyIndex);
  if (!genAI) return null; // key tidak tersedia

  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  // Buat chat session baru dengan history + system instruction
  const chatSession = model.startChat({
    history: pastHistory,
    generationConfig: { maxOutputTokens: 2048, temperature: 0.7 },
    systemInstruction: {
      role: 'user',
      parts: [{ text: systemInstructionText }]
    }
  });

  const result = await chatSession.sendMessage(userMessage);
  // Simpan chat session supaya history berlanjut
  chatHistories[chatId] = chatSession;
  return result.response.text();
}

async function askAI(chatId, userMessage, assignmentsObj, courses, onStream) {
  initGeminiKeys();
  if (GEMINI_KEYS.length === 0) {
    return 'Gemini API Key belum dikonfigurasi. Tambahkan GEMINI_API_KEY di file .env';
  }

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

  const systemInstructionText = 'Kamu adalah Orion, asisten AI pribadi yang cerdas, ramah, dan proaktif mendampingi pemilikmu dalam perkuliahan.\n\n' +
    'Instruksi Gaya Bahasa & Formatting (SANGAT PENTING):\n' +
    '1. Gunakan gaya bahasa yang bersahabat, hangat, dan suportif (layaknya sahabat belajar terbaik).\n' +
    '2. ✨ SELALU gunakan emoji yang menarik dan bervariasi di setiap kalimat atau daftar untuk mempercantik pesan.\n' +
    '3. 📌 Jika menyebutkan daftar tugas atau materi, WAJIB gunakan bullet points atau daftar bernomor agar terlihat rapi dan elegan.\n' +
    '4. Berikan spasi (enter/baris baru) antar paragraf supaya tidak sumpek dibaca di layar HP.\n' +
    '5. Gunakan *huruf tebal (bold)* bebas untuk menebalkan judul tugas/mata kuliah, tetapi HINDARI _italic_ dan format markdown yang bertumpuk agar tidak memicu error parsing Telegram.\n' +
    '6. Akhiri pesan dengan sapaan hangat atau semangat memotivasi! 🚀\n\n' +
    tugasContext;

  // ── Cascade Fallback: Gemini Key 1 → Gemini Key 2 → Siputz → OpenRouter ──
  for (let keyIdx = 0; keyIdx < GEMINI_KEYS.length; keyIdx++) {
    try {
      const keyLabel = keyIdx === 0 ? 'Primary' : 'Backup-' + keyIdx;
      console.log(`[AI] Trying Gemini ${keyLabel} (key ${keyIdx + 1}/${GEMINI_KEYS.length})...`);
      const answer = await askGeminiWithKey(keyIdx, chatId, userMessage, systemInstructionText, pastHistory);
      if (answer) return answer;
    } catch (err) {
      const errMsg = err.message ? err.message.toLowerCase() : '';
      const isQuotaError = errMsg.includes('quota') || errMsg.includes('429') || errMsg.includes('exhausted') || errMsg.includes('resource_exhausted');
      if (isQuotaError) {
        console.warn(`[AI] Gemini key ${keyIdx + 1} quota habis, mencoba key berikutnya...`);
        continue; // coba key Gemini berikutnya
      }
      // Error non-quota → langsung throw
      throw err;
    }
  }

  // Semua key Gemini habis → fallback ke Siputz GPT OSS
  console.warn('[AI] Semua Gemini key habis. Trying Siputzx GPT OSS...');
  try {
    return await askSiputzxGLM(chatId, userMessage, systemInstructionText, pastHistory, onStream);
  } catch (errGlm) {
    console.warn('[AI] Siputzx GPT OSS failed:', errGlm.message, 'falling back to OpenRouter (Qwen)...');
    return await askOpenRouter(chatId, userMessage, systemInstructionText, pastHistory, onStream);
  }
}

// ─── Ringkas Tugas dengan AI ──────────────────────────────────────────────────
async function ringkasAssignment(assignment, onStream) {
  initGeminiKeys();
  if (GEMINI_KEYS.length === 0) return 'GEMINI_API_KEY belum dikonfigurasi.';

  const prompt =
    'Tolong ringkas tugas kuliah berikut dalam 3-5 poin singkat dan jelas. ' +
    'Jelaskan apa yang harus dikerjakan tanpa menggunakan format markdown yang berlebihan.\n\n' +
    'Judul: ' + assignment.title + '\n' +
    'Mata Kuliah: ' + assignment.courseName + '\n' +
    'Deskripsi: ' + (assignment.description || '(tidak ada deskripsi)');

  // ── Cascade: Gemini Key 1 → Key 2 → Siputz → OpenRouter ──
  for (let keyIdx = 0; keyIdx < GEMINI_KEYS.length; keyIdx++) {
    try {
      const genAI = getGenAI(keyIdx);
      if (!genAI) continue;
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
      const result = await model.generateContent(prompt);
      return result.response.text();
    } catch (err) {
      const errMsg = err.message ? err.message.toLowerCase() : '';
      const isQuotaError = errMsg.includes('quota') || errMsg.includes('429') || errMsg.includes('exhausted') || errMsg.includes('resource_exhausted');
      if (isQuotaError) {
        console.warn(`[AI] Gemini key ${keyIdx + 1} quota habis (ringkas), mencoba key berikutnya...`);
        continue;
      }
      throw err;
    }
  }

  // Semua key Gemini habis → fallback
  console.warn('[AI] Semua Gemini key habis (ringkas). Trying Siputzx GPT OSS...');
  try {
    return await askSiputzxGLM('ringkas', prompt, 'Kamu adalah AI asisten akademik yang ahli merangkum.', [], onStream);
  } catch (errGlm) {
    console.warn('[AI] Siputzx GPT OSS failed:', errGlm.message, 'falling back to OpenRouter (Qwen)...');
    return await askOpenRouter('ringkas', prompt, 'Kamu adalah AI asisten akademik yang ahli merangkum.', [], onStream);
  }
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
      [{ text: '\uD83D\uDCDA Daftar Mapel' }, { text: '\uD83C\uDF93 Absen ETHOL' }],
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
        const { loginAndCheckEthol } = require('./etholService');
        
        const result = await loginAndCheckEthol(email, password, async (text) => {
          await safeEdit(ctx, loadingMsg.message_id, `🚀 *Status:* ${text}`, { parse_mode: 'Markdown' });
        }, 'scan');

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
        const { loginAndCheckEthol } = require('./etholService');
        
        const result = await loginAndCheckEthol(
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
        );

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
      (async () => {
        try {
          let assignmentsObj = { pending: [], finished: [] };
          let courses = [];
          if (isAuthenticated(userId)) {
            const { getAllAssignments, getCourses } = require('./classroomService');
            try { assignmentsObj = await getAllAssignments(userId); } catch (e) {}
            try { courses = await getCourses(userId); } catch (e) {}
          }
          const answer = await askAI(chatId, text, assignmentsObj, courses, async (streamingText) => {
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
        let assignmentsObj = { pending: [], finished: [] };
        let courses = [];
        if (isAuthenticated(userId)) {
          const { getAllAssignments, getCourses } = require('./classroomService');
          try { assignmentsObj = await getAllAssignments(userId); } catch (e) {}
          try { courses = await getCourses(userId); } catch (e) {}
        }
        const answer = await askAI(chatId, text, assignmentsObj, courses, async (streamingText) => {
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

    // Jika sedang dalam proses mengumpulkan tugas, proses pengumpulan
    if (state && (state.step === 'WAIT_FILE' || state.step === 'SELECT_ASSIGNMENT_FOR_UPLOAD')) {
      if (!isAuthenticated(userId)) {
        return ctx.reply('Untuk mengumpulkan file ke Classroom, kamu harus Login Google terlebih dahulu.');
      }
      
      const assignment = state.selectedAssignment;
      
      if (!assignment) {
         return ctx.reply('Silakan pilih tugas dari menu Kumpulkan Tugas terlebih dahulu.');
      }

      if (!assignment.submissionId) {
        return ctx.reply('Tidak ada submission ID. Pastikan kamu sudah terdaftar di mata kuliah ini.');
      }

      const statusMsg = await ctx.reply('\uD83D\uDCE4 Mengupload ke Google Drive...');

      try {
        const tempPath = await downloadTelegramFile(fileId, fileName);
        await safeEdit(ctx, statusMsg.message_id, '\uD83D\uDCE4 Mengumpulkan ke Classroom...');

        const link = await submitAssignment(userId, assignment.courseId, assignment.courseWorkId, assignment.submissionId, tempPath, fileName, mimeType);

        try { fs.unlinkSync(tempPath); } catch (e) {}
        delete userState[chatId];

        await safeEdit(ctx, statusMsg.message_id, '\u2705 Tugas berhasil dikumpulkan!\n\nTugas: ' + assignment.title + '\nMapel: ' + assignment.courseName + '\nFile: ' + fileName);
        await ctx.reply('Kembali ke menu utama:', mainMenuKeyboard);
      } catch (err) {
        try { fs.unlinkSync(path.join(os.tmpdir(), fileName)); } catch (e) {}
        await safeEdit(ctx, statusMsg.message_id, 'Gagal mengumpulkan tugas: ' + err.message);
      }
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
          const { getAllAssignments, getCourses } = require('./classroomService');
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
    { command: 'refresh', description: 'Perbarui data terbaru dari Google Classroom' },
    { command: 'login', description: 'Login atau hubungkan akun Google' },
    { command: 'help', description: 'Panduan penggunaan bot' }
  ]).catch(function(err) {
    console.error('Gagal set commands:', err.message);
  });

  console.log('\u2705 Semua handler terdaftar.');
}

module.exports = { register };
