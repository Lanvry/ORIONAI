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

async function getPresensiMis(email, password, onProgress) {
  if (onProgress) onProgress('Memulai eksekusi Puppeteer untuk mengambil rekap presensi...');

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

    if (onProgress) onProgress('📸 Membuka menu Akademik -> Presensi Perkuliahan...');
    
    let foundPresensi = false;

    // 1. Temukan dan Hover menu "Akademik"
    const akademikLocators = await page.$x("//div[@class='mainmenu']//a[normalize-space(text())='Akademik']");
    if (akademikLocators.length > 0) {
        if (onProgress) onProgress('👆 Hovering menu Akademik...');
        await akademikLocators[0].hover();
        await new Promise(r => setTimeout(r, 1500)); // Beri jeda 1.5 detik agar dropdown animasi turun ke bawah selesai
        
        // 2. Temukan dan Klik submenu "Presensi Perkuliahan" atau yang mengandung "Presensi"
        const presensiLocators = await page.$x("//div[@class='mainmenu']//a[contains(text(), 'Presensi')]");
        if (presensiLocators.length > 0) {
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}),
                presensiLocators[0].click()
            ]);
            foundPresensi = true;
        }
    }

    if (!foundPresensi) {
        // Fallback: Jika navigasi berubah/tidak terdeteksi, coba temukan link secara manual di seluruh halaman
        if (onProgress) onProgress('⚠️ Hover Akademik gagal, mencari fallback link Presensi Perkuliahan...');
        const clickedFallback = await page.evaluate(() => {
           const links = Array.from(document.querySelectorAll('a, button, li, div'));
           for (const link of links) {
               const text = (link.innerText || '').toLowerCase();
               if (text.includes('presensi perkuliahan') || text.trim() === 'presensi') {
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
             return { success: false, error: 'Gagal menemukan dan mengklik navigasi Akademik -> Presensi Perkuliahan.', screenshot: ss };
        }
    }

    if (onProgress) onProgress('📸 Mengambil tangkapan layar presensi...');
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

async function getDaftarUlangMis(email, password, onProgress) {
  if (onProgress) onProgress('Memulai eksekusi Puppeteer untuk mengecek Daftar Ulang...');

  const executablePath = findBrowserExecutable();
  if (!executablePath) {
    return { success: false, error: 'Browser tidak ditemukan di sistem ini.' };
  }

  const isHeadless = process.env.HEADLESS !== 'false';
  const browserArgs = [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--ignore-certificate-errors', '--ignore-ssl-errors', '--ignore-certificate-errors-spki-list',
    '--allow-insecure-localhost', '--disable-web-security',
    '--disable-features=IsolateOrigins,site-per-process,RendererCodeIntegrity',
    '--disable-background-networking', '--disable-sync', '--no-first-run',
    '--no-default-browser-check', '--disable-translate', '--disable-infobars',
    '--window-size=1280,800'
  ];
  if (isHeadless) browserArgs.push('--disable-gpu');

  const browser = await puppeteer.launch({
    headless: isHeadless,
    executablePath,
    args: browserArgs,
    defaultViewport: { width: 1280, height: 800 }
  });

  try {
    const page = await browser.newPage();
    if (onProgress) onProgress('🌐 Menuju portal login MIS PENS (CAS)...');
    
    await page.goto('https://login.pens.ac.id/cas/login?service=https%3A%2F%2Fonline.mis.pens.ac.id%2Findex.php%3FLogin%3D1%26halAwal%3D1', { waitUntil: 'load', timeout: 45000 });
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

    if (onProgress) onProgress('📸 Membuka menu Daftar Ulang...');
    
    let foundDaftarUlang = false;

    const menuLocators = await page.$x("//div[@class='mainmenu']//a[contains(normalize-space(text()), 'Daftar Ulang')]");
    if (menuLocators.length > 0) {
        if (onProgress) onProgress('👆 Hovering menu Daftar Ulang dan Pembayaran...');
        await menuLocators[0].hover();
        await new Promise(r => setTimeout(r, 1500));
        
        const submenuLocators = await page.$x("//div[@class='mainmenu']//a[normalize-space(text())='Daftar Ulang']");
        if (submenuLocators.length > 0) {
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}),
                submenuLocators[submenuLocators.length - 1].click()
            ]);
            foundDaftarUlang = true;
        } else {
             await Promise.all([
                 page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}),
                 menuLocators[0].click()
             ]);
             foundDaftarUlang = true;
        }
    }

    if (!foundDaftarUlang) {
        if (onProgress) onProgress('⚠️ Hover gagal, mencari fallback link Daftar Ulang...');
        const clickedFallback = await page.evaluate(() => {
           const links = Array.from(document.querySelectorAll('a, button, li, div'));
           for (const link of links) {
               const text = (link.innerText || '').toLowerCase();
               if (text.includes('daftar ulang online') || text === 'daftar ulang') {
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
             return { success: false, error: 'Gagal menemukan menu Daftar Ulang.', screenshot: ss };
        }
    }

    await new Promise(r => setTimeout(r, 2000));

    if (onProgress) onProgress('🔎 Mengambil status pembayaran dan daftar ulang...');

    const info = await page.evaluate(() => {
        const bodyText = document.body.innerText || '';
        let uktStatus = '';
        let ikomaStatus = '';
        let reRegStatus = '';
        let perpusStatus = '';
        let tunggakanStatus = '';
        let updateDataStatus = '';
        let buktiLink = '';
        
        const lines = bodyText.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.includes('Status Pembayaran UKT/SPP')) {
                let parts = line.split(':');
                let statusVal = parts.length > 1 ? parts.slice(1).join(':').trim() : '';
                if (!statusVal && i + 1 < lines.length) {
                    statusVal = lines[i+1].trim();
                }
                uktStatus = statusVal || line;
            }
            if (line.includes('Status Pembayaran IKOMA')) {
                let parts = line.split(':');
                let statusVal = parts.length > 1 ? parts.slice(1).join(':').trim() : '';
                if (!statusVal && i + 1 < lines.length) {
                    statusVal = lines[i+1].trim();
                }
                ikomaStatus = statusVal || line;
            }
            if (line.includes('5. Status Daftar Ulang') || (line.includes('Status Daftar Ulang') && !line.includes('5.'))) {
                let statusVal = line.replace(/.*Status Daftar Ulang\s*/, '').trim();
                if ((statusVal === '' || statusVal === ':') && i + 1 < lines.length) {
                    statusVal = lines[i+1].trim();
                }
                reRegStatus = statusVal;
            }
            if (line.includes('Perpustakaan G.D3')) {
                perpusStatus += line + '\n';
                if (i + 1 < lines.length && lines[i+1].includes('Perpustakaan')) perpusStatus += lines[i+1].trim() + '\n';
                if (i + 2 < lines.length && lines[i+2].includes('Perpustakaan')) perpusStatus += lines[i+2].trim() + '\n';
            }
            if (line.includes('3. Status Tunggakan Keuangan') || (line.includes('Status Tunggakan Keuangan') && !line.includes('3.'))) {
                let statusVal = line.replace(/.*Status Tunggakan Keuangan\s*/, '').trim();
                if ((statusVal === '' || statusVal === ':') && i + 1 < lines.length) {
                    statusVal = lines[i+1].trim();
                }
                tunggakanStatus = statusVal;
            }
            if (line.includes('4. Update Data') || (line.includes('Update Data') && !line.includes('4.'))) {
                let j = i + 1;
                while (j < lines.length && j < i + 4) {
                    if (lines[j].includes('Status Pengisian Data')) {
                        let parts = lines[j].split(':');
                        let statusVal = parts.length > 1 ? parts.slice(1).join(':').trim() : '';
                        if (!statusVal && j + 1 < lines.length) {
                            statusVal = lines[j+1].trim();
                        }
                        updateDataStatus = statusVal;
                        break;
                    }
                    j++;
                }
            }
        }
        
        // Grab link for Cetak Bukti Daftar Ulang
        const btns = Array.from(document.querySelectorAll('input[type="button"], button, a'));
        const cetakBtn = btns.find(b => (b.value && b.value.includes('Cetak Bukti')) || (b.innerText && b.innerText.includes('Cetak Bukti')));
        if (cetakBtn) {
            if (cetakBtn.getAttribute('onclick')) {
                const match = cetakBtn.getAttribute('onclick').match(/window\.open\(['"]([^'"]+)['"]/);
                if (match) {
                    // It's relative, make it absolute
                    buktiLink = new URL(match[1], document.location.href).href;
                }
            } else if (cetakBtn.href) {
                buktiLink = cetakBtn.href;
            }
        }
        
        const isRegistered = bodyText.includes('Anda Sudah Daftar Ulang');
        if (isRegistered && (!reRegStatus || reRegStatus.includes('Cetak'))) reRegStatus = 'Anda Sudah Daftar Ulang';
        
        return { uktStatus, ikomaStatus, reRegStatus, isRegistered, perpusStatus: perpusStatus.trim(), tunggakanStatus, updateDataStatus, buktiLink };
    });

    if (info.isRegistered || (info.reRegStatus && info.reRegStatus.toLowerCase().includes('sudah daftar ulang'))) {
         let msg = `✅ **Status:** ${info.reRegStatus || 'Anda Sudah Daftar Ulang'}\n\n📝 **Status UKT:** ${info.uktStatus || 'Telah dilunasi'}\n📝 **Status IKOMA:** ${info.ikomaStatus || 'Telah dilunasi'}`;
         let ss = null;

         if (info.buktiLink) {
             if (onProgress) onProgress('📸 Mengambil bukti daftar ulang...');
             try {
                 await page.goto(info.buktiLink, { waitUntil: 'networkidle2', timeout: 15000 });
                 await new Promise(r => setTimeout(r, 1500));
                 ss = await page.screenshot({ type: 'jpeg', quality: 90, fullPage: true });
                 msg += `\n\n📄 **Bukti Daftar Ulang terlampir pada gambar di atas.**`;
             } catch (e) {
                 msg += `\n\n📄 *(Gagal mengambil bukti daftar ulang: ${e.message})*`;
             }
         } else {
             // Fallback: try clicking it directly if link parsing failed
             const clicked = await page.evaluate(() => {
                 const btns = Array.from(document.querySelectorAll('input[type="button"], button, a'));
                 const cetakBtn = btns.find(b => (b.value && b.value.includes('Cetak Bukti')) || (b.innerText && b.innerText.includes('Cetak Bukti')));
                 if (cetakBtn) {
                     window.open = function(url) { window.location.href = url; };
                     cetakBtn.click();
                     return true;
                 }
                 return false;
             });
             if (clicked) {
                 if (onProgress) onProgress('📸 Mengambil bukti daftar ulang...');
                 await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
                 await new Promise(r => setTimeout(r, 1500));
                 ss = await page.screenshot({ type: 'jpeg', quality: 90, fullPage: true });
                 msg += `\n\n📄 **Bukti Daftar Ulang terlampir pada gambar di atas.**`;
             }
         }

         await browser.close();
         return { 
             success: true, 
             screenshot: ss, // Will be null if both failed, but image buffer if successful
             isRegistered: true,
             message: msg
         };
    }

    if (onProgress) onProgress('💳 Membuka Detil Bayar...');

    const clickedDetail = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a'));
        const detailLink = links.find(l => l.innerText.includes('Detil Bayar'));
        if (detailLink) {
            window.open = function(url) { window.location.href = url; };
            if (detailLink.target === '_blank') detailLink.target = '_self';
            detailLink.click();
            return true;
        }
        return false;
    });

    if (!clickedDetail) {
        const ss = await page.screenshot({ type: 'jpeg', quality: 90, fullPage: true });
        await browser.close();
        
        let msgDetail = `⚠️ **Belum Daftar Ulang / Terdapat Tagihan**\n\n📝 **Status UKT:** ${info.uktStatus || '-'}\n📝 **Status IKOMA:** ${info.ikomaStatus || '-'}`;
        if (info.perpusStatus) msgDetail += `\n📚 **Perpustakaan:**\n${info.perpusStatus}`;
        if (info.tunggakanStatus) msgDetail += `\n💸 **Tunggakan Keuangan:** ${info.tunggakanStatus}`;
        if (info.updateDataStatus) msgDetail += `\n🔄 **Update Data:** ${info.updateDataStatus}`;
        msgDetail += `\n\n*(Tombol Detil Bayar tidak ditemukan)*`;

        return { 
            success: true, 
            screenshot: ss,
            isRegistered: false,
            message: msgDetail
        };
    }

    await new Promise(r => setTimeout(r, 4000));
    const pages = await browser.pages();
    const detailPage = pages[pages.length - 1];

    const popupInfo = await detailPage.evaluate(() => {
         const bodyText = document.body.innerText || '';
         let uktAmount = '0';
         let ikomaAmount = '0';
         
         const lines = bodyText.split('\n');
         for (let i = 0; i < lines.length; i++) {
             if (lines[i].includes('Uang Kuliah Tunggal/SPP')) {
                 uktAmount = lines[i].split('Rp.')[1]?.trim() || '0';
             }
             if (lines[i].includes('Uang Ikoma')) {
                 ikomaAmount = lines[i].split('Rp.')[1]?.trim() || '0';
             }
         }
         return { uktAmount, ikomaAmount };
    });

    const ss = await detailPage.screenshot({ type: 'jpeg', quality: 90, fullPage: true });
    await browser.close();

    let msgDetail = `⚠️ **Tagihan Daftar Ulang Anda**\n\n📝 **Status UKT:** ${info.uktStatus || '-'}\n📝 **Status IKOMA:** ${info.ikomaStatus || '-'}`;
    if (info.perpusStatus) msgDetail += `\n📚 **Perpustakaan:**\n${info.perpusStatus}`;
    if (info.tunggakanStatus) msgDetail += `\n💸 **Tunggakan Keuangan:** ${info.tunggakanStatus}`;
    if (info.updateDataStatus) msgDetail += `\n🔄 **Update Data:** ${info.updateDataStatus}`;
    msgDetail += `\n\n💰 **Rincian Pembayaran:**\n- UKT/SPP: Rp. ${popupInfo.uktAmount}\n- IKOMA: Rp. ${popupInfo.ikomaAmount}`;

    return {
        success: true,
        screenshot: ss,
        isRegistered: false,
        message: msgDetail
    };

  } catch (error) {
    if (browser) await browser.close().catch(()=>{});
    return { success: false, error: error.message };
  }
}

async function getCetakRaportOptions(email, password, onProgress) {
  if (onProgress) onProgress('Memulai eksekusi Puppeteer untuk mengambil opsi raport...');

  const executablePath = findBrowserExecutable();
  if (!executablePath) return { success: false, error: 'Browser tidak ditemukan di sistem ini.' };

  const isHeadless = process.env.HEADLESS !== 'false';
  const browserArgs = [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--ignore-certificate-errors', '--ignore-ssl-errors', '--ignore-certificate-errors-spki-list',
    '--allow-insecure-localhost', '--disable-web-security',
    '--disable-features=IsolateOrigins,site-per-process,RendererCodeIntegrity',
    '--disable-background-networking', '--disable-sync', '--no-first-run',
    '--no-default-browser-check', '--disable-translate', '--disable-infobars',
    '--window-size=1280,800'
  ];
  if (isHeadless) browserArgs.push('--disable-gpu');

  const browser = await puppeteer.launch({ headless: isHeadless, executablePath, args: browserArgs, defaultViewport: { width: 1280, height: 800 } });

  try {
    const page = await browser.newPage();
    if (onProgress) onProgress('🌐 Menuju portal login MIS PENS (CAS)...');
    
    await page.goto('https://login.pens.ac.id/cas/login?service=https%3A%2F%2Fonline.mis.pens.ac.id%2Findex.php%3FLogin%3D1%26halAwal%3D1', { waitUntil: 'load', timeout: 45000 });
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

    if (onProgress) onProgress('📸 Membuka menu Cetak Raport...');
    
    let foundMenu = false;
    const menuLocators = await page.$x("//div[@class='mainmenu']//a[normalize-space(text())='Akademik']");
    if (menuLocators.length > 0) {
        if (onProgress) onProgress('👆 Hovering menu Akademik...');
        await menuLocators[0].hover();
        await new Promise(r => setTimeout(r, 1500));
        
        const submenuLocators = await page.$x("//div[@class='mainmenu']//a[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'cetak raport') or contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'cetak rapot')]");
        if (submenuLocators.length > 0) {
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}),
                submenuLocators[0].click()
            ]);
            foundMenu = true;
        }
    }

    if (!foundMenu) {
        if (onProgress) onProgress('⚠️ Hover gagal, mencari fallback link Cetak Raport...');
        const clickedFallback = await page.evaluate(() => {
           const links = Array.from(document.querySelectorAll('a, button, li, div'));
           for (const link of links) {
               const text = (link.innerText || '').toLowerCase();
               const href = (link.href || '').toLowerCase();
               if (text.includes('cetak raport') || text.includes('cetak rapot') || href.includes('mraportmbkm.php')) {
                   if (link.href) window.location.href = link.href;
                   else link.click();
                   return true;
               }
           }
           // Direct navigate as last resort
           window.location.href = 'mRaportMBKM.php';
           return true;
        });

        if (clickedFallback) {
             await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
        } else {
             await browser.close();
             return { success: false, error: 'Gagal menemukan menu Cetak Raport.' };
        }
    }

    await new Promise(r => setTimeout(r, 2000));
    if (onProgress) onProgress('🔎 Mengambil opsi Tahun Ajaran dan Semester...');

    const options = await page.evaluate(() => {
        const selects = document.querySelectorAll('select');
        let taOptions = [];
        let semOptions = [];
        
        // Find selects by inspecting preceding text or order
        for (let sel of selects) {
            const prevText = sel.previousSibling ? sel.previousSibling.textContent.trim().toLowerCase() : '';
            const parentText = sel.parentElement.innerText.toLowerCase();
            if (prevText.includes('tahun ajaran') || parentText.includes('tahun ajaran')) {
                taOptions = Array.from(sel.options).map(o => ({ value: o.value, text: o.text }));
            } else if (prevText.includes('semester') || parentText.includes('semester')) {
                semOptions = Array.from(sel.options).map(o => ({ value: o.value, text: o.text }));
            }
        }
        
        // Fallback if labels not easily associated
        if (taOptions.length === 0 && selects.length >= 2) {
            taOptions = Array.from(selects[0].options).map(o => ({ value: o.value, text: o.text }));
            semOptions = Array.from(selects[1].options).map(o => ({ value: o.value, text: o.text }));
        }

        return { taOptions, semOptions };
    });

    await browser.close();
    return { success: true, options };

  } catch (error) {
    if (browser) await browser.close().catch(()=>{});
    return { success: false, error: error.message };
  }
}

async function executeCetakRaport(email, password, taValue, semValue, onProgress) {
  if (onProgress) onProgress(`Memulai eksekusi Puppeteer untuk cetak raport (TA: ${taValue}, Sem: ${semValue})...`);

  const executablePath = findBrowserExecutable();
  if (!executablePath) return { success: false, error: 'Browser tidak ditemukan di sistem ini.' };

  const isHeadless = process.env.HEADLESS !== 'false';
  const browserArgs = [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--ignore-certificate-errors', '--ignore-ssl-errors', '--ignore-certificate-errors-spki-list',
    '--allow-insecure-localhost', '--disable-web-security',
    '--disable-features=IsolateOrigins,site-per-process,RendererCodeIntegrity',
    '--disable-background-networking', '--disable-sync', '--no-first-run',
    '--no-default-browser-check', '--disable-translate', '--disable-infobars',
    '--window-size=1280,800'
  ];
  if (isHeadless) browserArgs.push('--disable-gpu');

  const browser = await puppeteer.launch({ headless: isHeadless, executablePath, args: browserArgs, defaultViewport: { width: 1280, height: 800 } });

  try {
    const page = await browser.newPage();
    if (onProgress) onProgress('🌐 Menuju portal login MIS PENS...');
    
    await page.goto('https://login.pens.ac.id/cas/login?service=https%3A%2F%2Fonline.mis.pens.ac.id%2Findex.php%3FLogin%3D1%26halAwal%3D1', { waitUntil: 'load', timeout: 45000 });
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

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
    
    let foundMenu = false;
    const menuLocators = await page.$x("//div[@class='mainmenu']//a[normalize-space(text())='Akademik']");
    if (menuLocators.length > 0) {
        await menuLocators[0].hover();
        await new Promise(r => setTimeout(r, 1500));
        const submenuLocators = await page.$x("//div[@class='mainmenu']//a[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'cetak raport') or contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'cetak rapot')]");
        if (submenuLocators.length > 0) {
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}),
                submenuLocators[0].click()
            ]);
            foundMenu = true;
        }
    }

    if (!foundMenu) {
        const clickedFallback = await page.evaluate(() => {
           const links = Array.from(document.querySelectorAll('a, button, li, div'));
           for (const link of links) {
               const text = (link.innerText || '').toLowerCase();
               const href = (link.href || '').toLowerCase();
               if (text.includes('cetak raport') || text.includes('cetak rapot') || href.includes('mraportmbkm.php')) {
                   if (link.href) window.location.href = link.href;
                   else link.click();
                   return true;
               }
           }
           // Direct navigate as last resort
           window.location.href = 'mRaportMBKM.php';
           return true;
        });

        if (clickedFallback) {
             await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
        } else {
             await browser.close();
             return { success: false, error: 'Gagal menemukan menu Cetak Raport.' };
        }
    }

    await new Promise(r => setTimeout(r, 2000));
    // We don't send progress here anymore to keep it quiet
    // if (onProgress) onProgress('⚙️ Mengatur Tahun Ajaran dan Semester...');

    // Select options
    await page.evaluate((ta, sem) => {
        const selects = document.querySelectorAll('select');
        let taSelect = null;
        let semSelect = null;
        
        for (let sel of selects) {
            const prevText = sel.previousSibling ? sel.previousSibling.textContent.trim().toLowerCase() : '';
            const parentText = sel.parentElement.innerText.toLowerCase();
            if (prevText.includes('tahun ajaran') || parentText.includes('tahun ajaran')) {
                taSelect = sel;
            } else if (prevText.includes('semester') || parentText.includes('semester')) {
                semSelect = sel;
            }
        }
        
        if (!taSelect && selects.length >= 2) {
            taSelect = selects[0];
            semSelect = selects[1];
        }

        if (taSelect) { taSelect.value = ta; taSelect.dispatchEvent(new Event('change')); }
        if (semSelect) { semSelect.value = sem; semSelect.dispatchEvent(new Event('change')); }
    }, taValue, semValue);
    
    await new Promise(r => setTimeout(r, 1000));
    
    let alertMessage = null;
    page.on('dialog', async dialog => {
        alertMessage = dialog.message();
        await dialog.accept();
    });

    const navResult = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('input[type="button"], input[type="submit"], button, a'));
        const cetakBtn = btns.find(b => {
             const val = (b.value || '').toLowerCase();
             const txt = (b.innerText || '').toLowerCase();
             return val.includes('cetak raport') || txt.includes('cetak raport') || val.includes('cetak rapot') || txt.includes('cetak rapot');
        });
        if (cetakBtn) {
            const onclickAttr = cetakBtn.getAttribute('onclick') || '';
            const match = onclickAttr.match(/cetak_raportMBKM\s*\(\s*'?"?(\d+)'?"?\s*,\s*'?"?(\d+)'?"?\s*\)/);
            if (match) {
                return { type: 'url', url: `cetak_raportMBKM.php?valTahun=${match[1]}&valSemester=${match[2]}` };
            }

            window.open = function(url) { window.location.href = url; };
            if (cetakBtn.tagName.toLowerCase() === 'button') cetakBtn.type = 'button';
            if (cetakBtn.tagName.toLowerCase() === 'input' && cetakBtn.type === 'submit') cetakBtn.type = 'button';
            if (cetakBtn.target === '_blank') cetakBtn.target = '_self';
            
            cetakBtn.click();
            return { type: 'click' };
        }
        return { type: 'not_found' };
    });

    if (navResult.type === 'not_found') {
        const ss = await page.screenshot({ type: 'jpeg', quality: 90, fullPage: true });
        await browser.close();
        return { success: false, error: 'Tombol Cetak Raport tidak ditemukan.', screenshot: ss };
    }

    if (navResult.type === 'url') {
        await page.goto(new URL(navResult.url, page.url()).href, { waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    } else {
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    }

    await new Promise(r => setTimeout(r, 2000));
    
    if (alertMessage) {
        await browser.close();
        return { success: false, error: `Terdapat peringatan dari sistem MIS:\n\n${alertMessage}` };
    }

    // The raport may have opened in the same page or a new tab
    const pages = await browser.pages();
    const raportPage = pages[pages.length - 1];
    
    await raportPage.waitForNetworkIdle({ idleTime: 500, timeout: 10000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));

    const ss = await raportPage.screenshot({ type: 'jpeg', quality: 90, fullPage: true });
    await browser.close();

    return { success: true, screenshot: ss };

  } catch (error) {
    if (browser) await browser.close().catch(()=>{});
    return { success: false, error: error.message };
  }
}

module.exports = { getScheduleMis, getPresensiMis, getDaftarUlangMis, getCetakRaportOptions, executeCetakRaport };
