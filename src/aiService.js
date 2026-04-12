const axios = require('axios');

// ─── AI Instance (Multi-Key Rotation) ─────────────────────────────────────────
const GEMINI_KEYS = [];

function initGeminiKeys() {
  if (GEMINI_KEYS.length > 0) return;
  if (process.env.GEMINI_API_KEY) GEMINI_KEYS.push(process.env.GEMINI_API_KEY);
  if (process.env.GEMINI_API_KEY_2) GEMINI_KEYS.push(process.env.GEMINI_API_KEY_2);
}

// ─── AI Chat & Fallback ─────────────────────────────────────────────
const chatHistories = {};

async function askSiputzxGLM(chatId, userParts, systemInstruction, pastHistory, onStream) {
  let hasImage = false;
  let textPrompt = '';
  
  if (typeof userParts === 'string') {
    textPrompt = userParts;
  } else if (Array.isArray(userParts)) {
    for (const part of userParts) {
      if (typeof part === 'string') textPrompt += part + '\n';
      else if (part.text) textPrompt += part.text + '\n';
      else if (part.inlineData) hasImage = true;
    }
  }

  if (hasImage) {
    throw new Error('Siputzx GLM-4 tidak mendukung input gambar.');
  }

  let historyText = '';
  if (pastHistory && pastHistory.length > 0) {
    historyText += '--- RIWAYAT CHAT ---\n';
    for (const msg of pastHistory) {
      const role = msg.role === 'model' ? 'Orion' : 'User';
      const partsText = msg.parts.map(p => p.text).join('\n');
      historyText += `${role}: ${partsText}\n`;
    }
    historyText += '--------------------\n\n';
  }
  
  const finalPrompt = historyText + 'User: ' + textPrompt;
  const url = `https://api.siputzx.my.id/api/ai/gptoss120b?prompt=${encodeURIComponent(finalPrompt)}&system=${encodeURIComponent(systemInstruction)}&temperature=0.7`;

  if (onStream) onStream('Waiting for response...');

  const response = await axios.get(url, { timeout: 30000 });
  if (response.data && response.data.status === true && response.data.data && response.data.data.response) {
    return response.data.data.response;
  } else {
    throw new Error('Respons tidak valid dari Siputzx.');
  }
}

// Daftar model OpenRouter (urutan prioritas, fallback otomatis jika 404/error)
const OPENROUTER_MODELS = [
  process.env.OPENROUTER_MODEL,
  'meta-llama/llama-3.1-8b-instruct:free',
  'google/gemma-3-12b-it:free',
  'mistralai/mistral-7b-instruct:free',
].filter(Boolean);

async function callOpenRouterWithModel(model, messages, apiKey, onStream) {
  const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
    model: model,
    messages: messages,
    temperature: 0.7,
    stream: true,
  }, {
    responseType: 'stream',
    timeout: 60000,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/Lanvry/ORIONAI',
      'X-Title': 'Orion AI'
    }
  });

  return new Promise((resolve, reject) => {
    let fullText = '';
    let lastEditTime = 0;
    let partialChunk = '';

    response.data.on('data', (chunk) => {
      partialChunk += chunk.toString('utf8');
      const lines = partialChunk.split('\n');
      partialChunk = lines.pop() || '';

      for (let line of lines) {
        line = line.trim();
        if (line === 'data: [DONE]') continue;
        if (line.startsWith('data: ')) {
          try {
            const parsed = JSON.parse(line.slice(6));
            // Tangani error di dalam stream (misal: model tidak ada)
            if (parsed.error) {
              reject(new Error(`OpenRouter stream error: ${parsed.error.message || JSON.stringify(parsed.error)}`));
              return;
            }
            if (parsed.choices && parsed.choices[0].delta && parsed.choices[0].delta.content) {
              fullText += parsed.choices[0].delta.content;
            }
          } catch (e) {
            // Ignore SSE decode error
          }
        }
      }

      const now = Date.now();
      if (now - lastEditTime > 1500) {
        lastEditTime = now;
        if (onStream && fullText) onStream(fullText);
      }
    });

    response.data.on('end', () => resolve(fullText));
    response.data.on('error', reject);
  });
}

async function askOpenRouter(chatId, userParts, systemInstruction, pastHistory, onStream) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('API Key OpenRouter tidak ada (.env).');

  const messages = [];
  messages.push({ role: 'system', content: systemInstruction });

  for (const msg of pastHistory) {
    const role = msg.role === 'model' ? 'assistant' : 'user';
    const textParts = msg.parts.map(p => p.text).join('\n');
    messages.push({ role, content: textParts });
  }

  let currentUserContent;
  if (typeof userParts === 'string') {
    currentUserContent = userParts;
  } else if (Array.isArray(userParts)) {
    currentUserContent = [];
    for (const part of userParts) {
      if (typeof part === 'string') {
        currentUserContent.push({ type: 'text', text: part });
      } else if (part.text) {
        currentUserContent.push({ type: 'text', text: part.text });
      } else if (part.inlineData) {
        currentUserContent.push({
          type: 'image_url',
          image_url: { url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}` }
        });
      }
    }
  }

  messages.push({ role: 'user', content: currentUserContent });

  let lastError = null;
  for (let i = 0; i < OPENROUTER_MODELS.length; i++) {
    const model = OPENROUTER_MODELS[i];
    try {
      console.log(`[AI] Mencoba OpenRouter model: ${model}...`);
      const result = await callOpenRouterWithModel(model, messages, apiKey, onStream);
      if (result && result.trim().length > 0) return result;
      console.warn(`[AI] OpenRouter model ${model} menghasilkan respons kosong, mencoba model berikutnya...`);
    } catch (err) {
      const statusCode = err.response && err.response.status;
      const is429 = statusCode === 429;
      const is404 = statusCode === 404 || (err.message && err.message.includes('404'));

      if (is404) {
        console.warn(`[AI] OpenRouter model "${model}" tidak ditemukan (404), mencoba model berikutnya...`);
        lastError = err;
        continue;
      }

      if (is429) {
        if (i === 0 && OPENROUTER_MODELS.length > 1) {
          console.warn(`[AI] OpenRouter rate limit (429), mencoba model berikutnya...`);
          lastError = err;
          continue;
        }
        throw new Error('Terlalu banyak permintaan ke OpenRouter (Rate limit tercapai).');
      }

      lastError = err;
      console.warn(`[AI] OpenRouter model "${model}" error: ${err.message}`);
      // Jika bukan 404/429, langsung lempar error (misal: auth error)
      if (!is404 && !is429) break;
    }
  }

  throw new Error(`OpenRouter gagal (semua model dicoba): ${lastError ? lastError.message : 'Unknown error'}`);
}

async function askGeminiWithREST(keyIndex, chatId, userMessage, systemInstructionText, pastHistory, onStream) {
  const apiKey = GEMINI_KEYS[keyIndex];
  if (!apiKey) return null;

  const contents = [];
  
  if (pastHistory && pastHistory.length > 0) {
    pastHistory.forEach(h => {
      contents.push({
        role: h.role, // 'user' or 'model'
        parts: h.parts
      });
    });
  }

  contents.push({
    role: 'user',
    parts: [{ text: userMessage }]
  });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse&key=${apiKey}`;

  const payload = {
    contents: contents,
    system_instruction: {
      parts: { text: systemInstructionText }
    },
    generationConfig: {
      maxOutputTokens: 2048,
      temperature: 0.7
    }
  };

  const response = await axios.post(url, payload, { timeout: 12000, responseType: 'stream' });

  return new Promise((resolve, reject) => {
    let fullText = '';
    let lastEditTime = 0;
    let partialChunk = '';

    response.data.on('data', (chunk) => {
      partialChunk += chunk.toString('utf8');
      const lines = partialChunk.split('\n');
      partialChunk = lines.pop() || ''; 
      for (let line of lines) {
        line = line.trim();
        if (line === '') continue;
        if (line.startsWith('data: ')) {
          try {
            const parsed = JSON.parse(line.slice(6));
            if (parsed.candidates && parsed.candidates[0].content && parsed.candidates[0].content.parts) {
              parsed.candidates[0].content.parts.forEach(p => {
                if (p.text) fullText += p.text;
              });
            }
          } catch (e) {}
        }
      }
      const now = Date.now();
      if (now - lastEditTime > 1500) {
        lastEditTime = now;
        if (onStream && fullText) onStream(fullText);
      }
    });

    response.data.on('end', () => {
      if (!chatHistories[chatId]) chatHistories[chatId] = { history: [] };
      chatHistories[chatId].history.push({ role: 'user', parts: [{ text: userMessage }] });
      chatHistories[chatId].history.push({ role: 'model', parts: [{ text: fullText }] });
      resolve(fullText);
    });

    response.data.on('error', reject);
  });
}

async function askAI(chatId, userMessage, assignmentsObj = [], courses = [], onStream = null, customBotPersona = null) {
  initGeminiKeys();
  if (GEMINI_KEYS.length === 0) {
    return 'Gemini API Key belum dikonfigurasi. Tambahkan GEMINI_API_KEY di file .env';
  }

  let tugasContext = '';
  if (courses && courses.length > 0) {
    tugasContext += '\n\n=== DAFTAR KELAS ===\n';
    courses.forEach((c, i) => {
      tugasContext += `${i + 1}. ${c.name}${c.section ? ` (${c.section})` : ''}\n`;
    });
  }

  const pending = Array.isArray(assignmentsObj) ? assignmentsObj : assignmentsObj.pending || [];
  if (pending.length > 0) {
    tugasContext += '\n=== TUGAS AKTIF ===\n';
    pending.slice(0, 10).forEach((a, i) => {
      const deadline = a.dueDate ? a.dueDate.toLocaleString('id-ID') : 'Tanpa deadline';
      tugasContext += `${i + 1}. ${a.title} (${a.courseName}) — Deadline: ${deadline}\n`;
      if (a.description) tugasContext += `   Deskripsi: ${a.description.slice(0, 100)}...\n`;
    });
    tugasContext += '===========================\n';
  }

  const pastHistory = chatHistories[chatId] ? chatHistories[chatId].history : [];

  let systemInstructionText = '';
  if (customBotPersona) {
      systemInstructionText = customBotPersona + '\n\n' + tugasContext;
  } else {
      systemInstructionText = 'Kamu adalah Orion, asisten AI pribadi mahasiswa yang cerdas dan asik.\n\n' +
        'Instruksi Gaya Bahasa (SANGAT PENTING - HEMAT TOKEN):\n' +
        '1. Balas dengan SANGAT SINGKAT, langsung ke intinya (to the point).\n' +
        '2. Gunakan gaya bahasa santai, gaul, layaknya ngobrol sama teman (pakai "aku" dan sapa "kak").\n' +
        '3. JANGAN mengulang pertanyaan.\n' +
        '4. Sisipkan 1-2 emoji saja secukupnya.\n' +
        '5. Gunakan format tebal (bold) untuk poin penting.\n\n' +
        tugasContext;
  }

  for (let keyIdx = 0; keyIdx < GEMINI_KEYS.length; keyIdx++) {
    try {
      const keyLabel = keyIdx === 0 ? 'Primary' : 'Backup-' + keyIdx;
      console.log(`[AI] Trying REST Gemini ${keyLabel} (key ${keyIdx + 1}/${GEMINI_KEYS.length})...`);
      const answer = await askGeminiWithREST(keyIdx, chatId, userMessage, systemInstructionText, pastHistory, onStream);
      if (answer && answer.trim().length > 0) return answer;
      // Jika jawaban kosong, lanjut ke key berikutnya
      console.warn(`[AI] Gemini key ${keyIdx + 1} mengembalikan respons kosong, mencoba key berikutnya...`);
    } catch (err) {
      const errMsg = err.message ? err.message.toLowerCase() : '';
      const isAxiosError = err.response && err.response.data && err.response.data.error;
      const trueErrMsg = isAxiosError ? err.response.data.error.message : errMsg;
      // Selalu lanjut ke Gemini key berikutnya untuk SEMUA jenis error
      console.warn(`[AI] Gemini key ${keyIdx + 1} error (${trueErrMsg.substring(0, 50)}), mencoba key berikutnya...`);
    }
  }

  console.warn('[AI] Semua Gemini key gagal/habis. Mencoba Siputzx...');
  try {
    const siputzxAnswer = await askSiputzxGLM(chatId, userMessage, systemInstructionText, pastHistory, onStream);
    // Cek apakah Siputzx memberikan respons yang valid (tidak kosong)
    if (siputzxAnswer && siputzxAnswer.trim().length > 0) {
      return siputzxAnswer;
    }
    console.warn('[AI] Siputzx tidak memberikan respons (kosong), falling back ke OpenRouter...');
  } catch (errGlm) {
    console.warn('[AI] Siputzx error:', errGlm.message, '→ falling back ke OpenRouter...');
  }

  console.warn('[AI] Mencoba OpenRouter sebagai fallback terakhir...');
  return await askOpenRouter(chatId, userMessage, systemInstructionText, pastHistory, onStream);
}

async function ringkasAssignmentWithREST(keyIndex, prompt) {
  const apiKey = GEMINI_KEYS[keyIndex];
  if (!apiKey) return null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  const payload = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }]
  };
  const response = await axios.post(url, payload, { timeout: 12000 });
  if (response.data && response.data.candidates && response.data.candidates[0].content) {
    return response.data.candidates[0].content.parts[0].text;
  }
  throw new Error('Format invalid in REST ringkas');
}

async function ringkasAssignment(assignment, onStream) {
  initGeminiKeys();
  if (GEMINI_KEYS.length === 0) return 'GEMINI_API_KEY belum dikonfigurasi.';

  const prompt =
    'Tolong ringkas tugas kuliah berikut dalam 3-5 poin singkat dan jelas, tanpa format rumbit.\n\n' +
    'Judul: ' + assignment.title + '\n' +
    'Mata Kuliah: ' + assignment.courseName + '\n' +
    'Deskripsi: ' + (assignment.description || '(tidak ada)');

  for (let keyIdx = 0; keyIdx < GEMINI_KEYS.length; keyIdx++) {
    try {
      const result = await ringkasAssignmentWithREST(keyIdx, prompt);
      if (result) return result;
    } catch (err) {
      const errMsg = err.message ? err.message.toLowerCase() : '';
      const isAxiosError = err.response && err.response.data && err.response.data.error;
      const trueErrMsg = isAxiosError ? err.response.data.error.message : errMsg;
      
      const shouldFallback = trueErrMsg.includes('quota') || trueErrMsg.includes('429') || trueErrMsg.includes('exhausted') || trueErrMsg.includes('503') || trueErrMsg.includes('unavailable');
      if (shouldFallback) {
        console.warn(`[AI] Gemini key ${keyIdx + 1} sibuk (ringkas), lanjut...`);
        continue;
      }
      break;
    }
  }

  console.warn('[AI] Gemini REST API full fallback. Trying Siputzx...');
  try {
    return await askSiputzxGLM('ringkas', prompt, 'Kamu adalah AI akademik perangkum.', [], onStream);
  } catch (errGlm) {
    console.warn('[AI] Siputzx gagal:', errGlm.message, 'falling back to OpenRouter...');
    return await askOpenRouter('ringkas', prompt, 'Kamu adalah AI akademik perangkum.', [], onStream);
  }
}

module.exports = {
  askAI,
  ringkasAssignment
};
