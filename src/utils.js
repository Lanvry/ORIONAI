/**
 * Escape karakter khusus Markdown V1 Telegram pada konten dinamis
 * (judul tugas, nama mapel, deskripsi dari Classroom bisa mengandung *, _, [, ])
 */
function escapeMd(text) {
  if (!text) return '';
  return String(text)
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/\[/g, '\\[')
    .replace(/`/g, '\\`');
}

/**
 * Format sisa waktu menjadi string plain (tanpa markdown)
 * @param {Date} dueDate
 * @returns {string}
 */
function formatTimeRemaining(dueDate) {
  if (!dueDate) return 'Tanpa deadline';

  const now = new Date();
  const diff = dueDate - now;

  if (diff <= 0) return '*Missing* (Lewat deadline!)';

  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(hours / 24);
  const remainHours = hours % 24;
  const minutes = Math.floor((diff % 3600000) / 60000);

  if (days === 0 && hours < 1) return `${minutes} menit lagi`;
  if (days === 0) return `${hours} jam ${minutes} menit lagi`;
  if (days === 1) return `Besok, ${remainHours} jam lagi`;
  if (days <= 3) return `${days} hari ${remainHours} jam lagi`;
  return `${days} hari lagi`;
}

/**
 * Pilih emoji berdasarkan urgensi deadline
 * @param {Date|null} dueDate
 * @returns {string}
 */
function urgencyEmoji(dueDate) {
  if (!dueDate) return '⚪';
  const hours = (dueDate - new Date()) / 3600000;
  if (hours <= 0) return '➖';
  if (hours <= 24) return '🔴';
  if (hours <= 72) return '🟠';
  if (hours <= 168) return '🟡';
  return '🟢';
}

/**
 * Format pesan assignment ringkas untuk Telegram (Markdown V1 safe)
 */
function formatAssignmentMessage(a, header = '📋 *TUGAS*') {
  const deadlineStr = a.dueDate
    ? a.dueDate.toLocaleString('id-ID', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }) + ' (' + formatTimeRemaining(a.dueDate) + ')'
    : 'Tidak ada';

  const desc = a.description
    ? '\n📝 ' + escapeMd(a.description.slice(0, 200)) +
      (a.description.length > 200 ? '...' : '')
    : '';

  return (
    header + '\n\n' +
    urgencyEmoji(a.dueDate) + ' *Mata Kuliah:* ' + escapeMd(a.courseName) + '\n' +
    '📌 *Judul:* ' + escapeMd(a.title) + '\n' +
    '⏰ *Deadline:* ' + deadlineStr +
    desc + '\n\n' +
    '🔗 [Buka di Classroom](' + a.alternateLink + ')'
  );
}

/**
 * Format detail lengkap satu tugas (Markdown V1 safe)
 */
function formatAssignmentDetail(a) {
  const deadlineStr = a.dueDate
    ? a.dueDate.toLocaleString('id-ID', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : 'Tidak ada deadline';

  const desc = a.description
    ? '\n\n📝 *Deskripsi:*\n' + escapeMd(a.description)
    : '\n\n📝 *Deskripsi:* _(tidak ada)_';

  return (
    urgencyEmoji(a.dueDate) + ' *DETAIL TUGAS*\n\n' +
    '📌 *Judul:* ' + escapeMd(a.title) + '\n' +
    '📚 *Mata Kuliah:* ' + escapeMd(a.courseName) + '\n' +
    '⏰ *Deadline:* ' + deadlineStr + '\n' +
    '⌛ *Sisa Waktu:* ' + formatTimeRemaining(a.dueDate) +
    desc + '\n\n' +
    '🔗 [Buka di Classroom](' + a.alternateLink + ')'
  );
}

/**
 * Format daftar tugas dengan penomoran dan indikator urgensi (Markdown V1 safe)
 */
function formatAssignmentList(assignmentsObj) {
  // Kompatibilitas mundur jika array yang dikirim
  const pending = Array.isArray(assignmentsObj) ? assignmentsObj : assignmentsObj.pending || [];
  const finished = Array.isArray(assignmentsObj) ? [] : assignmentsObj.finished || [];

  if (!pending.length && !finished.length) return '✅ Tidak ada tugas yang aktif maupun selesai saat ini!';

  let msg = '';

  if (pending.length) {
    msg += '📋 *DAFTAR TUGAS AKTIF (BELUM SELESAI)*\n\n';
    pending.forEach((a, i) => {
      const deadlineStr = a.dueDate
        ? a.dueDate.toLocaleDateString('id-ID', {
            day: '2-digit', month: 'short', year: 'numeric',
          }) + ' ' +
          a.dueDate.toLocaleTimeString('id-ID', {
            hour: '2-digit', minute: '2-digit',
          })
        : 'Tanpa deadline';

      msg += urgencyEmoji(a.dueDate) + ' ' + (i + 1) + '. *' + escapeMd(a.title) + '*\n';
      msg += '   📚 ' + escapeMd(a.courseName) + '\n';
      msg += '   ⏰ ' + deadlineStr + '\n';
      if (a.dueDate) msg += '   ⌛ ' + formatTimeRemaining(a.dueDate) + '\n';
      msg += '\n';
    });
  } else {
    msg += '✨ *YEAAY!* Tidak ada tugas yang belum selesai!\n\n';
  }

  if (finished.length) {
    msg += '🎯 *TUGAS BARU SAJA SELESAI (Terbaru)*\n\n';
    // Ambil 5 tugas selesai terakhir
    finished.slice(0, 5).forEach((a, i) => {
      msg += '✅ *' + escapeMd(a.title) + '*\n';
      msg += '   📚 ' + escapeMd(a.courseName) + '\n\n';
    });
  }

  msg += '\n💡 Ketik /detail angka untuk detail lengkap (dari tugas aktif)\n';
  msg += '💡 Ketik /ringkas angka untuk ringkasan AI';

  return msg;
}

/**
 * Ambil ekstensi mime type dari nama file
 */
function getMimeType(filename) {
  const ext = String(filename).split('.').pop().toLowerCase();
  const mimeMap = {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo',
    zip: 'application/zip',
    rar: 'application/x-rar-compressed',
    txt: 'text/plain',
    js: 'application/javascript',
    py: 'text/x-python',
    java: 'text/x-java-source',
    cpp: 'text/x-c++src',
    c: 'text/x-csrc',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

/**
 * Format string untuk daftar lampiran
 */
function formatAttachments(materials) {
  if (!materials || materials.length === 0) return '';
  let str = '\n\n📎 *Lampiran:*\n';
  materials.forEach((mat, i) => {
    if (mat.driveFile && mat.driveFile.driveFile) {
      str += `${i + 1}. 📄 [${escapeMd(mat.driveFile.driveFile.title)}](${mat.driveFile.driveFile.alternateLink})\n`;
    } else if (mat.youtubeVideo) {
      str += `${i + 1}. 🎥 [${escapeMd(mat.youtubeVideo.title)}](${mat.youtubeVideo.alternateLink})\n`;
    } else if (mat.link) {
      str += `${i + 1}. 🔗 [${escapeMd(mat.link.title)}](${mat.link.url})\n`;
    } else if (mat.form) {
      str += `${i + 1}. 📝 [${escapeMd(mat.form.title)}](${mat.form.formUrl})\n`;
    }
  });
  return str;
}

/**
 * Format detail item stream (Assignment atau Material)
 */
function formatStreamItemDetail(item) {
  const isAssignment = item.type === 'ASSIGNMENT';
  const typeIcon = isAssignment ? '📝' : '📖';
  const typeText = isAssignment ? 'TUGAS' : 'MATERI';

  let deadlineStr = '';
  if (isAssignment) {
    if (item.dueDate) {
      const year = item.dueDate.year;
      const month = item.dueDate.month - 1;
      const day = item.dueDate.day;
      const hours = item.dueTime ? (item.dueTime.hours || 23) : 23;
      const minutes = item.dueTime ? (item.dueTime.minutes || 59) : 59;
      const dueObj = new Date(year, month, day, hours, minutes);
      
      deadlineStr = '\n⏰ *Deadline:* ' + dueObj.toLocaleString('id-ID', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
      deadlineStr += '\n⌛ *Sisa Waktu:* ' + formatTimeRemaining(dueObj);
    } else {
      deadlineStr = '\n⏰ *Deadline:* Tidak ada deadline';
    }
  }

  const descStr = item.description
    ? '\n\n📝 *Deskripsi:*\n' + escapeMd(item.description)
    : '\n\n📝 *Deskripsi:* _(tidak ada)_';

  const attachStr = formatAttachments(item.materials);
  
  const updatedDate = new Date(item.updateTime).toLocaleString('id-ID', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });

  return (
    typeIcon + ' *DETAIL ' + typeText + '*\n\n' +
    '📌 *Judul:* ' + escapeMd(item.title) + '\n' +
    '🕒 *Diperbarui:* ' + updatedDate +
    deadlineStr +
    descStr +
    attachStr + '\n\n' +
    '🔗 [Buka di Classroom](' + item.alternateLink + ')'
  );
}

module.exports = {
  formatAssignmentMessage,
  formatAssignmentDetail,
  formatAssignmentList,
  getMimeType,
  formatTimeRemaining,
  urgencyEmoji,
  escapeMd,
  formatAttachments,
  formatStreamItemDetail,
};
