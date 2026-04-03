const cron = require('node-cron');
const { getPendingAssignments, refreshAssignments } = require('./classroomService');
const { isAuthenticated } = require('./googleAuth');
const { formatAssignmentMessage, formatAssignmentList, urgencyEmoji } = require('./utils');

// Simpan daftar tugas yang sudah dikirim notifikasi (hindari duplikat)
const notifiedAssignments = new Set();

/**
 * Kirim notifikasi ke pemilik bot jika ada tugas baru / hampir deadline
 */
async function checkAndNotify() {
  if (!isAuthenticated()) return;

  const ownerId = process.env.TELEGRAM_OWNER_ID;
  if (!ownerId) {
    console.warn('[CronJob] TELEGRAM_OWNER_ID belum diisi di .env — skip notifikasi.');
    return;
  }

  try {
    const assignments = await getPendingAssignments();

    for (const a of assignments) {
      const key = `${a.courseId}_${a.courseWorkId}`;

      // Notifikasi tugas baru (belum pernah di-notify)
      if (!notifiedAssignments.has(key)) {
        notifiedAssignments.add(key);
        try {
          await global.bot.telegram.sendMessage(
            ownerId,
            formatAssignmentMessage(a, `🆕 *TUGAS BARU!*`),
            { parse_mode: 'Markdown', disable_web_page_preview: true }
          );
        } catch (sendErr) {
          console.error('[CronJob] Gagal kirim notif tugas baru:', sendErr.message);
        }
      }

      if (!a.dueDate) continue;
      const hoursDiff = (a.dueDate - new Date()) / 3600000;

      // Peringatan H-7 (168 jam)
      const key7 = `${key}_h7`;
      if (hoursDiff <= 168 && hoursDiff > 144 && !notifiedAssignments.has(key7)) {
        notifiedAssignments.add(key7);
        await sendDeadlineWarning(ownerId, a, '🟡 *PERINGATAN — 7 HARI LAGI!*');
      }

      // Peringatan H-3 (72 jam)
      const key3 = `${key}_h3`;
      if (hoursDiff <= 72 && hoursDiff > 48 && !notifiedAssignments.has(key3)) {
        notifiedAssignments.add(key3);
        await sendDeadlineWarning(ownerId, a, '🟠 *PERINGATAN — 3 HARI LAGI!*');
      }

      // Peringatan H-1 (24 jam)
      const key1 = `${key}_h1`;
      if (hoursDiff <= 24 && hoursDiff > 0 && !notifiedAssignments.has(key1)) {
        notifiedAssignments.add(key1);
        await sendDeadlineWarning(ownerId, a, '🔴 *DEADLINE BESOK!*');
      }

      // Peringatan 2 jam terakhir
      const key2h = `${key}_2h`;
      if (hoursDiff <= 2 && hoursDiff > 0 && !notifiedAssignments.has(key2h)) {
        notifiedAssignments.add(key2h);
        await sendDeadlineWarning(ownerId, a, '🚨 *DEADLINE 2 JAM LAGI! SEGERA KUMPULKAN!*');
      }
    }
  } catch (err) {
    console.error('[CronJob Error]', err.message);
  }
}

async function sendDeadlineWarning(ownerId, assignment, header) {
  try {
    await global.bot.telegram.sendMessage(
      ownerId,
      formatAssignmentMessage(assignment, header),
      { parse_mode: 'Markdown', disable_web_page_preview: true }
    );
  } catch (err) {
    console.error('[CronJob] Gagal kirim deadline warning:', err.message);
  }
}

/**
 * Kirim daily digest setiap pagi
 */
async function sendDailyDigest() {
  if (!isAuthenticated()) return;

  const ownerId = process.env.TELEGRAM_OWNER_ID;
  if (!ownerId) return;

  try {
    // Force refresh untuk daily digest
    const assignments = await refreshAssignments();

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

    await global.bot.telegram.sendMessage(ownerId, msg, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('[DailyDigest Error]', err.message);
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

  console.log(`⏰ Cron job aktif: cek tugas setiap ${interval} menit`);
  console.log(`📬 Daily digest: setiap hari jam ${digestHour}:00`);

  // Cek tugas berkala
  cron.schedule(`*/${interval} * * * *`, checkAndNotify);

  // Daily digest setiap pagi
  cron.schedule(`0 ${digestHour} * * *`, sendDailyDigest, {
    timezone: process.env.TIMEZONE || 'Asia/Jakarta',
  });

  // Jalankan cek pertama saat startup (delay 5 detik)
  setTimeout(checkAndNotify, 5000);
}

module.exports = { start, checkAndNotify, sendDailyDigest };
