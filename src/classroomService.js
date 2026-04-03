const { google } = require('googleapis');
const { getAuthenticatedClient } = require('./googleAuth');

// ─── Cache ─────────────────────────────────────────────────────────────────
const cache = {
  courses: null,
  coursesExpiry: 0,
  pendingAssignments: null,
  pendingExpiry: 0,
  TTL: 5 * 60 * 1000, // 5 menit
};

function isCacheValid(expiry) {
  return Date.now() < expiry;
}

function invalidateCache() {
  cache.courses = null;
  cache.coursesExpiry = 0;
  cache.pendingAssignments = null;
  cache.pendingExpiry = 0;
}

/**
 * Ambil semua mata pelajaran (courses) aktif
 */
async function getCourses() {
  if (cache.courses && isCacheValid(cache.coursesExpiry)) {
    return cache.courses;
  }

  const auth = await getAuthenticatedClient();
  if (!auth) throw new Error('Belum login Google. Silakan tekan 🔗 Login Google.');

  const classroom = google.classroom({ version: 'v1', auth });
  const res = await classroom.courses.list({ courseStates: ['ACTIVE'] });
  const courses = res.data.courses || [];

  cache.courses = courses;
  cache.coursesExpiry = Date.now() + cache.TTL;
  return courses;
}

/**
 * Ambil semua tugas dari satu course
 */
async function getCourseWork(courseId) {
  const auth = await getAuthenticatedClient();
  if (!auth) throw new Error('Belum login Google.');
  const classroom = google.classroom({ version: 'v1', auth });

  const res = await classroom.courses.courseWork.list({
    courseId,
    orderBy: 'dueDate asc',
  });
  return res.data.courseWork || [];
}

/**
 * Ambil submission saya untuk tugas tertentu
 */
async function getMySubmission(courseId, courseWorkId) {
  const auth = await getAuthenticatedClient();
  if (!auth) throw new Error('Belum login Google.');
  const classroom = google.classroom({ version: 'v1', auth });

  const res = await classroom.courses.courseWork.studentSubmissions.list({
    courseId,
    courseWorkId,
    userId: 'me',
  });
  return res.data.studentSubmissions?.[0] || null;
}

/**
 * Ambil semua tugas yang belum dikumpulkan dengan deadline yang aktif
 */
async function getPendingAssignments() {
  if (cache.pendingAssignments && isCacheValid(cache.pendingExpiry)) {
    return cache.pendingAssignments;
  }

  const courses = await getCourses();
  const pending = [];
  const now = new Date();

  await Promise.all(courses.map(async (course) => {
    let courseWorks = [];
    try {
      courseWorks = await getCourseWork(course.id);
    } catch (err) {
      console.warn(`[Classroom] Gagal ambil courseWork untuk ${course.name}: ${err.message}`);
      return;
    }

    await Promise.all(courseWorks.map(async (cw) => {
      let dueDate = null;
      if (cw.dueDate) {
        const { year, month, day } = cw.dueDate;
        const { hours = 23, minutes = 59 } = cw.dueTime || {};
        dueDate = new Date(year, month - 1, day, hours, minutes);
      }

      // Kita tidak akan membuang tugas yang HANYA lewat deadline, karena mahasiswa sering kumpul telat (Missing).
      // Sebaliknya, buang tugas yang usianya sudah sangat lama (misal lebih dari 30 hari sejak dibuat)
      // untuk memenuhi permintaan user "hanya tugas terbaru saja"
      if (cw.creationTime) {
        const createdAt = new Date(cw.creationTime);
        const diffDays = (now - createdAt) / (1000 * 60 * 60 * 24);
        if (diffDays > 30) {
          return;
        }
      }

      let submission = null;
      try {
        submission = await getMySubmission(course.id, cw.id);
      } catch (err) {
        console.warn(`[Classroom] Gagal ambil submission ${cw.title}: ${err.message}`);
        return;
      }

      const state = submission ? submission.submissionState : null;

      // Jika belum dikumpulkan (bukan TURNED_IN)
      if (state !== 'TURNED_IN') {
        pending.push({
          courseId: course.id,
          courseName: course.name,
          courseWorkId: cw.id,
          title: cw.title,
          description: cw.description || '',
          dueDate,
          alternateLink: cw.alternateLink,
          submissionId: submission ? submission.id : null,
          submissionState: state || 'NEW',
        });
      }
    }));
  }));

  // Sort berdasarkan deadline terdekat
  pending.sort((a, b) => {
    if (!a.dueDate && !b.dueDate) return 0;
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return a.dueDate - b.dueDate;
  });

  cache.pendingAssignments = pending;
  cache.pendingExpiry = Date.now() + cache.TTL;
  return pending;
}

/**
 * Force refresh cache dan ambil tugas baru
 */
async function refreshAssignments() {
  invalidateCache();
  return getPendingAssignments();
}

/**
 * Upload file ke Google Drive dan attach ke submission, lalu Turn In
 */
async function submitAssignment(courseId, courseWorkId, submissionId, filePath, fileName, mimeType) {
  const auth = await getAuthenticatedClient();
  if (!auth) throw new Error('Belum login Google.');

  const classroom = google.classroom({ version: 'v1', auth });
  const drive = google.drive({ version: 'v3', auth });
  const fs = require('fs');

  // 1. Upload ke Drive
  const driveRes = await drive.files.create({
    requestBody: { name: fileName, mimeType },
    media: { mimeType, body: fs.createReadStream(filePath) },
    fields: 'id, webViewLink',
  });

  const fileId = driveRes.data.id;
  const fileLink = driveRes.data.webViewLink;

  // 2. Attach drive file ke submission
  await classroom.courses.courseWork.studentSubmissions.modifyAttachments({
    courseId,
    courseWorkId,
    id: submissionId,
    requestBody: {
      addAttachments: [{ driveFile: { id: fileId } }],
    },
  });

  // 3. Turn In
  await classroom.courses.courseWork.studentSubmissions.turnIn({
    courseId,
    courseWorkId,
    id: submissionId,
  });

  // Invalidate cache setelah submit
  invalidateCache();

  return fileLink;
}

module.exports = {
  getCourses,
  getCourseWork,
  getMySubmission,
  getPendingAssignments,
  refreshAssignments,
  submitAssignment,
  invalidateCache,
};
