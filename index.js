require("dotenv").config();

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const cheerio = require("cheerio");
const express = require("express");
const cron = require("node-cron");

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  REST,
  Routes
} = require("discord.js");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

const PATCH_NOTES_URL =
  "https://www.leagueoflegends.com/pt-br/news/game-updates/";

const CONFIG_FILE = path.join(__dirname, "config.json");

// =====================================================
// CONFIGURAÇÃO
// =====================================================

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      const defaultConfig = {
        schedules: ["10:00", "14:00"],
        channelId: "",
        autoSend: true,
        lastPatchUrl: ""
      };

      fs.writeFileSync(
        CONFIG_FILE,
        JSON.stringify(defaultConfig, null, 2)
      );

      return defaultConfig;
    }

    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch (error) {
    console.error("Erro ao carregar config.json:", error);

    return {
      schedules: ["10:00", "14:00"],
      channelId: "",
      autoSend: true,
      lastPatchUrl: ""
    };
  }
}

function saveConfig(config) {
  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify(config, null, 2)
  );
}

let config = loadConfig();

// =====================================================
// LOGS
// =====================================================

const logs = [];

function addLog(type, message) {
  const entry = {
    time: new Date().toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo"
    }),
    type,
    message
  };

  logs.unshift(entry);

  if (logs.length > 200) {
    logs.pop();
  }

  console.log(`[${type}] ${message}`);
}

// =====================================================
// DISCORD
// =====================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// =====================================================
// BUSCAR PATCH
// =====================================================

async function fetchPatchNotes() {
try {
addLog(
"INFO",
"Consultando página de patches da Riot..."
);

const response = await axios.get(
  PATCH_NOTES_URL,
  {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36"
    },
    timeout: 15000
  }
);

const $ = cheerio.load(response.data);

let patchLink = null;

// =====================================================
// ENCONTRAR O PATCH MAIS RECENTE
// =====================================================

const currentPatch =
  $('a[href*="league-of-legends-patch-"]').first();

if (currentPatch.length) {
  patchLink = currentPatch.attr("href");
}

// Fallback
if (!patchLink) {
  const fallbackPatch =
    $('a[href*="patch-"]').first();

  if (fallbackPatch.length) {
    patchLink =
      fallbackPatch.attr("href");
  }
}

if (!patchLink) {
  throw new Error(
    "Não foi encontrado nenhum link de patch na página da Riot."
  );
}

// =====================================================
// CORRIGIR URL
// =====================================================

if (patchLink.startsWith("/")) {
  patchLink =
    "https://www.leagueoflegends.com" +
    patchLink;
}

addLog(
  "INFO",
  `Patch encontrado: ${patchLink}`
);

// =====================================================
// ABRIR A PÁGINA DO PATCH
// =====================================================

const patchResponse =
  await axios.get(
    patchLink,
    {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36"
      },
      timeout: 15000
    }
  );

const patchPage =
  cheerio.load(
    patchResponse.data
  );

// =====================================================
// IMAGEM DO PATCH
// =====================================================

let imageUrl =
  patchPage(
    'meta[property="og:image"]'
  ).attr("content") ||
  patchPage(
    'meta[name="twitter:image"]'
  ).attr("content") ||
  null;

// =====================================================
// TÍTULO DO PATCH
// =====================================================

let title =
  patchPage(
    'meta[property="og:title"]'
  ).attr("content") ||
  patchPage("title").text() ||
  "Patch do League of Legends";

title = title.trim();

// =====================================================
// LOG DA IMAGEM
// =====================================================

if (imageUrl) {
  addLog(
    "SUCCESS",
    `Imagem do patch encontrada: ${imageUrl}`
  );
} else {
  addLog(
    "WARN",
    "Não foi encontrada imagem na página específica do patch."
  );
}

return {
  url: patchLink,
  title,
  image: imageUrl
};

} catch (error) {

addLog(
  "ERROR",
  `Erro ao consultar patch: ${error.message}`
);

throw error;

}
}
// =====================================================
// ENVIAR PATCH PARA DISCORD
// =====================================================

async function sendPatchToDiscord(patch) {
  try {
    if (!config.channelId) {
      addLog(
        "WARN",
        "Nenhum canal configurado para envio."
      );

      return false;
    }

    const channel = await client.channels.fetch(
      config.channelId
    );

    if (!channel) {
      throw new Error("Canal não encontrado.");
    }

    const embed = new EmbedBuilder()
      .setTitle(patch.title)
      .setURL(patch.url)
      .setDescription(
        "📢 Novas notas de atualização do League of Legends!"
      )
      .setTimestamp();

    if (patch.image) {
      embed.setImage(patch.image);
    }

    const button = new ButtonBuilder()
      .setLabel("Ver notas do patch")
      .setURL(patch.url)
      .setStyle(ButtonStyle.Link);

    const row = new ActionRowBuilder().addComponents(button);

    await channel.send({
      embeds: [embed],
      components: [row]
    });

    addLog(
      "SUCCESS",
      `Patch enviado para o canal ${channel.name}.`
    );

    return true;
  } catch (error) {
    addLog(
      "ERROR",
      `Erro ao enviar patch para Discord: ${error.message}`
    );

    return false;
  }
}

// =====================================================
// VERIFICAR PATCH
// =====================================================

async function checkPatch(forceSend = false) {
  try {
    const patch = await fetchPatchNotes();

    const isNew =
      patch.url !== config.lastPatchUrl;

    addLog(
      "INFO",
      isNew
        ? "Foi detectado um novo patch."
        : "Nenhum patch novo encontrado."
    );

    if ((isNew && config.autoSend) || forceSend) {
      const sent = await sendPatchToDiscord(patch);

      if (sent) {
        config.lastPatchUrl = patch.url;
        saveConfig(config);
      }
    }

    return {
      success: true,
      isNew,
      patch
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

// =====================================================
// AGENDAMENTO
// =====================================================

let scheduledJobs = [];

function restartSchedules() {
  scheduledJobs.forEach((job) => job.stop());

  scheduledJobs = [];

  if (!Array.isArray(config.schedules)) {
    config.schedules = [];
  }

  config.schedules.forEach((time) => {
    if (!/^\d{2}:\d{2}$/.test(time)) {
      addLog(
        "WARN",
        `Horário inválido ignorado: ${time}`
      );
      return;
    }

    const [hour, minute] = time.split(":");

    const expression = `${minute} ${hour} * * *`;

    const job = cron.schedule(
      expression,
      async () => {
        addLog(
          "INFO",
          `Verificação automática iniciada às ${time}.`
        );

        await checkPatch(false);
      },
      {
        timezone: "America/Sao_Paulo"
      }
    );

    scheduledJobs.push(job);

    addLog(
      "INFO",
      `Agendamento criado para ${time}.`
    );
  });
}

// =====================================================
// SLASH COMMAND
// =====================================================

async function registerCommands() {
  try {
    const commands = [
      new SlashCommandBuilder()
        .setName("patch")
        .setDescription(
          "Verifica e mostra o patch atual do League of Legends"
        )
        .toJSON()
    ];

    const rest = new REST({
      version: "10"
    }).setToken(process.env.BOT_TOKEN);

    await rest.put(
      Routes.applicationCommands(client.user.id),
      {
        body: commands
      }
    );

    addLog(
      "SUCCESS",
      "Comando /patch registrado no Discord."
    );
  } catch (error) {
    addLog(
      "ERROR",
      `Erro ao registrar /patch: ${error.message}`
    );
  }
}

client.once("ready", async () => {
  addLog(
    "SUCCESS",
    `Bot conectado como ${client.user.tag}.`
  );

  addLog(
    "INFO",
    `Servidores encontrados: ${client.guilds.cache.size}`
  );

  restartSchedules();

  await registerCommands();
});

// =====================================================
// INTERAÇÃO /PATCH
// =====================================================

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  if (interaction.commandName !== "patch") {
    return;
  }

  await interaction.deferReply();

  const result = await checkPatch(true);

  if (!result.success) {
    await interaction.editReply(
      `❌ Erro ao consultar o patch: ${result.error}`
    );

    return;
  }

  const patch = result.patch;

  const embed = new EmbedBuilder()
    .setTitle(patch.title)
    .setURL(patch.url)
    .setDescription(
      "📰 Notas de atualização do League of Legends"
    )
    .setTimestamp();

  if (patch.image) {
    embed.setImage(patch.image);
  }

  const button = new ButtonBuilder()
    .setLabel("Ver notas do patch")
    .setURL(patch.url)
    .setStyle(ButtonStyle.Link);

  const row = new ActionRowBuilder().addComponents(button);

  await interaction.editReply({
    embeds: [embed],
    components: [row]
  });

  addLog(
    "SUCCESS",
    `/patch executado por ${interaction.user.tag}.`
  );
});

// =====================================================
// PAINEL WEB
// =====================================================

// Status geral
app.get("/api/status", (req, res) => {
  res.json({
    online: client.isReady(),
    botName: client.user
      ? client.user.tag
      : null,
    guildCount: client.guilds.cache.size,
    schedules: config.schedules,
    channelId: config.channelId,
    autoSend: config.autoSend,
    lastPatchUrl: config.lastPatchUrl
  });
});

// Configuração
app.get("/api/config", (req, res) => {
  res.json(config);
});

// Salvar configuração
app.post("/api/config", (req, res) => {
  try {
    const newConfig = req.body;

    if (
      !newConfig ||
      !Array.isArray(newConfig.schedules)
    ) {
      return res.status(400).json({
        success: false,
        error: "Horários inválidos."
      });
    }

    const validSchedules = newConfig.schedules.filter(
      (time) => /^\d{2}:\d{2}$/.test(time)
    );

    config = {
      schedules: validSchedules,
      channelId: newConfig.channelId || "",
      autoSend: Boolean(newConfig.autoSend),
      lastPatchUrl: config.lastPatchUrl || ""
    };

    saveConfig(config);

    restartSchedules();

    addLog(
      "SUCCESS",
      "Configurações do painel foram atualizadas."
    );

    res.json({
      success: true,
      config
    });
  } catch (error) {
    addLog(
      "ERROR",
      `Erro ao salvar configuração: ${error.message}`
    );

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// =====================================================
// LISTAR SERVIDORES
// =====================================================

app.get("/api/guilds", (req, res) => {
  try {
    const guilds = client.guilds.cache.map((guild) => ({
      id: guild.id,
      name: guild.name,
      icon: guild.iconURL()
    }));

    res.json(guilds);
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

// =====================================================
// LISTAR CANAIS DE UM SERVIDOR
// =====================================================

app.get("/api/channels/:guildId", async (req, res) => {
  try {
    const guild = client.guilds.cache.get(
      req.params.guildId
    );

    if (!guild) {
      return res.status(404).json({
        error: "Servidor não encontrado."
      });
    }

    const channels = guild.channels.cache
      .filter(
        (channel) =>
          channel.isTextBased() &&
          channel.viewable
      )
      .map((channel) => ({
        id: channel.id,
        name: channel.name,
        type: channel.type
      }));

    res.json(channels);
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

// =====================================================
// VERIFICAR AGORA
// =====================================================

app.post("/api/check", async (req, res) => {
  addLog(
    "INFO",
    "Verificação manual solicitada pelo painel."
  );

  const result = await checkPatch(true);

  res.json(result);
});

// =====================================================
// LOGS
// =====================================================

app.get("/api/logs", (req, res) => {
  res.json(logs);
});

// =====================================================
// HEALTH CHECK
// =====================================================

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

// =====================================================
// SERVIDOR
// =====================================================

app.listen(PORT, () => {
  addLog(
    "SUCCESS",
    `Painel web disponível na porta ${PORT}.`
  );
});

// =====================================================
// LOGIN DISCORD
// =====================================================

client.login(process.env.BOT_TOKEN).catch((error) => {
  addLog(
    "ERROR",
    `Erro ao conectar no Discord: ${error.message}`
  );
});
