const { Client, GatewayIntentBits } = require("discord.js");
const axios = require("axios");
const cheerio = require("cheerio");
const http = require("http"); // Adicionado para o servidor HTTP
require("dotenv").config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // Necessário para ler o conteúdo das mensagens
  ],
});

const PATCH_NOTES_URL =
  "https://www.leagueoflegends.com/pt-br/news/game-updates/";
let lastPatchNotes = "";

// Função para buscar os patch notes
async function fetchPatchNotes() {
  try {
    const { data } = await axios.get(PATCH_NOTES_URL);
    const $ = cheerio.load(data);
    const latestPatch = $('a[href*="/patch-"]').first().attr("href");
    const fullUrl = `https://www.leagueoflegends.com${latestPatch}`;

    if (fullUrl !== lastPatchNotes) {
      lastPatchNotes = fullUrl;
      return fullUrl;
    }
    return null;
  } catch (error) {
    console.error("Erro ao buscar os patch notes:", error);
    return null;
  }
}

// Função para manter o bot ativo
async function keepAlive() {
  try {
    // Faz uma solicitação HTTP fictícia
    await axios.get("https://www.google.com"); // Qualquer URL válida
    console.log("Bot mantido ativo com sucesso!");
  } catch (error) {
    console.error("Erro ao manter o bot ativo:", error);
  }
}

// Comando !patch
client.on("messageCreate", async (message) => {
  if (message.author.bot) return; // Ignorar mensagens de outros bots

  // Comando !patch
  if (message.content === "!patch") {
    try {
      const patchNotesUrl = await fetchPatchNotes();
      if (patchNotesUrl) {
        message.reply(`Novos patch notes disponíveis: ${patchNotesUrl}`);
      } else {
        message.reply("Nenhum novo patch encontrado.");
      }
    } catch (error) {
      console.error("Erro ao consultar os patch notes:", error);
      message.reply("Ocorreu um erro ao consultar os patch notes.");
    }
  }
});

// Verificar os patch notes automaticamente às 10:00 e 14:00
client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Função para verificar os patch notes
  const checkPatchNotes = async () => {
    const patchNotesUrl = await fetchPatchNotes();
    if (patchNotesUrl) {
      const channel = client.channels.cache.get(process.env.CHANNEL_ID);
      if (channel) {
        channel.send(`Novos patch notes disponíveis: ${patchNotesUrl}`);
      }
    }
  };

  // Agendar verificações às 10:00 e 14:00
  const cron = require("node-cron");
  cron.schedule("0 10 * * *", checkPatchNotes, {
    timezone: "America/Sao_Paulo", // Defina o fuso horário correto
  });

  cron.schedule("0 14 * * *", checkPatchNotes, {
    timezone: "America/Sao_Paulo", // Defina o fuso horário correto
  });

  // Manter o bot ativo a cada 10 minutos
  setInterval(keepAlive, 10 * 60 * 1000); // 10 minutos
});

// Servidor HTTP fictício
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot está online!\n");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor HTTP ouvindo na porta ${PORT}`);
});

client.login(process.env.BOT_TOKEN);
