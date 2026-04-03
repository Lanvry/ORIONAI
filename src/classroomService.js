const { google } = require('googleapis');
const { getAuthenticatedClient } = require('./googleAuth');

// ─── Cache ─────────────────────────────────────────────────────────────────
const cache = {
  TTL: 5 * 60 * 1000, // 5 menit
};

function getUserCache(userId) {
  if (!cache[userId]) {
    cache[userId] = {
      courses: null,
      coursesExpiry: 0,
      assignments: null,
      assignmentsExpiry: 0,
    };
  }
  return cache[userId];
}

function isCacheValid(expiry) {
  return Date.now() < expiry;
}

function invalidateCache(userId) {
  const userCache = getUserCache(userId);
  userCache.courses = null;
  userCache.coursesExpiry = 0;
  userCache.assignments = null;
  userCache.assignmentsExpiry = 0;
}

/**
 * Ambil semua mata pelajaran (courses) aktif
 */
async function getCourses(userId) {
  const userCache = getUserCache(userId);
  if (userCache.courses && isCacheValid(userCache.coursesExpiry)) {
    return userCache.courses;
  }

  const auth = await getAuthenticatedClient(userId);
  if (!auth) throw new Error('Belum login Google. Silakan tekan 🔗 Login Google.');

  const classroom = google.classroom({ version: 'v1', auth });
  const res = await classroom.courses.list({ courseStates: ['ACTIVE'] });
  const courses = res.data.courses || [];

  userCache.courses = courses;
  userCache.coursesExpiry = Date.now() + cache.TTL;
  return courses;
}

/**
 * Ambil semua tugas dari satu course
 */
async function getCourseWork(userId, courseId) {
  const auth = await getAuthenticatedClient(userId);
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
async function getMySubmission(userId, courseId, courseWorkId) {
  const auth = await getAuthenticatedClient(userId);
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
 * Ambil semua tugas (dipisah mana yang pending dan mana yang sudah selesai)
 */
async function getAllAssignments(userId) {
  const userCache = getUserCache(userId);
  if (userCache.assignments && isCacheValid(userCache.assignmentsExpiry)) {
    return userCache.assignments;
  }

  const courses = await getCourses(userId);
  const pending = [];
  const finished = [];
  const now = new Date();

  await Promise.all(courses.map(async (course) => {
    let courseWorks = [];
    try {
      courseWorks = await getCourseWork(userId, course.id);
    } catch (err) {
      console.warn(`[Classroom] Gagal ambil courseWork untuk user ${userId} course ${course.name}: ${err.message}`);
      return;
    }

    await Promise.all(courseWorks.map(async (cw) => {
      let dueDate = null;
      if (cw.dueDate) {
        const { year, month, day } = cw.dueDate;
        const { hours = 23, minutes = 59 } = cw.dueTime || {};
        dueDate = new Date(year, month - 1, day, hours, minutes);
      }

      if (cw.creationTime) {
        const createdAt = new Date(cw.creationTime);
        const diffDays = (now - createdAt) / (1000 * 60 * 60 * 24);
        if (diffDays > 30) {
          return;
        }
      }

      let submission = null;
      try {
        submission = await getMySubmission(userId, course.id, cw.id);
      } catch (err) {
        console.warn(`[Classroom] Gagal ambil submission user ${userId} task ${cw.title}: ${err.message}`);
        return;
      }

      const state = submission ? submission.state : null;
      const isFinished = (state === 'TURNED_IN' || state === 'RETURNED');
      
      const item = {
        courseId: course.id,
        courseName: course.name,
        courseWorkId: cw.id,
        title: cw.title,
        description: cw.description || '',
        dueDate,
        alternateLink: cw.alternateLink,
        submissionId: submission ? submission.id : null,
        submissionState: state || 'NEW',
      };

      if (isFinished) {
        finished.push(item);
      } else {
        pending.push(item);
      }
    }));
  }));

  const sorter = (a, b) => {
    if (!a.dueDate && !b.dueDate) return 0;
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return a.dueDate - b.dueDate;
  };

  pending.sort(sorter);
  finished.sort(sorter);

  const assignmentsObj = { pending, finished };
  userCache.assignments = assignmentsObj;
  userCache.assignmentsExpiry = Date.now() + cache.TTL;
  return assignmentsObj;
}

/**
 * Pertahankan fungsi lama untuk kompatibilitas dengan cronJobs
 */
async function getPendingAssignments(userId) {
  const { pending } = await getAllAssignments(userId);
  return pending;
}

/**
 * Force refresh cache dan ambil tugas baru
 */
async function refreshAssignments(userId) {
  invalidateCache(userId);
  return getAllAssignments(userId);
}

/**
 * Upload file ke Google Drive dan attach ke submission, lalu Turn In
 */
async function submitAssignment(userId, courseId, courseWorkId, submissionId, filePath, fileName, mimeType) {
  const auth = await getAuthenticatedClient(userId);
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
  invalidateCache(userId);

  return fileLink;
}

module.exports = {
  getCourses,
  getCourseWork,
  getMySubmission,
  getAllAssignments,
  getPendingAssignments,
  refreshAssignments,
  submitAssignment,
  invalidateCache,
};
