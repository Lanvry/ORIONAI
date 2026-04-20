const { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, AttachmentBuilder, ActivityType, MessageFlags } = require('discord.js');
const { askAI } = require('../aiService');
const { getCredentials, saveCredentials } = require('../etholCredentials');
const { loginAndCheckEthol } = require('../etholService');
const { getScheduleMis } = require('../misService');
const { agenticQueue } = require('../agenticQueue');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DISCORD_BOT_PERSONA = 'Kamu adalah bot representasi PENS Sumenep yang cerdas, ramah, dan asik. Kamu dihidupkan dengan sistem inti Orion AI. ' +
    'Instruksi Gaya Bahasa:\n' +
    '1. Balas dengan singkat, langsung ke intinya (to the point).\n' +
    '2. Gunakan gaya bahasa santai dan gaul khas mahasiswa kampus PENS Sumenep (pakai "aku" dan sapa "kak", sesekali boleh selipkan logat lokal secukupnya).\n' +
    '3. Jika ditanya siapa kamu atau siapa pembuatmu, sebutkan bahwa kamu berjalan di atas platform Orion AI.\n' +
    '4. Sisipkan 1-2 emoji saja secukupnya.';

// --- Antrian Sistem dihapus, pindah ke src/agenticQueue.js ---

function startDiscordBot() {
  if (!process.env.DISCORD_BOT_TOKEN) {
      console.warn('⚠️  DISCORD_BOT_TOKEN belum diisi di file .env');
      return null;
  }

  const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages
    ],
    partials: [Partials.Channel]
  });

  client.once('ready', async () => {
    console.log(`✅ Discord Bot Berhasil Login sebagai ${client.user.tag}`);
    
    // Set Activity Status
    client.user.setActivity('Running On Orion AI 🤖', { type: ActivityType.Playing });
    
    // Refresh actvity setiap hari agar tidak hilang (24 jam)
    setInterval(() => {
        if (client.user) {
            client.user.setActivity('Running On Orion AI 🤖', { type: ActivityType.Playing });
        }
    }, 24 * 60 * 60 * 1000);

    // Registrasi Slash Command Global
    try {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
        const commands = [
            new SlashCommandBuilder()
                .setName('orion')
                .setDescription('Ngobrol dengan AI PENS Sumenep (Powered by Orion)')
                .addStringOption(option => 
                    option.setName('pesan')
                          .setDescription('Apa yang ingin kamu tanyakan?')
                          .setRequired(true)),
            new SlashCommandBuilder()
                .setName('absen')
                .setDescription('Otomatis eksekusi absen di ETHOL PENS'),
            new SlashCommandBuilder()
                .setName('jadwal')
                .setDescription('Lihat jadwal kuliah kamu dari MIS PENS'),
            new SlashCommandBuilder()
                .setName('ethollogin')
                .setDescription('Simpan kredensial ETHOL Anda (Aman dikirim via DM)')
                .addStringOption(option => option.setName('email').setDescription('Email ETHOL PENS').setRequired(true))
                .addStringOption(option => option.setName('password').setDescription('Password ETHOL PENS').setRequired(true))
        ].map(i => i.toJSON());

        // Daftarkan sebagai Global Commands saja agar konsisten di semua server dan DM.
        // Guild-specific registration dihapus karena bisa gagal diam-diam jika bot
        // diundang tanpa scope applications.commands di server tertentu.
        console.log('🔄 Mendaftarkan Slash Commands secara Global (berlaku di semua server & DM)...');
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands },
        );
        console.log('✅ Slash Commands Global berhasil didaftarkan! (Mungkin perlu ~1 jam untuk propagasi ke server baru)');
    } catch (error) {
        console.error('❌ Gagal meregistrasikan Slash Commands:', error.message);
    }
  });

  // --- Penanganan Interactions ---
  client.on('interactionCreate', async interaction => {
      if (interaction.isChatInputCommand()) {
          if (interaction.commandName === 'ethollogin') {
              const email = interaction.options.getString('email');
              const password = interaction.options.getString('password');
              const userId = interaction.user.id.toString();

              saveCredentials(userId, email, password);
              await interaction.reply({ 
                  content: '✅ *Kredensial ETHOL berhasil disimpan!*\n\n🔐 Email dan password Anda dienkripsi secara lokal.\n\nSekarang Anda bisa menggunakan perintah `/absen`!', 
                  flags: MessageFlags.Ephemeral 
              });
              return;
          }

          if (interaction.commandName === 'absen') {
              const userId = interaction.user.id.toString();
              const creds = getCredentials(userId);

              if (!creds) {
                  await interaction.reply({
                      content: '⚠️ Kredensial ETHOL Anda belum disimpan.\n\nSilakan kirim perintah `/ethollogin` di server atau DM untuk menyimpan email dan password ETHOL Anda.',
                      flags: MessageFlags.Ephemeral
                  });
                  try {
                      await interaction.user.send("Hai! Untuk melakukan absen ETHOL, kamu perlu menggunakan perintah `/ethollogin` beserta email dan passwordmu di server atau di DM ini. Data ini dienkripsi dengan aman di lokal dan berjalan lancar di host OS ini.");
                  } catch (e) {}
                  return;
              }

              const { email, password } = creds;
              await interaction.deferReply({ flags: MessageFlags.Ephemeral });
              
              try {
                  const queuePosition = agenticQueue.length;
                  if (agenticQueue.isProcessing) {
                      await interaction.editReply(`⏳ *Sistem sedang memproses antrean...*\nKamu berada di urutan antrean ke-${queuePosition + 1}. Mohon tunggu sejenak.`);
                  }

                  const result = await agenticQueue.enqueue(() => loginAndCheckEthol(email, password, async (text) => {
                      try { await interaction.editReply(`🚀 *Status:* ${text}`); } catch (e) {}
                  }, 'scan'), userId);

                  if (!result.success) {
                      return await interaction.editReply(`❌ *Gagal Scraping:* ${result.error}`);
                  }

                  if (result.courses && result.courses.length > 0) {
                      const btnComponents = result.courses.map(c => ({
                          type: 2,
                          style: 1,
                          label: c.length > 80 ? c.substring(0, 77) + '...' : c,
                          custom_id: `absen_exec_${c.substring(0, 80)}`
                      }));

                      const components = [];
                      for (let i = 0; i < btnComponents.length; i += 5) {
                          components.push({ type: 1, components: btnComponents.slice(i, i + 5) });
                      }

                      await interaction.editReply({
                          content: `✅ *Terdapat Mata Kuliah yang bisa di-absen!*\nSilakan klik salah satu mata kuliah di bawah untuk mengonfirmasi kehadiran Anda:`,
                          components: components
                      });
                  } else {
                      if (result.screenshot) {
                          const attachment = new AttachmentBuilder(result.screenshot, { name: 'ethol_scan.jpg' });
                          await interaction.editReply({
                              content: `✅ Pemindaian selesai. *Tidak ada jadwal presensi aktif* yang terdeteksi di dropdown notifikasi. Berikut adalah tangkapan layar lonceng notifikasi Anda.`,
                              files: [attachment]
                          });
                      } else {
                          await interaction.editReply(`✅ Pemindaian selesai. *Tidak ada jadwal presensi aktif* yang terdeteksi di notifikasi Anda saat ini.`);
                      }
                  }
              } catch (err) {
                  await interaction.editReply(`❌ Error Absen: ${err.message}`);
              }
              return;
          }

          if (interaction.commandName === 'jadwal') {
              const userId = interaction.user.id.toString();
              const creds = getCredentials(userId);

              if (!creds) {
                  return interaction.reply({
                      content: '⚠️ Kredensial belum disimpan.\n\nSilakan kirim perintah `/ethollogin` di server atau DM untuk menyimpan email dan password secara aman (kredensial ini juga digunakan untuk MIS PENS).',
                      flags: MessageFlags.Ephemeral
                  });
              }

              const { email, password } = creds;
              await interaction.deferReply({ flags: MessageFlags.Ephemeral });

              try {
                  const queuePosition = agenticQueue.length;
                  if (agenticQueue.isProcessing) {
                      await interaction.editReply(`⏳ *Sistem sedang memproses antrean...*\nKamu berada di urutan antrean ke-${queuePosition + 1}. Mohon tunggu sejenak.`);
                  }

                  const result = await agenticQueue.enqueue(() => getScheduleMis(email, password, async (text) => {
                      try { await interaction.editReply(`🚀 *Status:* ${text}`); } catch (e) {}
                  }), userId);

                  if (!result.success) {
                      const errAttachment = result.screenshot ? new AttachmentBuilder(result.screenshot, { name: 'error.jpg' }) : null;
                      const opts = errAttachment ? { files: [errAttachment] } : {};
                      return await interaction.editReply({ content: `❌ *Gagal Mendapatkan Jadwal:* ${result.error}`, ...opts });
                  }

                  const scheduleAttachment = new AttachmentBuilder(result.screenshot, { name: 'jadwal.jpg' });
                  await interaction.editReply({
                      content: `✅ *Jadwal Kuliah per-semester berhasil diambil!*`,
                      files: [scheduleAttachment]
                  });
              } catch (err) {
                  await interaction.editReply(`❌ Error Jadwal: ${err.message}`);
              }
              return;
          }

          if (interaction.commandName === 'orion') {
              const userMessage = interaction.options.getString('pesan');
              const userId = interaction.user.id.toString();

              // Kirim indikator bahwa bot sedang memproses (Deferred reply / "Berpikir...")
              await interaction.deferReply();

              try {
                  const answer = await askAI(userId, userMessage, [], [], async (streamText) => {
                      try {
                          if (streamText.length > 0) {
                              const safeText = streamText.length > 2000 ? streamText.substring(0, 1996) + '...' : streamText;
                              await interaction.editReply(safeText);
                          }
                      } catch (e) {
                          // ignore rate-limits
                      }
                  }, DISCORD_BOT_PERSONA);
                  
                  if (answer) {
                      if (answer.length > 2000) {
                          await interaction.editReply(answer.substring(0, 1996) + '...');
                      } else {
                          await interaction.editReply(answer);
                      }
                  } else {
                      await interaction.editReply('Maaf, pikiranku sedang buntu saat ini.');
                  }
              } catch (err) {
                  await interaction.editReply(`❌ Error AI: ${err.message}`);
              }
          }
      } else if (interaction.isButton()) {
          if (interaction.customId.startsWith('absen_exec_')) {
              const targetCourse = interaction.customId.replace('absen_exec_', '');
              const userId = interaction.user.id.toString();
              const creds = getCredentials(userId);

              if (!creds) {
                  return interaction.reply({ content: '⚠️ Kredensial ETHOL belum tersimpan. Gunakan /ethollogin terlebih dahulu.', flags: MessageFlags.Ephemeral });
              }

              await interaction.update({ content: `🚀 Mengeksekusi presensi untuk *${targetCourse}*...\n\n_Bot akan mengirim foto di setiap langkah._`, components: [] });

              const { email, password } = creds;

              try {
                  const queuePosition = agenticQueue.length;
                  if (agenticQueue.isProcessing) {
                      await interaction.editReply(`⏳ *Sistem sedang mengeksekusi presensi...*\nKamu berada di urutan antrean ke-${queuePosition + 1}. Mohon tunggu sejenak.`);
                  }

                  const result = await agenticQueue.enqueue(() => loginAndCheckEthol(
                    email, 
                    password, 
                    async (text) => {
                      try { await interaction.editReply(`🚀 *Status:* ${text}`); } catch(e) {}
                    }, 
                    'execute', 
                    targetCourse,
                    async (screenshotBuffer, caption) => {
                        const attachment = new AttachmentBuilder(screenshotBuffer, { name: 'step.jpg' });
                        await interaction.followUp({ content: caption, files: [attachment], flags: MessageFlags.Ephemeral });
                    }
                  ), userId);

                  if (!result.success) {
                    return await interaction.editReply(`❌ *Gagal Scraping:* ${result.error}`);
                  }

                  const isClosed = result.btnStatus && result.btnStatus.startsWith('CLOSED:');
                  const isClicked = result.btnStatus && !result.btnStatus.startsWith('CLOSED:');

                  let finalAttachment = null;
                  if (result.screenshot) {
                      finalAttachment = new AttachmentBuilder(result.screenshot, { name: 'final.jpg' });
                  }
                  
                  const opts = finalAttachment ? { files: [finalAttachment] } : {};

                  if (isClicked) {
                      // Update secara private (ephemeral)
                      await interaction.editReply({ content: `✅ *Absensi Berhasil!*\nBukti kehadiran untuk *${targetCourse}* telah dikonfirmasi.`, ...opts });
                      
                      // Umumkan ke publik (channel)
                      try {
                          const timeStr = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
                          await interaction.channel.send(`🎓 <@${userId}> telah berhasil melakukan presensi ETHOL untuk mata kuliah **${targetCourse}** pada pukul ${timeStr} WIB.`);
                      } catch (e) {
                          // fallback if interaction.channel fails for some reason
                          await interaction.followUp({ content: `🎓 <@${userId}> telah berhasil melakukan presensi ETHOL untuk mata kuliah **${targetCourse}**.` });
                      }
                  } else if (isClosed) {
                      await interaction.editReply({ content: `🔒 *Absensi Sudah Ditutup!*\nTombol presensi untuk *${targetCourse}* berwarna abu-abu. Dosen sudah menutup portal kehadiran.`, ...opts });
                  } else {
                      await interaction.editReply({ content: `⚠️ *Tombol Presensi Tidak Ditemukan*\nLog: ${result.logs.slice(-2).join(', ')}`, ...opts });
                  }

              } catch (err) {
                  await interaction.editReply(`❌ Error Eksekusi Absen: ${err.message}`);
              }
              return;
          }
      }
  });

  // ─── Helper: Download Attachment Discord ke temp file ─────────────────────
  async function downloadDiscordAttachment(url, fileName) {
    const tempPath = path.join(os.tmpdir(), `discord_${Date.now()}_${fileName}`);
    const response = await axios({ method: 'GET', url, responseType: 'stream' });
    return new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(tempPath);
      response.data.pipe(writer);
      writer.on('finish', () => resolve(tempPath));
      writer.on('error', reject);
    });
  }

  // ─── Helper: Ambil MIME type dari ekstensi file ────────────────────────────
  function getDiscordMimeType(fileName) {
    const ext = (fileName.split('.').pop() || '').toLowerCase();
    const map = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
      gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
      pdf: 'application/pdf', txt: 'text/plain',
      js: 'application/javascript', json: 'application/json',
      mp4: 'video/mp4', mp3: 'audio/mpeg',
    };
    return map[ext] || 'application/octet-stream';
  }

  client.on('messageCreate', async (message) => {
    // Abaikan pesan dari bot lain
    if (message.author.bot) return;

    // Untuk fitur chat AI, merespons jika:
    // 1. Pesan via Direct Message (DM)
    // 2. Bot dimention di server
    // 3. Menggunakan prefix '!orion '
    const isDirectMessage = !message.guild;
    const isMentioned = message.mentions.has(client.user.id);
    const prefix = '!orion ';
    const hasPrefix = message.content.toLowerCase().startsWith(prefix);

    // Cek apakah ada attachment (gambar/file)
    const hasAttachment = message.attachments.size > 0;

    if (!isMentioned && !isDirectMessage && !hasPrefix) return;

    const userId = message.author.id.toString();
    
    let userMessage = message.content;
    if (hasPrefix) {
        userMessage = userMessage.slice(prefix.length);
    } else if (isMentioned) {
        userMessage = userMessage.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '');
    }
    userMessage = userMessage.trim();

    // ─── Jika ada attachment: proses gambar/file ke AI ────────────────────────
    if (hasAttachment) {
        const attachment = message.attachments.first();
        const fileName = attachment.name || `file_${Date.now()}`;
        const mimeType = attachment.contentType || getDiscordMimeType(fileName);
        const caption = userMessage || null;

        const botMessage = await message.reply('👀 Memeriksa gambar/file...');
        let tempPath = null;

        try {
            // Download attachment ke temp file
            tempPath = await downloadDiscordAttachment(attachment.url, fileName);

            const parts = [];

            // Jika file teks: baca sebagai string
            if (
                mimeType.startsWith('text/') ||
                mimeType === 'application/javascript' ||
                mimeType === 'application/json' ||
                mimeType.includes('xml')
            ) {
                const textContent = fs.readFileSync(tempPath, 'utf8');
                parts.push(
                    'Isi file (' + fileName + '):\n```\n' +
                    textContent.slice(0, 10000) +
                    '\n```\n\n' + (caption || 'Tolong jelaskan file ini.')
                );
            } else {
                // Untuk gambar dan file lainnya: kirim sebagai base64 inline data
                const base64data = fs.readFileSync(tempPath).toString('base64');
                parts.push({ inlineData: { data: base64data, mimeType } });
                parts.push(caption || 'Tolong analisa gambar/file ini. Jelaskan apa yang kamu lihat secara detail.');
            }

            // Hapus temp file setelah selesai dibaca
            try { fs.unlinkSync(tempPath); } catch (e) {}
            tempPath = null;

            const answer = await askAI(userId, parts, [], [], async (streamText) => {
                try {
                    if (streamText.length > 0) {
                        const safeText = streamText.length > 2000 ? streamText.substring(0, 1996) + '...' : streamText;
                        await botMessage.edit(safeText);
                    }
                } catch (e) { /* ignore rate limits */ }
            }, DISCORD_BOT_PERSONA);

            if (answer) {
                const safeText = answer.length > 2000 ? answer.substring(0, 1996) + '...' : answer;
                await botMessage.edit(safeText);
            } else {
                await botMessage.edit('Maaf, aku tidak bisa menganalisa file ini saat ini.');
            }
        } catch (err) {
            // Cleanup jika masih ada
            if (tempPath) { try { fs.unlinkSync(tempPath); } catch (e) {} }
            await botMessage.edit(`❌ Error saat memproses file: ${err.message}`);
        }
        return;
    }

    // ─── Tidak ada attachment: proses sebagai pesan teks biasa ───────────────
    if (!userMessage) {
        await message.reply("Halo! Aku Orion AI. Ketik `/orion pertanyaanmu` untuk mengobrol atau langsung ketik pesanmu jika di DM! 👋\n\nKamu juga bisa kirim gambar langsung dan aku akan menganalisisnya! 🖼️");
        return;
    }

    const botMessage = await message.reply('Berpikir...');

    try {
        const answer = await askAI(userId, userMessage, [], [], async (streamText) => {
            try {
                if (streamText.length > 0) {
                    const safeText = streamText.length > 2000 ? streamText.substring(0, 1996) + '...' : streamText;
                    await botMessage.edit(safeText);
                }
            } catch (e) {
                // Ignore rate limits
            }
        }, DISCORD_BOT_PERSONA);
        
        if (answer) {
            const safeText = answer.length > 2000 ? answer.substring(0, 1996) + '...' : answer;
            await botMessage.edit(safeText);
        }
    } catch (err) {
        await botMessage.edit(`❌ Error AI: ${err.message}`);
    }
  });

  client.login(process.env.DISCORD_BOT_TOKEN).catch(err => {
    console.error('❌ Gagal menjalankan Discord bot:', err.message);
  });

  return client;
}

module.exports = { startDiscordBot };
