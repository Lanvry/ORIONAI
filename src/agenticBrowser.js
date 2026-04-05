const puppeteer = require('puppeteer-core');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');

// Reuse existing browser finding logic from etholService if possible
// We will redefine it here cleanly to avoid circular deps or requiring changes to etholService
function findBrowserExecutable() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const winPaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env.PROGRAMFILES + '\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env.LOCALAPPDATA + '\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const candidate of winPaths) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const AGENT_SYSTEM_PROMPT = `You are "Orion Web Agent", a smart and casual AI assistant. 
You are given a SCREENSHOT of a webpage along with a list of interactive elements found on the page.
Each interactive element in the image has a RED badge with a number, which corresponds to its "id" in the JSON list provided.

Your objective is to accomplish the user's instructions.
Output ONLY a valid JSON object with the next action to take. 

Valid Actions:
1. "click": { "action": "click", "id": "NUMBER", "reason": "alasan aksi singkat bahasa santai (misal: 'klik tombol cari')" } - To click a marked element.
2. "type": { "action": "type", "id": "NUMBER", "text": "text to type", "reason": "..." } - To enter text into an input.
3. "scroll": { "action": "scroll", "direction": "down/up", "reason": "..." } - To scroll the page if target is not visible.
4. "done": { "action": "done", "summary": "Kesimpulan/hasil pencarian dengan bahasa Indonesia gaul, santai, pendek & to-the-point" } - To finish.

Constraints:
- You must output VALID JSON only. Do not add markdown backticks outside. 
- You must select an ID that actually exists in the provided list.
- Tulis 'reason' dan 'summary' dalam bahasa Indonesia yang santai, akrab (pakai kata 'aku', 'kak'), pendek (jangan kaku kayak robot).`;

async function executeAgenticTask(url, instruction, onProgress, onSnapshot) {
  const executablePath = findBrowserExecutable();
  if (!executablePath) throw new Error('Browser tidak ditemukan (Chrome/Edge).');

  const isHeadless = process.env.HEADLESS !== 'false';
  const browserArgs = [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--ignore-certificate-errors', '--disable-web-security',
    '--window-size=1280,800'
  ];

  if (onProgress) onProgress(`🌐 Membuka browser...`);
  const browser = await puppeteer.launch({
    headless: isHeadless,
    executablePath,
    args: browserArgs,
    defaultViewport: { width: 1280, height: 800 }
  });

  const page = await browser.newPage();
  await page.setDefaultNavigationTimeout(30000);
  
  if (onProgress) onProgress(`🧭 Menavigasi ke: ${url}`);
  await page.goto(url, { waitUntil: 'load' }).catch(()=>{});

  // Ambil API key
  const apiKeyMain = process.env.GEMINI_API_KEY;
  const apiKeyBackup = process.env.GEMINI_API_KEY_2;
  
  if (!apiKeyMain && !apiKeyBackup) {
    await browser.close();
    throw new Error('GEMINI_API_KEY tidak ditemukan.');
  }

  let genAI = new GoogleGenerativeAI(apiKeyMain || apiKeyBackup);
  let model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash', generationConfig: { temperature: 0.2, responseMimeType: "application/json" } });

  let stepCount = 0;
  const MAX_STEPS = 10;
  let isDone = false;

  while (!isDone && stepCount < MAX_STEPS) {
    stepCount++;
    if (onProgress) onProgress(`\n🔄 [Step ${stepCount}/${MAX_STEPS}] Menganalisa halaman...`);

    // 1. Membersihkan mark lama & menyuntikkan ID baru (Visual DOM Mapping)
    const elementsInfo = await page.evaluate(() => {
      document.querySelectorAll('[data-ai-badge]').forEach(b => b.remove());
      document.querySelectorAll('[data-ai-id]').forEach(el => el.removeAttribute('data-ai-id'));

      let idCounter = 1;
      const elements = [];
      const interactables = document.querySelectorAll('a, button, input, select, textarea');
      
      const fragment = document.createDocumentFragment();

      interactables.forEach(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0 || rect.top < 0 || rect.top > window.innerHeight) return;
        const style = window.getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return;

        const aiId = String(idCounter++);
        el.setAttribute('data-ai-id', aiId);

        // Add visual red badge
        const badge = document.createElement('div');
        badge.innerText = aiId;
        badge.style.position = 'absolute';
        badge.style.backgroundColor = 'red';
        badge.style.color = 'white';
        badge.style.fontSize = '12px';
        badge.style.fontWeight = 'bold';
        badge.style.padding = '0 3px';
        badge.style.borderRadius = '3px';
        badge.style.zIndex = '999999';
        badge.style.top = (rect.top + window.scrollY) + 'px';
        badge.style.left = (rect.left + window.scrollX) + 'px';
        badge.setAttribute('data-ai-badge', 'true');
        fragment.appendChild(badge);

        const text = (el.innerText || el.placeholder || el.value || '').trim().substring(0, 50);
        elements.push({ id: aiId, tag: el.tagName.toLowerCase(), type: el.type || '', text });
      });
      document.body.appendChild(fragment);
      return elements;
    });

    await new Promise(r => setTimeout(r, 500)); // wait for DOM update
    const screenshotBuffer = await page.screenshot({ type: 'jpeg', quality: 70 });
    
    if (onSnapshot) await onSnapshot(screenshotBuffer, `🤖 Evaluasi visual - Langkah ${stepCount}`);

    // Jika tidak ada elemen
    if (elementsInfo.length === 0) {
      if (onProgress) onProgress(`⚠️ Tidak ada elemen yang bisa diklik. Stop.`);
      break;
    }

    // 2. Format konteks untuk AI
    const stateDescription = `INSTRUCTION: ${instruction}
CURRENT URL: ${page.url()}
VISIBLE ELEMENTS:\n${JSON.stringify(elementsInfo, null, 2)}`;

    try {
      if (onProgress) onProgress(`🧠 Gemini sedang berpikir tindakan selanjutnya...`);

      let result;
      try {
        result = await model.generateContent({
          contents: [{
            role: 'user',
            parts: [
              { text: AGENT_SYSTEM_PROMPT + '\n\n' + stateDescription },
              { inlineData: { data: screenshotBuffer.toString('base64'), mimeType: 'image/jpeg' } }
            ]
          }]
        });
      } catch (geminiError) {
        console.error(`[AI Error Utama] ${geminiError.message}`);
        // Fallback jika API utama error
        if (apiKeyMain && apiKeyBackup) {
          if (onProgress) onProgress(`🔄 API utama gagal (${geminiError.message.substring(0, 30)}). Beralih ke Gemini Ke-2...`);
          const genAIBackup = new GoogleGenerativeAI(apiKeyBackup);
          const modelBackup = genAIBackup.getGenerativeModel({ model: 'gemini-2.5-flash', generationConfig: { temperature: 0.2, responseMimeType: "application/json" } });
          
          result = await modelBackup.generateContent({
            contents: [{
              role: 'user',
              parts: [
                { text: AGENT_SYSTEM_PROMPT + '\n\n' + stateDescription },
                { inlineData: { data: screenshotBuffer.toString('base64'), mimeType: 'image/jpeg' } }
              ]
            }]
          });
        } else {
          throw geminiError;
        }
      }

      let jsonResp = result.response.text().trim();
      if (jsonResp.startsWith('\`\`\`json')) {
         jsonResp = jsonResp.replace(/\`\`\`json/g, '').replace(/\`\`\`/g, '').trim();
      }

      console.log(`[AI Response] ${jsonResp}`);
      const action = JSON.parse(jsonResp);

      if (onProgress && action.reason) onProgress(`⚡ Eksekusi AI: *${action.action.toUpperCase()}* - ${action.reason}`);

      // 3. Eksekusi Aksi di Puppeteer
      if (action.action === 'done') {
        isDone = true;
        if (onProgress) onProgress(`\u2728 **Beres Kak!**\n\n"${action.summary || 'Tugas udah selesai aku kerjain!'}"`);
      } else if (action.action === 'click') {
        await page.evaluate((id) => {
          const el = document.querySelector('[data-ai-id="' + id + '"]');
          if (el) el.click();
        }, action.id);
        await new Promise(r => setTimeout(r, 2000)); // wait for page reaction
      } else if (action.action === 'type') {
        const selector = '[data-ai-id="' + action.id + '"]';
        await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (el) { el.value = ''; el.focus(); }
        }, selector);
        await page.type(selector, action.text, { delay: 50 });
        await new Promise(r => setTimeout(r, 500));
      } else if (action.action === 'scroll') {
         await page.evaluate((dir) => {
           window.scrollBy(0, dir === 'down' ? 500 : -500);
         }, action.direction);
         await new Promise(r => setTimeout(r, 1000));
      }

    } catch (err) {
      if (onProgress) onProgress(`❌ Format respon AI gagal diurai: ${err.message}`);
      // Lanjut coba di loop berikutnya
    }
  }

  // Berikan screenshot halaman akhir sebelum ditutup (simpan state rapi tanpa label DOM)
  await page.evaluate(() => {
    document.querySelectorAll('[data-ai-badge]').forEach(b => b.remove());
  });
  const finalSS = await page.screenshot({ type: 'jpeg', quality: 90 });
  if (onSnapshot) await onSnapshot(finalSS, `🏁 Tugas selesai.`);
  
  await browser.close();
}

module.exports = { executeAgenticTask };
