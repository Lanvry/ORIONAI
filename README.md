# 🤖 Orion AI — Asisten Akademik Multi-Platform (Telegram & Discord)

[![License: Non-Commercial](https://img.shields.io/badge/License-Non--Commercial-red.svg)](./LICENSE)
[![Coding Solver](https://img.shields.io/badge/©-Coding%20Solver-orange.svg)](https://github.com/Lanvry/ORIONAI)
[![Platform](https://img.shields.io/badge/Platform-Telegram%20%7C%20Discord-blue.svg)](https://github.com/Lanvry/ORIONAI)

Bot AI cerdas berbasis **Orion AI** yang berjalan di **Telegram** dan **Discord** untuk mengelola tugas Google Classroom, absensi ETHOL, melihat jadwal MIS PENS, serta melakukan penjelajahan web secara mandiri — semuanya lewat chat!

---

## ✨ Fitur Utama

| Fitur | Deskripsi |
|-------|-----------|
| 🔔 **Notifikasi Tugas Baru** | Otomatis notif jika ada tugas baru di Google Classroom |
| ⚠️ **Peringatan Deadline** | Notifikasi H-1 sebelum tenggat waktu |
| ✅ **Kumpulkan Tugas via Chat** | Share file ke bot, langsung terkumpul ke Classroom! |
| 🎓 **Automasi Absen ETHOL** | Login & klik tombol presensi ETHOL secara otomatis. Kredensial dienkripsi AES-256. |
| 📅 **Lihat Jadwal MIS PENS** | Ambil jadwal kuliah per-semester langsung dari portal MIS PENS. |
| 🌐 **Agentic Web Automation** | Suruh bot jelajahi website apapun dengan `/browse`. AI mensimulasikan navigasi & klik! |
| 🤖 **Multi-AI Chat Fallback** | Didukung sistem fallback: Gemini (2 token) ➡️ Siputzx GPT OSS ➡️ OpenRouter Qwen |
| 🛡️ **Agentic Queue & Anti-DDoS** | Semua perintah berat (absen, jadwal, browse) dilindungi antrian global. Satu user hanya bisa punya 1 task aktif. Max 20 antrian sebelum sistem menolak request berlebih. |
| 💬 **Discord Support** | Slash commands `/orion`, `/absen`, `/jadwal`, `/ethollogin` tersedia di semua server & DM. |

---

## 🛠️ Cara Setup

### Langkah 1 — Clone & Install

```bash
git clone https://github.com/Lanvry/ORIONAI.git
cd ORIONAI
npm install
```

### Langkah 2 — Konfigurasi Lingkungan (`.env`)

Buat file `.env` dari template `.env.example`:

```env
# ── Platform ──────────────────────────────────────────
TELEGRAM_BOT_TOKEN=isi_token_bot_telegram
TELEGRAM_OWNER_ID=isi_id_telegram_kamu

DISCORD_BOT_TOKEN=isi_token_bot_discord   # Kosongkan jika tidak pakai Discord

# ── AI Engine ─────────────────────────────────────────
GEMINI_API_KEY=isi_gemini_api_key_utama
GEMINI_API_KEY_2=isi_gemini_api_key_cadangan
OPENROUTER_API_KEY=isi_token_openrouter_qwen

# ── Google Classroom OAuth ────────────────────────────
GOOGLE_CLIENT_ID=isi_client_id
GOOGLE_CLIENT_SECRET=isi_client_secret
GOOGLE_REDIRECT_URI=http://localhost:3000/oauth/callback

# ── Puppeteer Automation ──────────────────────────────
ENCRYPTION_KEY=64_character_hex_untuk_mengunci_password_ethol
HEADLESS=true         # Isi 'false' jika ingin melihat browser bergerak
# CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe

# ── Jadwal & Cron ─────────────────────────────────────
CHECK_INTERVAL_MINUTES=15
DAILY_DIGEST_HOUR=7
TIMEZONE=Asia/Jakarta
```

### Langkah 3 — Login Google OAuth (Sekali Saja)

```bash
node setup/oauth-server.js
```
Buka browser ke `http://localhost:3000`, login akun Google, salin kodenya dan kirim ke Telegram: `/auth [KODE]`.

### Langkah 4 — Jalankan Bot! 🚀

```bash
node bot.js
```

---

## 🎮 Command List

### 📱 Telegram

**📚 Akademik (Google Classroom):**
- 📋 **Daftar Tugas** — Tugas yang belum dikumpulkan
- ✅ **Kumpulkan Tugas** — Mode setor file langsung ke Classroom
- 📖 **Lihat Materi** — Stream kelas 15 terbaru
- 📚 **Daftar Mapel** — Kelas aktif di Classroom
- `/refresh` — Paksa tarik data baru dari Google

**🎓 Presensi & Jadwal:**
- `/ethollogin` — Setup & enkripsi kredensial ETHOL
- `/ethollogout` — Hapus kredensial
- 🎓 **Absen ETHOL** — Otomatis pindai & klik presensi aktif
- 📅 **Lihat Jadwal** — Jadwal kuliah dari MIS PENS (butuh `/ethollogin`)

**🌐 Agentic AI:**
- 🤖 **Tanya AI** — Ngobrol apa saja
- `/browse <URL> <Instruksi>` — Suruh AI jelajahi website
  - Contoh: `/browse https://google.com Cari harga bitcoin!`

---

### 💬 Discord (Slash Commands)

| Command | Deskripsi |
|---------|-----------|
| `/orion <pesan>` | Ngobrol dengan AI PENS Sumenep |
| `/ethollogin <email> <password>` | Simpan kredensial ETHOL (ephemeral/privat) |
| `/absen` | Pindai & eksekusi presensi ETHOL |
| `/jadwal` | Lihat jadwal kuliah dari MIS PENS |

> 💡 Commands terdaftar sebagai **Global Commands** — otomatis muncul di semua server & DM tanpa perlu setup manual per-server.

---

## 🛡️ Sistem Antrian & Keamanan

Semua perintah yang menjalankan browser (Puppeteer) dilindungi oleh **`AgenticQueue`** global:

- **Anti-Spam per User** — Satu user hanya bisa punya 1 task browser aktif dalam satu waktu. Jika mencoba submit lagi sebelum selesai, langsung ditolak dengan pesan informatif.
- **Batas Antrian Global** — Maksimal **20 task** dalam antrian. Request berlebih (misalnya serangan DDoS) akan ditolak dengan pesan "Sistem Beban Penuh".
- **Sequential Execution** — Hanya 1 browser Puppeteer berjalan bersamaan. RAM server tetap stabil.
- Berlaku lintas platform: Telegram dan Discord berbagi antrian yang sama.

---

## 💻 Panduan Khusus Windows 7 / 8 / 10

Jika mengalami masalah saat fitur **Absen ETHOL** dijalankan di Windows lama:

1. Hapus versi Puppeteer yang ada:
   ```bash
   npm uninstall puppeteer-core
   ```

2. Install versi kompatibel Windows lama:
   ```bash
   npm install puppeteer-core@19.7.0 --save-exact
   ```

3. Verifikasi instalasi:
   ```bash
   npm list puppeteer-core
   ```

4. Pastikan **Google Chrome** atau **Microsoft Edge** sudah terinstal. Bot otomatis mendeteksi path-nya.

5. Jika masih crash, set path Chrome di `.env`:
   ```
   CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe
   ```

---

## 📁 Struktur Core Project

```
ORIONAI/
├── bot.js                        # Entry point utama
├── LICENSE                       # MIT License
├── src/
│   ├── agenticQueue.js           # Global queue & anti-DDoS untuk semua task berat
│   ├── agenticBrowser.js         # Sistem Web Agent AI (/browse)
│   ├── aiService.js              # Layanan AI dengan multi-fallback
│   ├── etholService.js           # Automasi UI login & absen ETHOL
│   ├── etholCredentials.js       # Enkripsi AES-256 kredensial multi-user
│   ├── misService.js             # Scraper jadwal MIS PENS
│   ├── classroomService.js       # Konektor Google Workspace (Classroom)
│   ├── googleAuth.js             # Autentikasi OAuth2 Google
│   ├── cronJobs.js               # Pengingat deadline & notifikasi terjadwal
│   ├── utils.js                  # Helper Formatter & MIME Parser
│   ├── telegram/
│   │   ├── telegramBot.js        # Entry point Telegram bot
│   │   └── handlers.js           # Semua handler command Telegram
│   └── discord/
│       └── discordBot.js         # Discord bot (Slash Commands + Chat)
└── README.md
```

---

## 📄 Lisensi

Proyek ini dilindungi di bawah **Coding Solver Non-Commercial License**.

- ✅ **Boleh** digunakan untuk keperluan pribadi, pendidikan, dan non-komersial
- ✅ **Boleh** dimodifikasi dan didistribusikan ulang secara gratis dengan atribusi
- ❌ **Dilarang** dijual, disewakan, atau digunakan dalam produk/layanan berbayar
- ❌ **Dilarang** menghapus atribusi hak cipta Coding Solver

**Copyright © 2026 Coding Solver. All rights reserved.**

Lihat file [LICENSE](./LICENSE) untuk detail lengkap.

---

*Dibuat dengan ❤️ oleh **Coding Solver** untuk kemudahan akademik mahasiswa PENS Sumenep*
