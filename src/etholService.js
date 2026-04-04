const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

/**
 * Cari path executable Chrome/Edge yang sudah terinstall di sistem.
 * Mendukung Windows 8, 10, 11 dan Linux/Mac.
 * Priority: .env CHROME_PATH → Chrome → Edge → Brave → Chromium
 */
function findBrowserExecutable() {
  // 1. Cek dari .env terlebih dahulu
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  // 2. Candidate paths untuk Windows 8, 10, 11
  const winPaths = [
    // Google Chrome — lokasi umum
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env.PROGRAMFILES + '\\Google\\Chrome\\Application\\chrome.exe',
    // Microsoft Edge (bawaan Windows 10+, juga bisa di-install Windows 8)
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env.LOCALAPPDATA + '\\Microsoft\\Edge\\Application\\msedge.exe',
    // Brave Browser
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  ];

  // 3. Candidate paths untuk Linux (untuk deployment di server)
  const linuxPaths = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
    '/usr/bin/brave-browser',
  ];

  // 4. Candidate paths untuk macOS
  const macPaths = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ];

  const candidates = process.platform === 'win32' ? winPaths
    : process.platform === 'darwin' ? macPaths
    : linuxPaths;

  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        return candidate;
      }
    } catch (_) {
      // skip path yang tidak valid
    }
  }

  return null;
}


async function loginAndCheckEthol(email, password, onProgress, mode = 'scan', targetCourse = null, onScreenshot = null) {
  if (onProgress) onProgress('Memulai eksekusi rahasia Puppeteer...');

  // Auto-detect browser yang terinstall (Chrome / Edge / Brave)
  const executablePath = findBrowserExecutable();
  if (!executablePath) {
    return {
      success: false,
      error: '❌ Browser tidak ditemukan di sistem ini!\n\n' +
        'Puppeteer membutuhkan Google Chrome, Microsoft Edge, atau Brave Browser.\n\n' +
        '💡 Solusi:\n' +
        '1. Install Google Chrome dari https://www.google.com/chrome\n' +
        '   (Tersedia untuk Windows 7/8/10/11)\n\n' +
        '2. ATAU tambahkan path browser ke file .env:\n' +
        '   CHROME_PATH=C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe',
      logs: [],
    };
  }

  console.log(`[ETHOL] Menggunakan browser: ${executablePath}`);
  if (onProgress) onProgress(`🌐 Membuka browser (${path.basename(executablePath)})...`);

  // Baca konfigurasi headless dari .env (HEADLESS=false untuk debug visual)
  // Default: true (headless) untuk production
  const isHeadless = process.env.HEADLESS !== 'false';
  console.log(`[ETHOL] Mode headless: ${isHeadless}`);

  const browserArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    // PENTING: bypass SSL expired/untrusted cert — sangat penting di Windows 8
    // karena root certificate store Windows 8 sudah outdated untuk banyak HTTPS site
    '--ignore-certificate-errors',
    '--ignore-ssl-errors',
    '--ignore-certificate-errors-spki-list',
    '--allow-insecure-localhost',
    '--disable-web-security',
    // Networking
    '--disable-background-networking',
    '--disable-sync',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-translate',
    '--disable-infobars',
    '--window-size=1280,800',
  ];

  // Hanya tambahkan disable-gpu jika headless=true (kalau false, GPU perlu jalan)
  if (isHeadless) {
    browserArgs.push('--disable-gpu', '--disable-software-rasterizer');
  }

  const browser = await puppeteer.launch({
    headless: isHeadless,
    executablePath: executablePath,
    args: browserArgs,
    defaultViewport: { width: 1280, height: 800 },
    timeout: 60000,  // 60 detik timeout launch
  });

  const page = await browser.newPage();
  const logs = [];

  // Set timeout global navigasi 60 detik (default Puppeteer 30 detik terlalu pendek)
  page.setDefaultNavigationTimeout(60000);
  page.setDefaultTimeout(60000);

  try {
    if (onProgress) onProgress('🌐 Menuju portal login PENS (CAS)...');
    console.log('[ETHOL] Navigating to PENS CAS login...');

    // Gunakan 'load' bukan 'networkidle2'!
    // networkidle2 sering hang di portal yang terus-menerus polling network (AJAX)
    // 'load' = tunggu sampai event 'load' browser, jauh lebih reliable & cepat
    await page.goto(
      'https://login.pens.ac.id/cas/login?service=http%3A%2F%2Fethol.pens.ac.id%2Fcas%2F',
      { waitUntil: 'load', timeout: 45000 }
    );
    console.log('[ETHOL] Page loaded. URL:', page.url());
    logs.push('Halaman login dimuat. URL: ' + page.url());

    // Beri waktu extra supaya JS di halaman selesai render (Windows lama bisa lambat)
    await new Promise(r => setTimeout(r, 1500));

    // Tunggu setidaknya ada satu input text/password muncul di halaman
    logs.push('Menunggu form login CAS muncul...');
    await page.waitForSelector('input[type="text"], input[type="email"], input:not([type="hidden"])', { timeout: 10000 }).catch(() => {
      logs.push('Timeout tunggu form, coba lanjut...');
    });

    // Injeksi kredensial langsung via JavaScript (paling andal untuk semua framework)
    if (onProgress) onProgress('🔐 Mengisi form login...');
    await page.evaluate((emailVal, passVal) => {
      // Cari field username/email — coba semua kemungkinan selector
      const usernameSelectors = ['#username', '#netid', 'input[name="username"]', 'input[name="netid"]', 'input[type="text"]', 'input[type="email"]'];
      const passwordSelectors = ['#password', 'input[name="password"]', 'input[type="password"]'];

      let userField = null;
      for (const sel of usernameSelectors) {
        userField = document.querySelector(sel);
        if (userField) break;
      }

      let passField = null;
      for (const sel of passwordSelectors) {
        passField = document.querySelector(sel);
        if (passField) break;
      }

      if (userField) {
        userField.focus();
        userField.value = emailVal;
        userField.dispatchEvent(new Event('input', { bubbles: true }));
        userField.dispatchEvent(new Event('change', { bubbles: true }));
      }

      if (passField) {
        passField.focus();
        passField.value = passVal;
        passField.dispatchEvent(new Event('input', { bubbles: true }));
        passField.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, email, password);

    await new Promise(r => setTimeout(r, 500));

    // Klik tombol login secara eksplisit (lebih andal dari keyboard.press Enter)
    const clicked = await page.evaluate(() => {
      const submitSelectors = ['input[type="submit"]', 'button[type="submit"]', 'button.btn-submit', '#submitBtn', '.btn-login', 'button'];
      for (const sel of submitSelectors) {
        const btn = document.querySelector(sel);
        if (btn) { btn.click(); return sel; }
      }
      return null;
    });
    logs.push(`Klik login button: ${clicked || 'fallback Enter'}`);
    if (!clicked) await page.keyboard.press('Enter');

    if (onProgress) onProgress('🔐 Sedang login, menunggu redirect ke ETHOL...');
    // Tunggu redirect ke ethol
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {
       logs.push('Timeout menunggu redirect ke ethol. Lanjut saja...');
    });

    if (onProgress) onProgress('📸 Membuka Dashboard ETHOL...');


    // Heuristik: Mencoba mengikuti alur user
    // 1. Pencet notifikasi
    await page.evaluate(() => {
      const bells = Array.from(document.querySelectorAll('.fa-bell, [class*="bell"], .dropdown-toggle'));
      if (bells.length > 0) bells[0].click();
    });
    await new Promise(r => setTimeout(r, 1500));

    // 1.5 Pilih filter "Presensi" di dropdown notifikasi
    if (onProgress) onProgress('🔎 Mengganti filter notifikasi ke "Presensi"...');
    
    // Strategi Ganda (Native Select + Visual Klik)
    await page.evaluate(() => {
      // A. Coba paksa semua native <select> untuk pindah ke Presensi
      const selects = Array.from(document.querySelectorAll('select'));
      for (const s of selects) {
        for (let i = 0; i < s.options.length; i++) {
          if (s.options[i].text.toLowerCase().includes('presensi')) {
            s.selectedIndex = i;
            s.value = s.options[i].value;
            s.dispatchEvent(new Event('change', { bubbles: true }));
            s.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }
      }
      
      // B. Coba klik elemen UI (seperti div/span/button) yang bertuliskan "Tugas" / "Semua" 
      // yang biasanya dipakai sebagai custom dropdown
      const clickable = Array.from(document.querySelectorAll('div, span, button, a'));
      for (const el of clickable) {
        const txt = el.innerText ? el.innerText.trim().toLowerCase() : '';
        // Jika el menampilkan "tugas" (filter default), coba klik agar list-nya terbuka
        if (txt === 'tugas' || txt === 'semua pemberitahuan') {
          el.click();
        }
      }
    });

    await new Promise(r => setTimeout(r, 1000)); // Beri waktu animasi dropdown terbuka (jika itu custom UI)

    await page.evaluate(() => {
      // C. Temukan dan klik opsi "Presensi" yang muncul di layar
      const options = Array.from(document.querySelectorAll('div, span, button, a, li, option'));
      for (const opt of options) {
        const txt = opt.innerText ? opt.innerText.trim().toLowerCase() : '';
        if (txt === 'presensi') {
          opt.click();
        }
      }
    });
    
    // Beri waktu jaringan (AJAX) memuat daftar kartu presensi
    await new Promise(r => setTimeout(r, 2500));

    // 2. Logika Berdasarkan Mode
    if (mode === 'scan') {
      if (onProgress) onProgress('🔎 Memindai daftar absensi yang tersedia...');
      const availableCourses = await page.evaluate(() => {
        const listItems = Array.from(document.querySelectorAll('a, li, tr, [class*="item"], div'));
        const found = [];
        for (const item of listItems) {
          const text = item.innerText ? item.innerText.toLowerCase() : '';
          if (text.includes('dosen telah melakukan presensi')) {
            const matchIndex = text.indexOf('matakuliah ');
            let mapel = text;
            if (matchIndex !== -1) {
              mapel = text.substring(matchIndex + 'matakuliah '.length).trim();
              mapel = mapel.split(/\r?\n/)[0].trim();
            }
            if (mapel && !found.includes(mapel) && mapel.length < 50) {
              found.push(mapel);
            }
          }
        }
        return found;
      });
      
      let scanBuffer = null;
      if (availableCourses.length === 0) {
        if (onProgress) onProgress('📸 Mengambil bukti layar karena daftar kosong...');
        scanBuffer = await page.screenshot({ type: 'jpeg', quality: 80 });
      }

      await browser.close();
      return { success: true, mode: 'scan', courses: availableCourses, screenshot: scanBuffer };
    }

    // --- Mode Execute ---
    if (mode === 'execute') {
      if (onProgress) onProgress(`🗺️ Langkah 1: Mencari notifikasi mapel "${targetCourse || 'Teratas'}"...`);
      
      // Cari div.hover-notifikasi yang tepat berisi teks nama mapel tujuan
      const foundTarget = await page.evaluate((target) => {
        // Selector persis sesuai DevTools: div dengan class "hover-notifikasi"
        const cards = Array.from(document.querySelectorAll('div[class*="hover-notifikasi"]'));
        for (const card of cards) {
          const text = card.innerText ? card.innerText.toLowerCase() : '';
          const matchPresensi = text.includes('dosen telah melakukan presensi');
          const matchTarget = target ? text.includes(target.toLowerCase()) : true;
          if (matchPresensi && matchTarget) {
            card.click();
            return true;
          }
        }
        return false;
      }, targetCourse);

      // Tunggu navigasi ke halaman detail notifikasi
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 1000));
      
      // Screenshot setelah navigasi ke halaman detail (harus tampil card + Akses Kuliah)
      const ss1 = await page.screenshot({ type: 'jpeg', quality: 75 });
      if (onScreenshot) await onScreenshot(ss1, foundTarget 
        ? `📸 Langkah 1: Halaman detail notifikasi "${targetCourse}":`
        : `⚠️ Notifikasi "${targetCourse}" tidak ditemukan — halaman saat ini:`
      );

      if (!foundTarget) {
        logs.push(`Gagal menemukan notifikasi untuk: ${targetCourse || 'Teratas'}`);
      }
    }

    // Langkah 2: Klik "Akses Kuliah" di halaman detail yang sudah terbuka
    if (onProgress) onProgress('🗺️ Langkah 2: Mengeklik tombol Akses Kuliah...');
    await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a, button'));
      for (const link of links) {
        if (link.innerText && link.innerText.toLowerCase().includes('akses kuliah')) {
          link.click();
          break;
        }
      }
    });
    // Tunggu halaman kelas terbuka
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});

    // Screenshot setelah klik Akses Kuliah
    const ss2 = await page.screenshot({ type: 'jpeg', quality: 75 });
    if (onScreenshot) await onScreenshot(ss2, `📸 Setelah klik "Akses Kuliah" — halaman kelas:`);

    // 4. Klik tombol Presensi jika belum abu-abu
    if (onProgress) onProgress('🗺️ Langkah 3: Mencari tombol Presensi...');
    const clickedBtnText = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, a'));
      for (const btn of buttons) {
        const text = (btn.innerText || '').toLowerCase();
        if (text === 'presensi' || text.includes('absen') || text.includes('hadir')) {
          // Abaikan jika "abu-abu" (disabled class or attr)
          if (!btn.disabled && !btn.className.includes('disabled') && !btn.className.includes('secondary')) {
            btn.click();
            return btn.innerText;
          }
          return 'CLOSED: ' + btn.innerText;
        }
      }
      return null;
    });

    let resultBuffer;
    if (clickedBtnText && !clickedBtnText.startsWith('CLOSED:')) {
      if (onProgress) onProgress(`✅ Tombol "${clickedBtnText}" diklik! Menunggu konfirmasi...`);
      logs.push(`Klik tombol akhir: ${clickedBtnText}`);
      await new Promise(r => setTimeout(r, 3000));
      resultBuffer = await page.screenshot({ type: 'jpeg', quality: 80 });
    } else if (clickedBtnText && clickedBtnText.startsWith('CLOSED:')) {
      if (onProgress) onProgress(`❌ Tombol presensi abu-abu! Absensi sudah ditutup.`);
      logs.push('Tombol presensi ditemukan tapi sudah ditutup (abu-abu).');
      resultBuffer = await page.screenshot({ type: 'jpeg', quality: 80 });
    } else {
      logs.push('Tidak menemukan tombol presensi di halaman akhir.');
      resultBuffer = await page.screenshot({ type: 'jpeg', quality: 80 });
    }

    await browser.close();
    
    return {
      success: true,
      mode: 'execute',
      screenshot: resultBuffer,
      btnStatus: clickedBtnText,
      logs: logs
    };

  } catch (error) {
    await browser.close();
    return {
      success: false,
      error: error.message,
      logs: logs
    };
  }
}

module.exports = { loginAndCheckEthol };
