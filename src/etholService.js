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
      'https://login.pens.ac.id/cas/login?service=https%3A%2F%2Fethol.pens.ac.id%2Fapi%2Fauth%2Fcas-callback',
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
    await page.waitForSelector('body', { timeout: 15000 });
    await new Promise(r => setTimeout(r, 2000));

    // 2. Logika Berdasarkan Mode
    if (mode === 'scan') {
      if (onProgress) onProgress('🔎 Memindai daftar absensi yang tersedia dari "Jadwal Hari Ini"...');
      
      // Scroll ke bagian "Jadwal Hari Ini"
      await page.evaluate(() => {
        const element = Array.from(document.querySelectorAll('h2, div, p')).find(el => el.innerText && el.innerText.trim() === 'Jadwal Hari Ini');
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
          window.scrollTo(0, document.body.scrollHeight || 1000);
        }
      });
      await new Promise(r => setTimeout(r, 1500));

      const availableCourses = await page.evaluate(() => {
        const headers = Array.from(document.querySelectorAll('h2, div, p'));
        const header = headers.find(el => el.innerText && el.innerText.trim() === 'Jadwal Hari Ini');
        if (!header) return [];
        
        const container = header.closest('div[class*="_gradJadwal"]') || header.closest('.rounded-2xl');
        if (!container) return [];
        
        const items = Array.from(container.querySelectorAll('div[class*="_hoverBgFaintWhite"]'));
        const found = [];
        for (const item of items) {
          const titleEl = item.querySelector('p[class*="truncate"]') || item.querySelector('p.font-semibold') || item.querySelector('p');
          if (titleEl) {
            const courseName = titleEl.innerText.trim();
            if (courseName && !found.includes(courseName)) {
              found.push(courseName);
            }
          }
        }
        return found;
      });
      
      let scanBuffer = null;
      scanBuffer = await page.screenshot({ type: 'jpeg', quality: 80 });

      await browser.close();
      return { success: true, mode: 'scan', courses: availableCourses, screenshot: scanBuffer };
    }

    // --- Mode Execute ---
    if (mode === 'execute') {
      if (onProgress) onProgress(`🗺️ Langkah 1: Mencari jadwal mapel "${targetCourse || 'Teratas'}"...`);
      
      // Scroll ke bagian "Jadwal Hari Ini"
      await page.evaluate(() => {
        const element = Array.from(document.querySelectorAll('h2, div, p')).find(el => el.innerText && el.innerText.trim() === 'Jadwal Hari Ini');
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
          window.scrollTo(0, document.body.scrollHeight || 1000);
        }
      });
      await new Promise(r => setTimeout(r, 1500));

      // Klik tombol "Masuk" untuk mata kuliah tujuan
      const clickResult = await page.evaluate((target) => {
        const headers = Array.from(document.querySelectorAll('h2, div, p'));
        const header = headers.find(el => el.innerText && el.innerText.trim() === 'Jadwal Hari Ini');
        if (!header) return { success: false, error: 'Section "Jadwal Hari Ini" tidak ditemukan' };
        
        const container = header.closest('div[class*="_gradJadwal"]') || header.closest('.rounded-2xl');
        if (!container) return { success: false, error: 'Container jadwal tidak ditemukan' };
        
        const items = Array.from(container.querySelectorAll('div[class*="_hoverBgFaintWhite"]'));
        for (const item of items) {
          const titleEl = item.querySelector('p[class*="truncate"]') || item.querySelector('p.font-semibold') || item.querySelector('p');
          if (titleEl && titleEl.innerText.trim().toLowerCase().includes(target.toLowerCase())) {
            const btn = item.querySelector('button') || item.querySelector('a') || item.querySelector('[class*="btnMasuk"]');
            if (btn) {
              btn.click();
              return { success: true };
            }
          }
        }
        return { success: false, error: `Mata kuliah "${target}" tidak ditemukan di jadwal hari ini` };
      }, targetCourse);

      if (!clickResult.success) {
        throw new Error(clickResult.error);
      }

      if (onProgress) onProgress('🗺️ Menunggu halaman detail kelas terbuka...');
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 2000));

      // Setup dialog alert listener
      let dialogMsg = null;
      page.on('dialog', async dialog => {
        dialogMsg = dialog.message();
        console.log(`[ETHOL] Dialog popped up: ${dialogMsg}`);
        await dialog.accept();
      });

      // Periksa status tombol "Presensi"
      if (onProgress) onProgress('🗺️ Langkah 2: Memeriksa tombol Presensi...');
      const checkBtn = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, a'));
        const btn = buttons.find(el => {
          const txt = el.innerText ? el.innerText.trim().toLowerCase() : '';
          return txt === 'presensi' || txt.includes('absen') || txt.includes('hadir');
        });
        
        if (!btn) {
          return { found: false };
        }
        
        let isActive = true;
        if (btn.disabled || btn.getAttribute('disabled') !== null) {
          isActive = false;
        } else {
          const className = btn.className.toLowerCase();
          if (className.includes('disabled') || className.includes('cursor-not-allowed')) {
            isActive = false;
          } else {
            const style = window.getComputedStyle(btn);
            if (style.pointerEvents === 'none' || style.opacity === '0.5' || parseFloat(style.opacity) < 0.7) {
              isActive = false;
            }
          }
        }
        
        return { found: true, isActive: isActive };
      });

      let finalStatus = 'NOT_FOUND';

      if (checkBtn.found) {
        if (checkBtn.isActive) {
          // Klik tombol presensi
          if (onProgress) onProgress('🗺️ Langkah 3: Mengeklik tombol Presensi...');
          await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button, a'));
            const btn = buttons.find(el => {
              const txt = el.innerText ? el.innerText.trim().toLowerCase() : '';
              return txt === 'presensi' || txt.includes('absen') || txt.includes('hadir');
            });
            if (btn) btn.click();
          });

          // Tunggu proses presensi & alert muncul
          await new Promise(r => setTimeout(r, 4000));
          finalStatus = 'CLICKED';
        } else {
          // Tombol abu-abu, cek tabel History Presensi Saya
          if (onProgress) onProgress('🗺️ Langkah 3: Tombol Presensi abu-abu. Memeriksa riwayat presensi...');
          
          const historyDates = await page.evaluate(() => {
            const headers = Array.from(document.querySelectorAll('h2, div, p, th'));
            const historyHeader = headers.find(el => el.innerText && el.innerText.trim().includes('History Presensi Saya'));
            if (!historyHeader) return [];
            
            const container = historyHeader.closest('.card') || historyHeader.closest('div') || historyHeader.parentElement;
            if (!container) return [];
            
            const rows = Array.from(container.querySelectorAll('tr'));
            const dates = [];
            if (rows.length > 0) {
              for (const row of rows) {
                const cells = Array.from(row.querySelectorAll('td'));
                if (cells.length > 0) {
                  const dateText = cells.map(c => c.innerText.trim()).join(' | ');
                  dates.push(dateText);
                }
              }
            } else {
              const divs = Array.from(container.querySelectorAll('div, span, p'));
              for (const div of divs) {
                if (div.children.length === 0 && div.innerText) {
                  dates.push(div.innerText.trim());
                }
              }
            }
            return dates;
          });

          // Ambil tanggal hari ini dalam format bahasa Indonesia (contoh: 24 Agustus 2026)
          const now = new Date();
          const dayNum = now.getDate().toString();
          const monthsId = [
            'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
            'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
          ];
          const monthId = monthsId[now.getMonth()];
          const year = now.getFullYear().toString();

          let hasToday = false;
          for (const dateText of historyDates) {
            if (dateText.includes(dayNum) && dateText.toLowerCase().includes(monthId.toLowerCase()) && dateText.includes(year)) {
              hasToday = true;
              break;
            }
          }

          if (hasToday) {
            finalStatus = 'ALREADY_DONE';
          } else {
            finalStatus = 'CLOSED';
          }
        }
      } else {
        logs.push('Tombol Presensi tidak ditemukan di halaman detail.');
      }

      // Ambil screenshot final untuk bukti
      const resultBuffer = await page.screenshot({ type: 'jpeg', quality: 80 });
      await browser.close();

      return {
        success: true,
        mode: 'execute',
        screenshot: resultBuffer,
        btnStatus: finalStatus,
        dialogMessage: dialogMsg,
        logs: logs
      };
    }

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
