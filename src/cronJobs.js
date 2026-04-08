const cron = require('node-cron');
const { getPendingAssignments, refreshAssignments, getAllRecentMaterials, downloadDriveFile } = require('./classroomService');
const { isAuthenticated } = require('./googleAuth');
const { formatAssignmentMessage, formatAssignmentList, urgencyEmoji } = require('./utils');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Simpan daftar tugas yang sudah dikirim notifikasi per user (hindari duplikat)
const notifiedAssignments = new Set();
const TOKEN_DIR = path.join(__dirname, '../data/users');

/**
 * Mendapatkan daftar semua userId yang terdaftar
 */
function getAllUserIds() {
  if (!fs.existsSync(TOKEN_DIR)) return [];
  const files = fs.readdirSync(TOKEN_DIR);
  return files
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''));
}

/**
 * Kirim notifikasi ke semua user jika ada tugas baru / hampir deadline
 */
async function checkAndNotify(isFirstRun = false) {
  const userIds = getAllUserIds();

  for (const userId of userIds) {
    if (!isAuthenticated(userId)) continue;

    try {
      const assignments = await getPendingAssignments(userId);

      for (const a of assignments) {
        const key = `${userId}_${a.courseId}_${a.courseWorkId}`;

        // Notifikasi tugas baru (belum pernah di-notify)
        if (!notifiedAssignments.has(key)) {
          notifiedAssignments.add(key);
          if (!isFirstRun) {
            try {
              await global.bot.telegram.sendMessage(
                userId,
                formatAssignmentMessage(a, `🆕 *TUGAS BARU!*`),
                { parse_mode: 'Markdown', disable_web_page_preview: true }
              );
            } catch (sendErr) {
              console.error(`[CronJob] Gagal kirim notif tugas baru ke ${userId}:`, sendErr.message);
            }
          }
        }

        if (!a.dueDate) continue;
        const hoursDiff = (a.dueDate - new Date()) / 3600000;

        // Peringatan H-7 (168 jam)
        const key7 = `${key}_h7`;
        if (hoursDiff <= 168 && hoursDiff > 144 && !notifiedAssignments.has(key7)) {
          notifiedAssignments.add(key7);
          if (!isFirstRun) await sendDeadlineWarning(userId, a, '🟡 *PERINGATAN — 7 HARI LAGI!*');
        }

        // Peringatan H-3 (72 jam)
        const key3 = `${key}_h3`;
        if (hoursDiff <= 72 && hoursDiff > 48 && !notifiedAssignments.has(key3)) {
          notifiedAssignments.add(key3);
          if (!isFirstRun) await sendDeadlineWarning(userId, a, '🟠 *PERINGATAN — 3 HARI LAGI!*');
        }

        // Peringatan H-1 (24 jam)
        const key1 = `${key}_h1`;
        if (hoursDiff <= 24 && hoursDiff > 0 && !notifiedAssignments.has(key1)) {
          notifiedAssignments.add(key1);
          if (!isFirstRun) await sendDeadlineWarning(userId, a, '🔴 *DEADLINE BESOK!*');
        }

        // Peringatan 2 jam terakhir
        const key2h = `${key}_2h`;
        if (hoursDiff <= 2 && hoursDiff > 0 && !notifiedAssignments.has(key2h)) {
          notifiedAssignments.add(key2h);
          if (!isFirstRun) await sendDeadlineWarning(userId, a, '🚨 *DEADLINE 2 JAM LAGI! SEGERA KUMPULKAN!*');
        }
      }
    } catch (err) {
      console.error(`[CronJob Error Assignments ${userId}]`, err.message);
    }

    try {
      const materials = await getAllRecentMaterials(userId);
      for (const mat of materials) {
        const matKey = `${userId}_materi_${mat.materialId}`;
        if (!notifiedAssignments.has(matKey)) {
           notifiedAssignments.add(matKey);
           
           if (!isFirstRun) {
             let msg = `🎓 *MATERI BARU DITAMBAHKAN*\n\n`;
             msg += `📚 *Mata Kuliah:* ${mat.courseName}\n`;
             msg += `📖 *Materi:* ${mat.title}\n`;
             if (mat.description) msg += `📝 *Deskripsi:* ${mat.description.substring(0, 150)}...\n`;
             if (mat.alternateLink) msg += `\n🔗 [Buka di Classroom](${mat.alternateLink})\n`;
             
             // Kirim info utama materi
             await global.bot.telegram.sendMessage(userId, msg, { parse_mode: 'Markdown', disable_web_page_preview: true });
             
             // Urus lampiran (jika ada) dan siapkan file path untuk AI
             let aiFilePath = null;
             let aiMimeType = null;
             
             if (mat.materials && mat.materials.length > 0) {
               for (const item of mat.materials) {
                  if (item.driveFile && item.driveFile.driveFile) {
                     const file = item.driveFile.driveFile;
                     // Filter file besar & dokumen Google native (seperti Google Docs)
                     if (file.mimeType && !file.mimeType.includes('vnd.google-apps')) {
                        const tempPath = path.join(os.tmpdir(), (file.title || 'lampiran').replace(/[/\\?%*:|"<>]/g, '-'));
                        try {
                          const downloaded = await downloadDriveFile(userId, file.id, tempPath);
                          await global.bot.telegram.sendDocument(userId, { source: downloaded }, { caption: `📎 ${file.title}` });
                          
                          // Simpan 1 file PDF untuk dianalisa AI (yang pertama saja)
                          if (!aiFilePath && file.mimeType && file.mimeType.includes('pdf')) {
                             // Copy file dulu sebelum link dihapus untuk diolah AI
                             const aiPathCopy = tempPath + '_ai.pdf';
                             fs.copyFileSync(downloaded, aiPathCopy);
                             aiFilePath = aiPathCopy;
                             aiMimeType = file.mimeType;
                          }
                          
                          fs.unlinkSync(downloaded); // Clean up temp file
                        } catch (e) {
                          console.error(`Gagal download lampiran ${file.title}:`, e.message);
                          await global.bot.telegram.sendMessage(userId, `📎 *Tautan Lampiran:* [${file.title}](${file.alternateLink})`, { parse_mode: 'Markdown' });
                        }
                     } else if (file.mimeType) {
                        await global.bot.telegram.sendMessage(userId, `📎 *Dokumen Google:* [${file.title}](${file.alternateLink})`, { parse_mode: 'Markdown' });
                     } else {
                        await global.bot.telegram.sendMessage(userId, `📎 *Tautan Lampiran:* [${file.title}](${file.alternateLink})`, { parse_mode: 'Markdown' });
                     }
                  }
                  
                  if (item.link) {
                     await global.bot.telegram.sendMessage(userId, `🔗 *Tautan Luar:* [${item.link.title}](${item.link.url})`, { parse_mode: 'Markdown' });
                  }
                  if (item.youtubeVideo) {
                     await global.bot.telegram.sendMessage(userId, `📺 *YouTube:* [${item.youtubeVideo.title}](${item.youtubeVideo.alternateLink})`, { parse_mode: 'Markdown' });
                  }
               }
             }

             // Buat Summary AI
             try {
               const aiSum = await getAiMaterialSummary(mat.title, mat.description, aiFilePath, aiMimeType);
               if (aiSum) {
                 await global.bot.telegram.sendMessage(userId, `🤖 *Pemahaman AI:*\n\n${aiSum}`, { parse_mode: 'Markdown' });
               }
             } catch (e) {
               console.error('AI error memahami materi:', e.message);
             }
             
             if (aiFilePath && fs.existsSync(aiFilePath)) {
                fs.unlinkSync(aiFilePath);
             }
           }
        }
      }
    } catch (err) {
      console.error(`[CronJob Error Materials ${userId}]`, err.message);
    }
  }
}

async function sendDeadlineWarning(userId, assignment, header) {
  try {
    await global.bot.telegram.sendMessage(
      userId,
      formatAssignmentMessage(assignment, header),
      { parse_mode: 'Markdown', disable_web_page_preview: true }
    );
  } catch (err) {
    console.error(`[CronJob] Gagal kirim deadline warning ke ${userId}:`, err.message);
  }
}

/**
 * Kirim daily digest setiap pagi ke semua user
 */
async function sendDailyDigest() {
  const userIds = getAllUserIds();

  for (const userId of userIds) {
    if (!isAuthenticated(userId)) continue;

    try {
      // Force refresh untuk daily digest
      const assignments = await refreshAssignments(userId);

      const greeting = getGreeting();
      let msg = `${greeting} 🌅\n\n`;

      if (!assignments.length) {
        msg += '✅ *Tidak ada tugas tertunda!*\n\nKamu bebas hari ini~ 🎉';
      } else {
        msg += `📋 *RINGKASAN TUGAS — ${assignments.length} tugas menunggu*\n\n`;

        // Kelompokkan: urgent (< 24 jam), soon (< 3 hari), ok (> 3 hari)
        const urgent = assignments.filter(a => a.dueDate && (a.dueDate - new Date()) / 3600000 <= 24);
        const soon = assignments.filter(a => a.dueDate && (a.dueDate - new Date()) / 3600000 > 24 && (a.dueDate - new Date()) / 3600000 <= 72);
        const ok = assignments.filter(a => !a.dueDate || (a.dueDate - new Date()) / 3600000 > 72);

        if (urgent.length) {
          msg += `🔴 *DEADLINE HARI INI/BESOK (${urgent.length}):*\n`;
          urgent.forEach(a => { msg += `  • ${a.title} — _${a.courseName}_\n`; });
          msg += '\n';
        }
        if (soon.length) {
          msg += `🟠 *DALAM 3 HARI (${soon.length}):*\n`;
          soon.forEach(a => { msg += `  • ${a.title} — _${a.courseName}_\n`; });
          msg += '\n';
        }
        if (ok.length) {
          msg += `🟢 *LAINNYA (${ok.length}):*\n`;
          ok.forEach(a => { msg += `  • ${a.title} — _${a.courseName}_\n`; });
        }

        msg += '\n💡 Ketik /tugas untuk detail lengkap';
      }

      await global.bot.telegram.sendMessage(userId, msg, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error(`[DailyDigest Error ${userId}]`, err.message);
    }
  }
}

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return '🌞 Selamat pagi!';
  if (hour < 15) return '☀️ Selamat siang!';
  if (hour < 18) return '🌤️ Selamat sore!';
  return '🌙 Selamat malam!';
}

function start() {
  const interval = parseInt(process.env.CHECK_INTERVAL_MINUTES || '15');
  const digestHour = parseInt(process.env.DAILY_DIGEST_HOUR || '7');

  console.log(`⏰ Cron job aktif: cek tugas setiap ${interval} menit untuk semua user`);
  console.log(`📬 Daily digest: setiap hari jam ${digestHour}:00 untuk semua user`);

  // Cek tugas berkala
  cron.schedule(`*/${interval} * * * *`, () => checkAndNotify(false));

  // Daily digest setiap pagi
  cron.schedule(`0 ${digestHour} * * *`, sendDailyDigest, {
    timezone: process.env.TIMEZONE || 'Asia/Jakarta',
  });

  setTimeout(() => checkAndNotify(true), 5000); // 👈 Sync diam-diam di awal
}

async function getAiMaterialSummary(title, desc, filePath, mimeType) {
  const apiKeyMain = process.env.GEMINI_API_KEY;
  const apiKeyBackup = process.env.GEMINI_API_KEY_2;
  const apiKey = apiKeyMain || apiKeyBackup;
  if (!apiKey) return null;
  
  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' }); // pake 1.5 flash krn lebih bagus muat PDF document 
    
    let parts = [
      { text: `Kamu adalah asisten pengingat materi kelas universitas yang bergaul dan asik menyapa. 
Tolong pahami materi kelas ini.
Judul Materi: ${title}
Deskripsi: ${desc || 'Tidak ada deskripsi'}
Tugasmu: Jelaskan secara singkat (maksimal 3 kalimat pendek santai) apa yang pada dasarnya dibahas di materi ini dan apa yang harus dipelajari.` }
    ];
    
    // Jika ada file terlampir dan ukurannya < 5MB (untuk safety loading file)
    if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).size < 5 * 1024 * 1024) { 
       if (mimeType.includes('pdf')) {
           const fileData = fs.readFileSync(filePath);
           parts.push({
             inlineData: {
               data: fileData.toString('base64'),
               mimeType: 'application/pdf'
             }
           });
       }
    }
    
    const result = await model.generateContent(parts);
    return result.response.text().trim();
  } catch (e) {
    console.error('AI Summary Error:', e.message);
    return null;
  }
}

module.exports = { start, checkAndNotify, sendDailyDigest };
