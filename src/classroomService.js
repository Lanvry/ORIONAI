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
 * Ambil semua materi terbaru dari semua kelas aktif.
 * Membatasi hanya untuk materi yang dibuat atau diupdate dalam 7 hari terakhir.
 */
async function getAllRecentMaterials(userId) {
  const courses = await getCourses(userId);
  const materialsList = [];
  const now = new Date();
  
  const auth = await getAuthenticatedClient(userId);
  if (!auth) return [];
  const classroom = google.classroom({ version: 'v1', auth });

  await Promise.all(courses.map(async (course) => {
    try {
      const res = await classroom.courses.courseWorkMaterials.list({
        courseId: course.id
      });
      const materials = res.data.courseWorkMaterial || [];

      for (const mat of materials) {
        if (mat.creationTime) {
          const createdAt = new Date(mat.creationTime);
          const diffDays = (now - createdAt) / (1000 * 60 * 60 * 24);
          if (diffDays <= 7) {
            materialsList.push({
              courseId: course.id,
              courseName: course.name,
              materialId: mat.id,
              title: mat.title,
              description: mat.description || '',
              alternateLink: mat.alternateLink,
              creationTime: mat.creationTime,
              materials: mat.materials || [] // <--- attachments (driveFile, link, youtubeVideo)
            });
          }
        }
      }
    } catch (err) {
      console.warn(`[Classroom] Gagal ambil courseWorkMaterials untuk user ${userId} course ${course.name}: ${err.message}`);
    }
  }));

  // Sort dari yang paling lama dibuat ke terbaru untuk notifikasi
  materialsList.sort((a, b) => new Date(a.creationTime) - new Date(b.creationTime));

  return materialsList;
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
 * Upload satu file ke Google Drive (TANPA attach/turn in)
 */
async function uploadFileToDrive(userId, filePath, fileName, mimeType) {
  const auth = await getAuthenticatedClient(userId);
  if (!auth) throw new Error('Belum login Google.');
  const drive = google.drive({ version: 'v3', auth });
  const fs = require('fs');

  const driveRes = await drive.files.create({
    requestBody: { name: fileName, mimeType },
    media: { mimeType, body: fs.createReadStream(filePath) },
    fields: 'id, webViewLink, name',
  });

  return {
    fileId: driveRes.data.id,
    fileLink: driveRes.data.webViewLink,
    fileName: driveRes.data.name,
  };
}

/**
 * Attach semua driveFileIds ke submission lalu Turn In.
 * Jika gagal karena ProjectPermissionDenied (tugas dibuat guru via UI),
 * kembalikan info upload saja — user harus manual Turn In di Classroom.
 */
async function finalizeSubmission(userId, courseId, courseWorkId, submissionId, driveFiles) {
  const auth = await getAuthenticatedClient(userId);
  if (!auth) throw new Error('Belum login Google.');
  const classroom = google.classroom({ version: 'v1', auth });

  try {
    // Attach semua file sekaligus
    await classroom.courses.courseWork.studentSubmissions.modifyAttachments({
      courseId,
      courseWorkId,
      id: submissionId,
      requestBody: {
        addAttachments: driveFiles.map(f => ({ driveFile: { id: f.fileId } })),
      },
    });
  } catch (err) {
    const isPermDenied = err.message && (
      err.message.includes('ProjectPermissionDenied') ||
      err.message.includes('PERMISSION_DENIED') ||
      err.message.includes('insufficient authentication scopes')
    );
    if (isPermDenied) {
      // Tidak bisa attach sama sekali - hanya Drive
      return { attached: false, turnedIn: false, permissionDenied: true };
    }
    throw err;
  }

  // File berhasil di-attach ke submission. Sekarang coba Turn In.
  try {
    await classroom.courses.courseWork.studentSubmissions.turnIn({
      courseId,
      courseWorkId,
      id: submissionId,
    });
    invalidateCache(userId);
    return { attached: true, turnedIn: true };
  } catch (err) {
    const isPermDenied = err.message && (
      err.message.includes('ProjectPermissionDenied') ||
      err.message.includes('PERMISSION_DENIED') ||
      err.message.includes('insufficient authentication scopes')
    );
    if (isPermDenied) {
      // File sudah attached tapi Turn In gagal - user tinggal klik Serahkan
      invalidateCache(userId);
      return { attached: true, turnedIn: false, permissionDenied: true };
    }
    throw err;
  }
}

/**
 * Upload file ke Google Drive dan attach ke submission, lalu Turn In (legacy single-file)
 */
async function submitAssignment(userId, courseId, courseWorkId, submissionId, filePath, fileName, mimeType) {
  const upload = await uploadFileToDrive(userId, filePath, fileName, mimeType);
  await finalizeSubmission(userId, courseId, courseWorkId, submissionId, [upload]);
  return upload.fileLink;
}

/**
 * Download file asli dari Google Drive pengguna
 */
async function downloadDriveFile(userId, fileId, targetPath) {
  const auth = await getAuthenticatedClient(userId);
  if (!auth) throw new Error('Belum login Google.');
  const drive = google.drive({ version: 'v3', auth });
  
  const fs = require('fs');
  const dest = fs.createWriteStream(targetPath);
  
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
  return new Promise((resolve, reject) => {
    res.data
      .on('end', () => resolve(targetPath))
      .on('error', err => reject(err))
      .pipe(dest);
  });
}

/**
 * Mengambil stream (tugas + materi) dari sebuah kelas
 */
async function getCourseStream(userId, courseId) {
  const auth = await getAuthenticatedClient(userId);
  if (!auth) throw new Error('Belum login Google.');
  const classroom = google.classroom({ version: 'v1', auth });

  const stream = [];

  // Hit courseWork (Tugas)
  try {
    const cwRes = await classroom.courses.courseWork.list({
      courseId,
      orderBy: 'updateTime desc',
      pageSize: 20
    });
    const cws = cwRes.data.courseWork || [];
    for (const cw of cws) {
      stream.push({
        id: cw.id,
        type: 'ASSIGNMENT',
        title: cw.title,
        description: cw.description || '',
        creationTime: cw.creationTime,
        updateTime: cw.updateTime,
        alternateLink: cw.alternateLink,
        materials: cw.materials || [],
        dueDate: cw.dueDate || null,
        dueTime: cw.dueTime || null
      });
    }
  } catch (e) {
    console.warn(`[Classroom] Gagal fetch courseWork stream:`, e.message);
  }

  // Hit courseWorkMaterials (Materi)
  try {
    const matRes = await classroom.courses.courseWorkMaterials.list({
      courseId,
      pageSize: 20
    }); 
    const mats = matRes.data.courseWorkMaterial || [];
    for (const mat of mats) {
      stream.push({
        id: mat.id,
        type: 'MATERIAL',
        title: mat.title,
        description: mat.description || '',
        creationTime: mat.creationTime,
        updateTime: mat.updateTime,
        alternateLink: mat.alternateLink,
        materials: mat.materials || []
      });
    }
  } catch (e) {
    console.warn(`[Classroom] Gagal fetch materials stream:`, e.message);
  }

  // Sort Descending by updateTime
  stream.sort((a, b) => new Date(b.updateTime) - new Date(a.updateTime));

  return stream.slice(0, 15); // Ambil 15 terbaru
}

module.exports = {
  getCourses,
  getCourseWork,
  getMySubmission,
  getAllAssignments,
  getAllRecentMaterials,
  getPendingAssignments,
  refreshAssignments,
  submitAssignment,
  uploadFileToDrive,
  finalizeSubmission,
  downloadDriveFile,
  invalidateCache,
  getCourseStream,
};
