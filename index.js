require("dotenv").config();

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const cheerio = require("cheerio");
const express = require("express");
const cron = require("node-cron");
const { Redis } = require("@upstash/redis");

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

const DEFAULT_CONFIG = {
  schedules: ["10:00", "14:00"],
  channelId: "",
  autoSend: true,
  lastPatchUrl: ""
};

// Se as variáveis de ambiente do Upstash estiverem presentes, a config é
// persistida lá (sobrevive a redeploys/restarts, inclusive no free tier do
// Render, que apaga o disco local a cada restart). Sem essas variáveis, o
// bot cai de volta para o config.json local (ex: rodando numa VPS/Docker
// com disco persistente).
const USE_REDIS = Boolean(
  process.env.UPSTASH_REDIS_REST_URL &&
  process.env.UPSTASH_REDIS_REST_TOKEN
);

const redis = USE_REDIS
  ? Redis.fromEnv()
  : null;

const REDIS_CONFIG_KEY = "patchwatcher:config";

async function loadConfig() {
  if (USE_REDIS) {
    try {
      const stored = await redis.get(REDIS_CONFIG_KEY);

      if (stored) {
        return { ...DEFAULT_CONFIG, ...stored };
      }

      await redis.set(REDIS_CONFIG_KEY, DEFAULT_CONFIG);

      return { ...DEFAULT_CONFIG };

    } catch (error) {
      console.error(
        "Erro ao carregar config do Upstash Redis:",
        error
      );

      return { ...DEFAULT_CONFIG };
    }
  }

  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      fs.writeFileSync(
        CONFIG_FILE,
        JSON.stringify(DEFAULT_CONFIG, null, 2)
      );

      return { ...DEFAULT_CONFIG };
    }

    return JSON.parse(
      fs.readFileSync(CONFIG_FILE, "utf8")
    );

  } catch (error) {
    console.error(
      "Erro ao carregar config.json:",
      error
    );

    return { ...DEFAULT_CONFIG };
  }
}

async function saveConfig(config) {
  if (USE_REDIS) {
    try {
      await redis.set(REDIS_CONFIG_KEY, config);
      return;

    } catch (error) {
      console.error(
        "Erro ao salvar config no Upstash Redis:",
        error
      );

      return;
    }
  }

  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify(config, null, 2)
  );
}

// Placeholder até o bootstrap assíncrono (função start(), no fim do
// arquivo) carregar a config real antes do bot logar e do painel subir.
let config = { ...DEFAULT_CONFIG };

// =====================================================
// LOGS
// =====================================================

const REDIS_LOGS_KEY = "patchwatcher:logs";

const logs = [];

// Salva a lista de logs no Upstash Redis. Chamada de forma "fire and
// forget" (sem await) porque addLog é síncrona e é chamada com muita
// frequência — não vale a pena travar cada chamada esperando o Redis.
function persistLogs() {
  if (!USE_REDIS) return;

  redis.set(REDIS_LOGS_KEY, logs).catch((error) => {
    console.error(
      "Erro ao salvar logs no Upstash Redis:",
      error
    );
  });
}

// Carrega o histórico de logs salvo no Redis, se existir, para o
// painel não começar vazio depois de um restart/cold start.
async function loadLogs() {
  if (!USE_REDIS) return;

  try {
    const stored = await redis.get(REDIS_LOGS_KEY);

    if (Array.isArray(stored)) {
      logs.push(...stored);
    }
  } catch (error) {
    console.error(
      "Erro ao carregar logs do Upstash Redis:",
      error
    );
  }
}

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

  console.log(
    `[${type}] ${message}`
  );

  persistLogs();
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

    // -------------------------------------------------
    // 1. CONSULTA A LISTA DE PATCHES
    // -------------------------------------------------

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

    const $ = cheerio.load(
      response.data
    );

    // Procura o patch mais recente
    const latestPatch =
      $('a[href*="patch-"]')
        .first()
        .attr("href");

    if (!latestPatch) {
      throw new Error(
        "Não foi encontrado nenhum link de patch na página da Riot."
      );
    }

    let patchLink = latestPatch;

    // Corrige URL relativa
    if (patchLink.startsWith("/")) {
      patchLink =
        "https://www.leagueoflegends.com" +
        patchLink;
    }

    addLog(
      "INFO",
      `Patch encontrado: ${patchLink}`
    );

    // -------------------------------------------------
    // 2. ABRE A PÁGINA ESPECÍFICA DO PATCH
    // -------------------------------------------------

    const patchPageResponse =
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
        patchPageResponse.data
      );

    // -------------------------------------------------
    // 3. PEGA A MESMA IMAGEM DO BOT ANTIGO
    // -------------------------------------------------

    let imageUrl =
      patchPage(
        ".skins.cboxElement img"
      )
        .first()
        .attr("src") || null;

    // -------------------------------------------------
    // 4. FALLBACKS
    // -------------------------------------------------

    if (!imageUrl) {
      imageUrl =
        patchPage(
          ".skins.cboxElement img"
        )
          .first()
          .attr("data-src") || null;
    }

    if (!imageUrl) {
      imageUrl =
        patchPage(
          ".skins.cboxElement img"
        )
          .first()
          .attr("data-lazy-src") || null;
    }

    // Fallback para srcset
    if (!imageUrl) {
      const srcset =
        patchPage(
          ".skins.cboxElement img"
        )
          .first()
          .attr("srcset");

      if (srcset) {
        imageUrl = srcset
          .split(",")[0]
          .trim()
          .split(" ")[0];
      }
    }

    // -------------------------------------------------
    // 5. CORRIGE URL DA IMAGEM
    // -------------------------------------------------

    if (imageUrl) {
      if (
        imageUrl.startsWith("//")
      ) {
        imageUrl =
          "https:" + imageUrl;

      } else if (
        imageUrl.startsWith("/")
      ) {
        imageUrl =
          "https://www.leagueoflegends.com" +
          imageUrl;
      }
    }

    // -------------------------------------------------
    // 6. TÍTULO
    // -------------------------------------------------

    let title =
      patchPage(
        'meta[property="og:title"]'
      ).attr("content") ||
      patchPage("title").text() ||
      "Patch do League of Legends";

    title = title
      .replace(/\s+/g, " ")
      .trim();

    // -------------------------------------------------
    // 7. LOG DA IMAGEM
    // -------------------------------------------------

    if (imageUrl) {
      addLog(
        "SUCCESS",
        `Imagem do patch encontrada: ${imageUrl}`
      );
    } else {
      addLog(
        "WARN",
        "Imagem do patch não encontrada pelo seletor .skins.cboxElement img."
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
// EXTRAIR NÚMERO DA VERSÃO (ex: "26.18")
// =====================================================

function extractPatchVersion(patch) {
  // Tenta achar algo tipo "26.18" no título
  // (ex: "Notas da Atualização 26.18 do League of Legends").
  const fromTitle =
    patch.title &&
    patch.title.match(/(\d{1,2}\.\d{1,2})/);

  if (fromTitle) {
    return fromTitle[1];
  }

  // Fallback: tenta achar no formato "26-18" na URL
  // (ex: .../notas-da-atualizacao-26-18/).
  const fromUrl =
    patch.url &&
    patch.url.match(/(\d{1,2})-(\d{1,2})(?:[\/-]|$)/);

  if (fromUrl) {
    return `${fromUrl[1]}.${fromUrl[2]}`;
  }

  // Se não conseguir extrair um número, usa o título mesmo como
  // identificação (melhor que nada no log).
  return patch.title || "desconhecido";
}

// =====================================================
// ENVIAR PATCH PARA O DISCORD
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

    const channel =
      await client.channels.fetch(
        config.channelId
      );

    if (!channel) {
      throw new Error(
        "Canal configurado não foi encontrado."
      );
    }

    const embed =
      new EmbedBuilder()
        .setTitle(
          patch.title ||
          "🎮 Novos Patch Notes!"
        )
        .setURL(patch.url)
        .setDescription(
          "📰 Notas de atualização do League of Legends"
        )
        .setTimestamp();

    // Imagem de destaque
    if (patch.image) {
      embed.setImage(
        patch.image
      );
    }

    const button =
      new ButtonBuilder()
        .setLabel(
          "Ver notas do patch"
        )
        .setURL(patch.url)
        .setStyle(
          ButtonStyle.Link
        );

    const row =
      new ActionRowBuilder()
        .addComponents(
          button
        );

    await channel.send({
      embeds: [embed],
      components: [row]
    });

    addLog(
      "SUCCESS",
      `Patch ${extractPatchVersion(patch)} foi postado.`
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

async function checkPatch(
  forceSend = false
) {
  try {
    const patch =
      await fetchPatchNotes();

    // Só considera "novo" se já existir uma referência anterior salva.
    // Sem isso, a primeira checagem depois de um deploy do zero (ou de
    // qualquer falha ao carregar o config persistido) trataria o patch
    // atual — que pode já estar no ar há dias — como recém-lançado, e
    // postaria ele no canal por engano.
    const hasBaseline =
      Boolean(config.lastPatchUrl);

    const isNew =
      hasBaseline &&
      patch.url !==
      config.lastPatchUrl;

    // Só registra log quando há algo relevante a dizer: a primeira vez
    // que uma referência é criada, ou quando um patch novo é detectado.
    // Uma checagem que não encontrou nada novo não gera log (evita
    // poluir o histórico com "nenhum patch novo" repetido).
    if (!hasBaseline) {
      addLog(
        "INFO",
        "Nenhuma referência anterior salva — este patch vira o ponto de partida, sem postar no canal."
      );
    } else if (isNew) {
      addLog(
        "INFO",
        `Novo patch detectado: ${extractPatchVersion(patch)}.`
      );
    }

    let sent = false;
    let attemptedSend = false;

    if (
      (isNew && config.autoSend) ||
      forceSend
    ) {
      attemptedSend = true;

      sent =
        await sendPatchToDiscord(
          patch
        );
    }

    // Atualiza a referência salva quando o envio deu certo, OU quando
    // ainda não existia nenhuma referência (define o ponto de partida
    // sem precisar enviar nada). Isso evita reenviar o mesmo link em
    // restarts futuros.
    if (
      patch.url !== config.lastPatchUrl &&
      (sent || !hasBaseline)
    ) {
      config.lastPatchUrl =
        patch.url;

      await saveConfig(config);
    }

    return {
      success: true,
      isNew,
      patch,
      attemptedSend,
      sent
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
  scheduledJobs.forEach(
    (job) => job.stop()
  );

  scheduledJobs = [];

  if (
    !Array.isArray(
      config.schedules
    )
  ) {
    config.schedules = [];
  }

  config.schedules.forEach(
    (time) => {
      if (
        !/^\d{2}:\d{2}$/.test(time)
      ) {
        addLog(
          "WARN",
          `Horário inválido ignorado: ${time}`
        );

        return;
      }

      const [
        hour,
        minute
      ] = time.split(":");

      const expression =
        `${minute} ${hour} * * *`;

      const job =
        cron.schedule(
          expression,
          async () => {
            addLog(
              "INFO",
              `Verificação automática iniciada às ${time}.`
            );

            await checkPatch(false);
          },
          {
            timezone:
              "America/Sao_Paulo"
          }
        );

      scheduledJobs.push(job);

      addLog(
        "INFO",
        `Agendamento criado para ${time}.`
      );
    }
  );
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

    const rest =
      new REST({
        version: "10"
      }).setToken(
        process.env.BOT_TOKEN
      );

    await rest.put(
      Routes.applicationCommands(
        client.user.id
      ),
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

// =====================================================
// BOT READY
// =====================================================

client.once(
  "ready",
  async () => {
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

    // Checagem "de boas-vindas": toda vez que o processo sobe (seja por
    // um restart normal, seja por um cold start do Render acordando o
    // serviço fora dos horários agendados), aproveita e já verifica se
    // saiu um patch novo. Útil pra pegar um patch que saiu num horário
    // diferente do previsto. forceSend=false garante que só envia se
    // realmente for algo novo (sem duplicar mensagem antiga).
    addLog(
      "INFO",
      "Checagem de patch ao iniciar o bot (cold start / restart)."
    );

    try {
      await checkPatch(false);
    } catch (error) {
      addLog(
        "ERROR",
        `Erro na checagem de patch ao iniciar: ${error.message}`
      );
    }
  }
);


// =====================================================
// INTERAÇÃO /PATCH
// =====================================================


client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName !== "patch") return;

  // A resposta do slash command será privada,
  // evitando aparecer uma segunda mensagem no canal.
  await interaction.deferReply({
    ephemeral: true
  });

  try {
    const result = await checkPatch(true);

    if (!result.success) {
      await interaction.editReply(
        `❌ Erro ao consultar o patch: ${result.error}`
      );
      return;
    }

    const patch = result.patch;

    if (!result.attemptedSend) {
      // Não deveria acontecer já que forceSend=true,
      // mas cobre o caso defensivamente.
      await interaction.editReply(
        `ℹ️ Patch **${patch.title}** encontrado, mas o envio não foi acionado.`
      );
    } else if (!result.sent) {
      await interaction.editReply(
        `⚠️ Patch **${patch.title}** foi encontrado, mas **não consegui enviá-lo ao canal**. ` +
        `Verifique se há um canal configurado no painel e se o bot tem permissão para postar nele (veja os logs do painel para o motivo exato).`
      );
    } else {
      await interaction.editReply(
        `✅ Patch **${patch.title}** enviado para o canal configurado.`
      );
    }

    addLog(
      "SUCCESS",
      `/patch executado por ${interaction.user.tag}.`
    );

  } catch (error) {
    addLog(
      "ERROR",
      `Erro no comando /patch: ${error.message}`
    );

    await interaction.editReply(
      `❌ Erro ao executar /patch: ${error.message}`
    );
  }
});

// =====================================================
// PAINEL WEB
// =====================================================

// -----------------------------------------------------
// STATUS
// -----------------------------------------------------

app.get(
  "/api/status",
  (req, res) => {
    res.json({
      online:
        client.isReady(),

      botName:
        client.user
          ? client.user.tag
          : null,

      guildCount:
        client.guilds.cache.size,

      schedules:
        config.schedules,

      channelId:
        config.channelId,

      autoSend:
        config.autoSend,

      lastPatchUrl:
        config.lastPatchUrl
    });
  }
);

// -----------------------------------------------------
// CONFIGURAÇÃO
// -----------------------------------------------------

app.get(
  "/api/config",
  (req, res) => {
    res.json(config);
  }
);

// -----------------------------------------------------
// SALVAR CONFIGURAÇÃO
// -----------------------------------------------------

app.post(
  "/api/config",
  async (req, res) => {
    try {
      const newConfig =
        req.body;

      if (
        !newConfig ||
        !Array.isArray(
          newConfig.schedules
        )
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Horários inválidos."
        });
      }

      const validSchedules =
        newConfig.schedules.filter(
          (time) =>
            /^\d{2}:\d{2}$/.test(
              time
            )
        );

      config = {
        schedules:
          validSchedules,

        channelId:
          newConfig.channelId ||
          "",

        autoSend:
          Boolean(
            newConfig.autoSend
          ),

        lastPatchUrl:
          config.lastPatchUrl ||
          ""
      };

      await saveConfig(config);

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
        error:
          error.message
      });
    }
  }
);

// =====================================================
// LISTAR SERVIDORES
// =====================================================

app.get(
  "/api/guilds",
  (req, res) => {
    try {
      const guilds =
        client.guilds.cache.map(
          (guild) => ({
            id:
              guild.id,

            name:
              guild.name,

            icon:
              guild.iconURL()
          })
        );

      res.json(guilds);

    } catch (error) {
      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

// =====================================================
// LISTAR CANAIS
// =====================================================

app.get(
  "/api/channels/:guildId",
  async (req, res) => {
    try {
      const guild =
        client.guilds.cache.get(
          req.params.guildId
        );

      if (!guild) {
        return res.status(404).json({
          error:
            "Servidor não encontrado."
        });
      }

      const channels =
        guild.channels.cache
          .filter(
            (channel) =>
              channel.isTextBased() &&
              channel.viewable
          )
          .map(
            (channel) => ({
              id:
                channel.id,

              name:
                channel.name,

              type:
                channel.type
            })
          );

      res.json(
        channels
      );

    } catch (error) {
      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

// =====================================================
// VERIFICAR AGORA
// =====================================================

app.post(
  "/api/check",
  async (req, res) => {
    addLog(
      "INFO",
      "Verificação manual solicitada pelo painel."
    );

    const result =
      await checkPatch(true);

    res.json(
      result
    );
  }
);

// =====================================================
// LOGS
// =====================================================

app.get(
  "/api/logs",
  (req, res) => {
    res.json(
      logs
    );
  }
);

// =====================================================
// HEALTH CHECK
// =====================================================

app.get(
  "/health",
  (req, res) => {
    res
      .status(200)
      .send("OK");
  }
);

// =====================================================
// BOOTSTRAP (carrega config antes de tudo, sobe painel e loga no Discord)
// =====================================================

async function start() {
  await loadLogs();

  config = await loadConfig();

  addLog(
    "INFO",
    USE_REDIS
      ? "Configuração carregada do Upstash Redis (persistente entre restarts)."
      : "Configuração carregada do config.json local."
  );

  app.listen(
    PORT,
    () => {
      addLog(
        "SUCCESS",
        `Painel web disponível na porta ${PORT}.`
      );
    }
  );

  try {
    await client.login(
      process.env.BOT_TOKEN
    );
  } catch (error) {
    addLog(
      "ERROR",
      `Erro ao conectar no Discord: ${error.message}`
    );
  }
}

start();
