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

  if (diff <= 0) return 'Sudah lewat deadline!';

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
  if (hours <= 0) return '⛔';
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
function formatAssignmentList(assignments) {
  if (!assignments.length) return '✅ Tidak ada tugas yang tertunda saat ini!';

  let msg = '📋 *DAFTAR TUGAS AKTIF*\n\n';

  // Sort: deadline terdekat dulu
  const sorted = [...assignments].sort((a, b) => {
    if (!a.dueDate && !b.dueDate) return 0;
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return a.dueDate - b.dueDate;
  });

  sorted.forEach((a, i) => {
    const deadlineStr = a.dueDate
      ? a.dueDate.toLocaleDateString('id-ID', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
        }) +
        ' ' +
        a.dueDate.toLocaleTimeString('id-ID', {
          hour: '2-digit',
          minute: '2-digit',
        })
      : 'Tanpa deadline';

    msg += urgencyEmoji(a.dueDate) + ' ' + (i + 1) + '. *' + escapeMd(a.title) + '*\n';
    msg += '   📚 ' + escapeMd(a.courseName) + '\n';
    msg += '   ⏰ ' + deadlineStr + '\n';
    if (a.dueDate) msg += '   ⌛ ' + formatTimeRemaining(a.dueDate) + '\n';
    msg += '\n';
  });

  msg += '\n💡 Ketik /detail angka untuk detail lengkap\n';
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

module.exports = {
  formatAssignmentMessage,
  formatAssignmentDetail,
  formatAssignmentList,
  getMimeType,
  formatTimeRemaining,
  urgencyEmoji,
  escapeMd,
};
