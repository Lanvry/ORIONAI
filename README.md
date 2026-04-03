# 🤖 ClassBot — AI Asisten Google Classroom via Telegram

Bot Telegram cerdas yang membantu kamu mengelola tugas Google Classroom secara otomatis, dilengkapi AI berbasis Gemini untuk menjawab segala pertanyaan.

---

## ✨ Fitur

| Fitur | Deskripsi |
|-------|-----------|
| 🔔 Notifikasi Tugas Baru | Bot otomatis memberi tahu jika ada tugas baru di Classroom |
| ⚠️ Peringatan Deadline | Notifikasi H-1 sebelum tenggat waktu |
| ✅ Kumpulkan Tugas dari Telegram | Share file ke bot, langsung terkumpul di Classroom |
| 🤖 Chat AI (Gemini) | Tanya apa saja — materi pelajaran, ringkasan, dll |
| 📋 Daftar Tugas & Mapel | Lihat semua tugas aktif dan mata kuliah |

---

## 🛠️ Cara Setup

### Langkah 1 — Clone & Install

```bash
git clone <repo-url>
cd classroom-assistant
npm install
```

### Langkah 2 — Buat Telegram Bot

1. Buka Telegram, cari **@BotFather**
2. Ketik `/newbot`, ikuti instruksi
3. Salin **Bot Token** yang diberikan

### Langkah 3 — Buat Google Cloud Project

1. Buka [Google Cloud Console](https://console.cloud.google.com/)
2. Buat project baru
3. Aktifkan **Google Classroom API** dan **Google Drive API**
4. Buka **APIs & Services > Credentials**
5. Klik **Create Credentials > OAuth 2.0 Client ID**
6. Pilih tipe: **Web Application**
7. Tambahkan Authorized Redirect URI: `http://localhost:3000/oauth/callback`
8. Salin **Client ID** dan **Client Secret**

### Langkah 4 — Buat Gemini API Key

1. Buka [Google AI Studio](https://aistudio.google.com/apikey)
2. Klik **Create API Key**
3. Salin key-nya

### Langkah 5 — Konfigurasi `.env`

Salin dan isi file `.env`:

```env
TELEGRAM_BOT_TOKEN=isi_token_bot_telegram
TELEGRAM_OWNER_ID=isi_id_telegram_kamu
GEMINI_API_KEY=isi_gemini_api_key
GOOGLE_CLIENT_ID=isi_client_id
GOOGLE_CLIENT_SECRET=isi_client_secret
GOOGLE_REDIRECT_URI=http://localhost:3000/oauth/callback
CHECK_INTERVAL_MINUTES=15
```

> 💡 **Cara tahu ID Telegram kamu:** Jalankan bot lalu ketik `/start`. Bot akan menampilkan ID kamu.

### Langkah 6 — Login Google (Sekali Saja)

```bash
node setup/oauth-server.js
```

Buka browser ke `http://localhost:3000`, login dengan akun Google kamu, dan izinkan akses. Token akan tersimpan otomatis.

### Langkah 7 — Jalankan Bot! 🚀

```bash
npm start
```

Atau mode development (auto-restart jika ada perubahan):

```bash
npm run dev
```

---

## 📁 Struktur Project

```
classroom-assistant/
├── bot.js                 # Entry point utama
├── .env                   # Konfigurasi (jangan di-commit!)
├── token.json             # Token Google (auto-generated)
├── src/
│   ├── handlers.js        # Semua command & logika bot
│   ├── classroomService.js # Google Classroom API
│   ├── googleAuth.js      # Autentikasi Google OAuth2
│   ├── cronJobs.js        # Penjadwalan cek tugas otomatis
│   └── utils.js           # Helper functions
└── setup/
    └── oauth-server.js    # Server sekali pakai untuk OAuth
```

---

## 🎮 Cara Pakai

| Perintah / Tombol | Fungsi |
|---|---|
| `/start` | Tampilkan menu utama & ID Telegram |
| 📋 **Daftar Tugas** | Lihat semua tugas yang belum dikumpulkan |
| ✅ **Kumpulkan Tugas** | Pilih tugas lalu kirim file-nya |
| 🤖 **Tanya AI** | Masuk mode chat AI |
| 📚 **Daftar Mapel** | Lihat semua mata kuliah aktif |
| 🔗 **Login Google** | Hubungkan akun Google |

---

## ⚙️ Konfigurasi Interval

Ubah `CHECK_INTERVAL_MINUTES` di `.env` untuk mengatur seberapa sering bot mengecek tugas baru (default: 15 menit).

---

*Dibuat dengan ❤️ menggunakan Node.js, Telegraf, Google APIs & Gemini AI*
