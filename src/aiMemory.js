const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MEMORY_FILE = path.join(__dirname, '../data/ai_memory.json');

function ensureFile() {
  if (!fs.existsSync(MEMORY_FILE)) {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify({ memories: [] }, null, 2));
  }
}

function loadAll() {
  ensureFile();
  try {
    return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8')).memories || [];
  } catch {
    return [];
  }
}

function saveAll(memories) {
  ensureFile();
  fs.writeFileSync(MEMORY_FILE, JSON.stringify({ memories }, null, 2));
}

function addMemory(topic, detail) {
  const memories = loadAll();
  const id = crypto.randomBytes(4).toString('hex');
  memories.push({ id, topic: topic.trim(), detail: detail.trim(), saved: new Date().toISOString() });
  saveAll(memories);
  console.log(`🧠 Memory saved: [${topic}] ${detail.slice(0, 60)}...`);
  return id;
}

function findRelevant(query) {
  if (!query || query.trim().length < 3) return [];
  const memories = loadAll();
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  return memories.filter(m => {
    const text = (m.topic + ' ' + m.detail).toLowerCase();
    return words.some(w => text.includes(w));
  }).slice(-5);
}

module.exports = { addMemory, findRelevant, loadAll };
