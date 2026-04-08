const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

function findBrowserExecutable() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const winPaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env.PROGRAMFILES + '\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env.LOCALAPPDATA + '\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  ];
  const linuxPaths = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
    '/usr/bin/brave-browser',
  ];
  const macPaths = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ];
  const candidates = process.platform === 'win32' ? winPaths : process.platform === 'darwin' ? macPaths : linuxPaths;
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch (_) {}
  }
  return null;
}

async function getScheduleMis(email, password, onProgress) {
  if (onProgress) onProgress('Memulai eksekusi Puppeteer untuk mengambil jadwal...');

  const executablePath = findBrowserExecutable();
  if (!executablePath) {
    return { success: false, error: 'Browser tidak ditemukan di sistem ini.' };
  }

  const isHeadless = process.env.HEADLESS !== 'false';
  const browserArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    // Bypass SSL/Cert issues (Sangat penting untuk Windows 7 dan 8 karena root cert store jadul)
    '--ignore-certificate-errors',
    '--ignore-ssl-errors',
    '--ignore-certificate-errors-spki-list',
    '--allow-insecure-localhost',
    '--disable-web-security',
    '--disable-features=IsolateOrigins,site-per-process,RendererCodeIntegrity',
    // Optimalisasi Networking & UI
    '--disable-background-networking',
    '--disable-sync',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-translate',
    '--disable-infobars',
    '--window-size=1280,800'
  ];
  if (isHeadless) browserArgs.push('--disable-gpu');

  const browser = await puppeteer.launch({
    headless: isHeadless,
    executablePath,
    args: browserArgs,
    defaultViewport: { width: 1280, height: 800 }
  });

  const page = await browser.newPage();
  try {
    if (onProgress) onProgress('🌐 Menuju portal login MIS PENS (CAS)...');
    
    await page.goto(
      'https://login.pens.ac.id/cas/login?service=https%3A%2F%2Fonline.mis.pens.ac.id%2Findex.php%3FLogin%3D1%26halAwal%3D1',
      { waitUntil: 'load', timeout: 45000 }
    );
    await new Promise(r => setTimeout(r, 1500));

    if (onProgress) onProgress('🔐 Mengisi kredensial...');
    await page.evaluate((e, p) => {
      const usernameSelectors = ['#username', '#netid', 'input[name="username"]', 'input[type="text"]'];
      const passwordSelectors = ['#password', 'input[name="password"]', 'input[type="password"]'];
      for (const sel of usernameSelectors) {
        const el = document.querySelector(sel);
        if (el) { el.value = e; break; }
      }
      for (const sel of passwordSelectors) {
        const el = document.querySelector(sel);
        if (el) { el.value = p; break; }
      }
    }, email, password);

    await page.evaluate(() => {
      const btn = document.querySelector('input[type="submit"], button[type="submit"], .btn-login, button');
      if (btn) btn.click();
    });

    if (onProgress) onProgress('🔐 Sedang login, menunggu redirect ke MIS PENS...');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});

    if (onProgress) onProgress('📸 Membuka menu Akademik -> Jadwal Kuliah...');
    
    let foundJadwal = false;

    // 1. Temukan dan Hover menu "Akademik"
    const akademikLocators = await page.$x("//div[@class='mainmenu']//a[normalize-space(text())='Akademik']");
    if (akademikLocators.length > 0) {
        if (onProgress) onProgress('👆 Hovering menu Akademik...');
        await akademikLocators[0].hover();
        await new Promise(r => setTimeout(r, 1500)); // Beri jeda 1.5 detik agar dropdown animasi turun ke bawah selesai
        
        // 2. Temukan dan Klik submenu "Jadwal Kuliah"
        const jadwalLocators = await page.$x("//div[@class='mainmenu']//a[contains(@href, 'mJadwalKuliah.php')]");
        if (jadwalLocators.length > 0) {
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}),
                jadwalLocators[0].click()
            ]);
            foundJadwal = true;
        }
    }

    if (!foundJadwal) {
        // Fallback: Jika navigasi berubah/tidak terdeteksi, coba temukan link secara manual di seluruh halaman
        if (onProgress) onProgress('⚠️ Hover Akademik gagal, mencari fallback link Jadwal Kuliah...');
        const clickedFallback = await page.evaluate(() => {
           const links = Array.from(document.querySelectorAll('a, button, li, div'));
           for (const link of links) {
               const text = (link.innerText || '').toLowerCase();
               if (text.includes('jadwal kuliah per-semester') || text.trim() === 'jadwal kuliah') {
                   link.click();
                   return true;
               }
           }
           return false;
        });

        if (clickedFallback) {
             await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
        } else {
             const ss = await page.screenshot({ type: 'jpeg', quality: 75 });
             await browser.close();
             return { success: false, error: 'Gagal menemukan dan mengklik navigasi Akademik -> Jadwal Kuliah.', screenshot: ss };
        }
    }

    if (onProgress) onProgress('📸 Mengambil tangkapan layar jadwal...');
    await new Promise(r => setTimeout(r, 2000)); // Tunggu render tabel

    // scroll ke bawah sedikit jika diperlukan, tapi fullPage biasanya bagus
    const resultBuffer = await page.screenshot({ type: 'jpeg', quality: 90, fullPage: true });

    await browser.close();
    return { success: true, screenshot: resultBuffer };

  } catch (error) {
    await browser.close();
    return { success: false, error: error.message };
  }
}

module.exports = { getScheduleMis };
