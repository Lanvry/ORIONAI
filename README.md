# 🤖 ClassBot — AI Asisten Google Classroom & ETHOL via Telegram

Bot Telegram cerdas yang dipersenjatai dengan AI (Gemini, GPT OSS, Qwen) untuk mengelola tugas Google Classroom secara otomatis, melakukan absensi ETHOL, dan melakukan penjelajahan web mandiri.

---

## ✨ Fitur Utama

| Fitur | Deskripsi |
|-------|-----------|
| 🔔 **Notifikasi Tugas Baru** | Bot otomatis memberi tahu jika ada tugas baru di Classroom |
| ⚠️ **Peringatan Deadline** | Notifikasi H-1 sebelum tenggat waktu |
| ✅ **Kumpulkan Tugas via Chat**| Share file (dokumen/foto/video) ke bot, langsung terkumpul ke Classroom! |
| 🎓 **Automasi Absen ETHOL** | Bot bisa login & klik tombol presensi ETHOL dengan sendirinya, mendeteksi daftar absensi secara cerdas. Kredensial dijamin aman (terenkripsi AES-256). |
| 🌐 **Agentic Web Automation**| Minta bot untuk menjelajahi website apapun dengan perintah `/browse`. Visi AI yang akan mensimulasikan navigasi kursor & menekan klik! |
| 🤖 **Multi-AI Chat Fallback** | Bisa ditanya apa saja! Didukung sistem _Fallback_ otomatis: Gemini (2 Token) ➡️ Siputzx GPT OSS ➡️ OpenRouter Qwen. Gak perlu khawatir limit kuota API. |

---

## 🛠️ Cara Setup

### Langkah 1 — Clone & Install

```bash
git clone https://github.com/Lanvry/ORIONAI.git
cd ORIONAI
npm install
```

### Langkah 2 — Konfigurasi Lingkungan (`.env`)

Buat file `.env` di root folder dan isi konfigurasi berikut (acuannya ada di `.env.example`):

```env
# Konfigurasi Inti
TELEGRAM_BOT_TOKEN=isi_token_bot_telegram
TELEGRAM_OWNER_ID=isi_id_telegram_kamu

# Konfigurasi AI 
GEMINI_API_KEY=isi_gemini_api_key_utama
GEMINI_API_KEY_2=isi_gemini_api_key_cadangan
OPENROUTER_API_KEY=isi_token_openrouter_qwen

# Autentikasi Google Chrome
GOOGLE_CLIENT_ID=isi_client_id
GOOGLE_CLIENT_SECRET=isi_client_secret
GOOGLE_REDIRECT_URI=http://localhost:3000/oauth/callback

# Automasi Puppeteer (Absen & Browse)
ENCRYPTION_KEY=64_character_hex_bebas_untuk_mengunci_password_ethol
HEADLESS=true # Isi 'false' jika ingin melihat browser bergerak

# Jadwal & Pengingat
CHECK_INTERVAL_MINUTES=15
DAILY_DIGEST_HOUR=7
TIMEZONE=Asia/Jakarta
```

### Langkah 3 — Login Google OAuth (Sekali Saja)

Jalankan server otentikasi awal:
```bash
node setup/oauth-server.js
```
Buka browser ke `http://localhost:3000`, login dengan akun Google kamu, dan salin kodenya ke Telegram (`/auth [KODE]`).

### Langkah 4 — Jalankan Bot! 🚀

```bash
node bot.js
```

---

## 🎮 Command List / Cara Pakai

Di dalam bot Telegram, ketik perintah berikut:

**📚 Akademik (Google Classroom):**
- 📋 **Daftar Tugas:** Tampilkan tugas yang belum dikumpulkan
- ✅ **Kumpulkan Tugas:** Masuk mode setor tugas (Tinggal kirim filenya)
- 📚 **Daftar Mapel:** Lihat kelas yang aktif di Classroom
- `/refresh` : Paksa penarikan data baru dari Google

**🎓 Presensi (ETHOL PENS):**
- `/ethollogin` : Setup dan enkripsi Email & Password ETHOL kamu ke database.
- `/ethollogout` : Menghapus kredensial
- 🎓 **Absen ETHOL** : Menjalankan bot ke background untuk mengecek/mengeklik tombol presensi yang sedang berlangsung siang ini!

**🌐 Agentic AI:**
- 🤖 **Tanya AI** : Mengobrol apa saja
- `/browse <URL> <Instruksi>` : Menyuruh AI bertindak seperti Hacker kecil masuk ke suatu *website*. Bot akan memberikan laporan foto progres (*screenshot*).
  Contoh: `/browse https://google.com Cari harga bitcoin!`

---
## 💻 Panduan Khusus Windows 7 / 8 / 10

Jika Anda menggunakan Windows versi lama (Windows 10 kebawah) dan mengalami masalah saat instalasi atau menjalankan fitur **Absen ETHOL**, ikuti langkah berikut untuk memastikan kompatibilitas `puppeteer-core`:

1. Hapus versi yang ada (jika ada):
   ```bash
   npm uninstall puppeteer-core
   ```

2. Install versi stabil yang kompatibel dengan Windows lama:
   ```bash
   npm install puppeteer-core@19.7.0 --save-exact
   ```

3. Verifikasi instalasi:
   ```bash
   npm list puppeteer-core
   ```

4. Pastikan Anda punya **Google Chrome/Microsoft Edge** standar terinstal. Bot sudah dilengkapi deteksi path `chrome.exe` bawaan.

5. Jika masih *crash*, di file `.env`, aktifkan variabel (hilangkan tanda pagar):
   `CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe`

> 💡 **Tips:** Pastikan Anda sudah memiliki Google Chrome atau Microsoft Edge terinstal di sistem Anda. Orion akan otomatis mendeteksi lokasi browser tersebut.


---

## 📁 Struktur Core Project

```
classroom-assistant/
├── bot.js                  # Entry point utama (Polling Telegram)
├── src/
│   ├── handlers.js         # Registrasi perintah bot & AI Router
│   ├── agenticBrowser.js   # Sistem Web Agent AI dinamis (/browse)
│   ├── etholService.js     # Automasi UI login & absen ETHOL
│   ├── etholCredentials.js # Tata kelola enkripsi (AES-256) Login MultiUser
│   ├── classroomService.js # Konektor Resmi Google Workspace (Classroom)
│   ├── googleAuth.js       # Autentikasi OAuth2
│   ├── utils.js            # Helper Formatter & MIME Parser
│   └── cronJobs.js         # Pengingat Jadwal Deadline
└── README.md
```

*Dibuat dengan ❤️ untuk kemudahan akademik*
