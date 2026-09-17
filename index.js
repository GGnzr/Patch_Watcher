require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");
const axios = require("axios");
const cheerio = require("cheerio");
const express = require("express");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "config.json");

const DEFAULT_CONFIG = {
  schedules: ["10:00", "14:00"],
  channelId: process.env.CHANNEL_ID || "",
  autoSend: true,
  lastPatchUrl: "",
};

let config = loadConfig();
let logs = [];

function loadConfig() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) };
    }
  } catch (error) {
    console.error("Erro ao carregar config.json:", error);
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(config, null, 2));
}

function addLog(message, type = "info") {
  const entry = {
    time: new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }),
    message,
    type,
  };

  logs.unshift(entry);
  logs = logs.slice(0, 200);

  console.log(`[${entry.time}] ${message}`);
}

const PATCH_NOTES_URL =
  "https://www.leagueoflegends.com/pt-br/news/game-updates/";

async function fetchPatchNotes({ force = false } = {}) {
  try {
    addLog("🔍 Iniciando busca pelo patch...");

    const { data } = await axios.get(PATCH_NOTES_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 Patch-Watcher",
        "Accept-Language": "pt-BR,pt;q=0.9",
      },
      timeout: 15000,
    });

    const $ = cheerio.load(data);

    // A Riot atualmente usa URLs como:
    // /pt-br/news/game-updates/league-of-legends-patch-26-18-notes/
    const links = $('a[href*="league-of-legends-patch-"]');

    let latestPatch = null;

    links.each((_, element) => {
      if (!latestPatch) {
        latestPatch = $(element).attr("href");
      }
    });

    if (!latestPatch) {
      // Fallback para qualquer link contendo patch-
      latestPatch = $('a[href*="patch-"]').first().attr("href");
    }

    if (!latestPatch) {
      addLog("❌ Nenhum link de patch foi encontrado na página da Riot.", "error");
      return null;
    }

    const fullUrl = latestPatch.startsWith("http")
      ? latestPatch
      : `https://www.leagueoflegends.com${latestPatch}`;

    addLog(`🎮 Patch encontrado: ${fullUrl}`);

    // Busca uma imagem og:image na página do patch.
    let imageUrl = null;

    try {
      const patchResponse = await axios.get(fullUrl, {
        headers: { "User-Agent": "Mozilla/5.0 Patch-Watcher" },
        timeout: 15000,
      });

      const patchPage = cheerio.load(patchResponse.data);
      imageUrl =
        patchPage('meta[property="og:image"]').attr("content") ||
        patchPage('meta[name="twitter:image"]').attr("content") ||
        null;

      if (imageUrl) {
        addLog("🖼️ Imagem do patch encontrada.");
      } else {
        addLog("⚠️ Patch encontrado, mas não foi localizada uma imagem.", "warning");
      }
    } catch (error) {
      addLog(`⚠️ Não foi possível carregar a imagem: ${error.message}`, "warning");
    }

    const isNew = fullUrl !== config.lastPatchUrl;

    if (isNew || force) {
      return {
        url: fullUrl,
        image: imageUrl,
        isNew,
      };
    }

    addLog("ℹ️ O patch encontrado já foi registrado.", "info");
    return {
      url: fullUrl,
      image: imageUrl,
      isNew: false,
    };
  } catch (error) {
    addLog(`❌ Erro ao buscar os Patch Notes: ${error.message}`, "error");
    return null;
  }
}

function buildPatchMessage(patchNotes) {
  const embed = {
    title: "🎮 Novos Patch Notes!",
    description: `Confira as últimas atualizações do League of Legends: [Clique aqui](${patchNotes.url})`,
    color: 0x0099ff,
    footer: {
      text: "Patch Notes Bot",
    },
  };

  if (patchNotes.image) {
    embed.image = { url: patchNotes.image };
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel("Ver Patch Notes")
      .setURL(patchNotes.url)
      .setStyle(ButtonStyle.Link)
  );

  return {
    embeds: [embed],
    components: [row],
  };
}

async function sendPatchToDiscord(patchNotes) {
  const channelId = config.channelId;

  if (!channelId) {
    addLog("❌ Nenhum CHANNEL_ID configurado.", "error");
    return false;
  }

  const channel = await client.channels.fetch(channelId).catch(() => null);

  if (!channel) {
    addLog("❌ Não foi possível encontrar o canal do Discord.", "error");
    return false;
  }

  await channel.send(buildPatchMessage(patchNotes));
  config.lastPatchUrl = patchNotes.url;
  saveConfig();

  addLog(`📤 Patch enviado para o canal ${channel.name || channelId}.`);
  return true;
}

async function checkPatchNotes() {
  const patchNotes = await fetchPatchNotes();

  if (!patchNotes || !patchNotes.isNew) {
    return;
  }

  if (!config.autoSend) {
    addLog("ℹ️ Novo patch encontrado, mas o envio automático está desativado.");
    return;
  }

  await sendPatchToDiscord(patchNotes);
}

async function registerSlashCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("patch")
      .setDescription("Mostra o patch atual do League of Legends"),
  ].map(command => command.toJSON());

  const rest = new REST({ version: "10" }).setToken(process.env.BOT_TOKEN);

  await rest.put(
    Routes.applicationCommands(client.user.id),
    { body: commands }
  );

  addLog("✅ Comando /patch registrado.");
}

client.once("ready", async () => {
  addLog(`🟢 Bot conectado como ${client.user.tag}.`);
  addLog(`🌐 Servidores Discord: ${client.guilds.cache.size}.`);

  try {
    await registerSlashCommands();
  } catch (error) {
    addLog(`❌ Erro ao registrar /patch: ${error.message}`, "error");
  }

  // Recria os agendamentos a partir da configuração atual.
  scheduleJobs();
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "patch") {
    try {
      await interaction.deferReply();

      const patchNotes = await fetchPatchNotes({ force: true });

      if (!patchNotes) {
        await interaction.editReply("❌ Não foi possível consultar os Patch Notes.");
        return;
      }

      await interaction.editReply(buildPatchMessage(patchNotes));
    } catch (error) {
      addLog(`❌ Erro no comando /patch: ${error.message}`, "error");
      if (interaction.deferred) {
        await interaction.editReply("❌ Ocorreu um erro ao consultar os Patch Notes.");
      }
    }
  }
});

let scheduledTasks = [];

function scheduleJobs() {
  scheduledTasks.forEach(task => task.stop());
  scheduledTasks = [];

  for (const time of config.schedules) {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
    if (!match) {
      addLog(`⚠️ Horário inválido ignorado: ${time}`, "warning");
      continue;
    }

    const hour = match[1];
    const minute = match[2];

    const task = cron.schedule(
      `${minute} ${hour} * * *`,
      () => {
        addLog(`⏰ Verificação agendada para ${time}.`);
        checkPatchNotes();
      },
      { timezone: "America/Sao_Paulo" }
    );

    scheduledTasks.push(task);
    addLog(`⏰ Horário configurado: ${time}.`);
  }
}

// ---------------- PAINEL WEB ----------------

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/api/status", (req, res) => {
  res.json({
    online: client.isReady(),
    bot: client.user?.tag || "Desconectado",
    guilds: client.guilds.cache.size,
    schedules: config.schedules,
    channelId: config.channelId,
    autoSend: config.autoSend,
    lastPatchUrl: config.lastPatchUrl,
    logs,
  });
});

app.post("/api/config", (req, res) => {
  const { schedules, channelId, autoSend } = req.body;

  if (Array.isArray(schedules)) {
    config.schedules = schedules
      .filter(time => typeof time === "string")
      .filter(time => /^([01]\d|2[0-3]):[0-5]\d$/.test(time));
  }

  if (typeof channelId === "string") {
    config.channelId = channelId.trim();
  }

  if (typeof autoSend === "boolean") {
    config.autoSend = autoSend;
  }

  saveConfig();
  scheduleJobs();

  addLog("💾 Configurações salvas pelo painel.");
  res.json({ ok: true, config });
});

app.post("/api/check", async (req, res) => {
  try {
    const patchNotes = await fetchPatchNotes({ force: true });

    if (!patchNotes) {
      return res.status(500).json({
        ok: false,
        message: "Não foi possível buscar o patch.",
      });
    }

    if (patchNotes.isNew && config.autoSend) {
      await sendPatchToDiscord(patchNotes);
    }

    res.json({
      ok: true,
      patch: patchNotes.url,
      sent: patchNotes.isNew && config.autoSend,
    });
  } catch (error) {
    addLog(`❌ Erro na verificação manual: ${error.message}`, "error");
    res.status(500).json({ ok: false, message: error.message });
  }
});

app.listen(PORT, () => {
  addLog(`🌐 Painel web ouvindo na porta ${PORT}.`);
});

client.login(process.env.BOT_TOKEN).catch(error => {
  addLog(`❌ Falha no login do Discord: ${error.message}`, "error");
});
