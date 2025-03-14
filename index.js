const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const axios = require("axios");
const cheerio = require("cheerio");
require("dotenv").config();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

const PATCH_NOTES_URL =
  "https://www.leagueoflegends.com/pt-br/news/game-updates/";
let lastPatchNotes = "";

async function fetchPatchNotes() {
  try {
    const { data } = await axios.get(PATCH_NOTES_URL);
    const $ = cheerio.load(data);

    // Extrair o link do patch mais recente
    const latestPatch = $('a[href*="/patch-"]').first().attr("href");
    const fullUrl = `https://www.leagueoflegends.com${latestPatch}`;

    if (fullUrl !== lastPatchNotes) {
      lastPatchNotes = fullUrl;

      // Extrair a imagem de destaque
      const patchPageResponse = await axios.get(fullUrl);
      const patchPage = cheerio.load(patchPageResponse.data);
      const imageUrl = patchPage(".skins.cboxElement img").attr("src"); // Busca a imagem dentro da classe

      return {
        url: fullUrl,
        image: imageUrl,
      };
    }
    return null;
  } catch (error) {
    console.error("Error fetching patch notes:", error);
    return null;
  }
}

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  setInterval(async () => {
    const patchNotes = await fetchPatchNotes();
    if (patchNotes) {
      const channel = client.channels.cache.get(process.env.CHANNEL_ID);
      if (channel) {
        const embed = {
          title: "🎮 Novos Patch Notes!",
          description: `Confira as últimas atualizações do League of Legends: [Clique aqui](${patchNotes.url})`,
          color: 0x0099ff,
          image: {
            url: patchNotes.image, // Usando a imagem de destaque
          },
          footer: {
            text: "Patch Notes Bot",
          },
        };

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setLabel("Ver Patch Notes")
            .setURL(patchNotes.url)
            .setStyle(ButtonStyle.Link)
        );

        channel.send({
          embeds: [embed],
          components: [row],
        });
      }
    }
  }, 60000); // Verifica a cada 1 minuto
});

client.login(process.env.BOT_TOKEN);
