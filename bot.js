const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} = require("discord.js");
const axios = require("axios");
const sqlite3 = require("sqlite3").verbose();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

// URL publique du serveur (doit correspondre exactement à celui défini dans server.js)
const SERVER_URL = "https://blzverification.netlify.app";
const NOTIFICATION_CHANNEL_ID = "1322369498858131507"; // Salon de notifications
const VERIFIED_ROLE_ID = "1353130129400004619"; // Rôle pour les comptes vérifiés
const ALT_ROLE_ID = "1353155754034466816"; // Rôle pour les alt/doubles comptes

// Connexion à la base de données pour la commande /recherche
const db = new sqlite3.Database("./database.db", (err) => {
  if (err) {
    console.error("Erreur DB dans bot.js:", err.message);
  } else {
    console.log("Base de données connectée dans bot.js.");
  }
});

client.once("ready", async () => {
  console.log(`Bot Discord connecté en tant que ${client.user.tag}`);
  // Enregistrement global de la commande slash /recherche
  try {
    await client.application.commands.set([
      {
        name: "recherche",
        description: "Recherche les doubles comptes associés à un membre donné.",
        options: [
          {
            name: "compte",
            type: 3, // STRING
            description: "L'ID du compte à rechercher",
            required: true,
          },
        ],
      },
    ]);
    console.log("Commande slash /recherche enregistrée globalement.");
  } catch (err) {
    console.error("Erreur lors de l'enregistrement de la commande slash:", err.message);
  }
});

// --- Gestion des messages IPC reçus depuis server.js ---
process.on("message", async (msg) => {
  console.log("Message reçu du serveur via IPC:", msg);
  const channel = client.channels.cache.get(NOTIFICATION_CHANNEL_ID);
  if (!channel) {
    console.error("Canal de notifications introuvable.");
    return;
  }
  const guild = channel.guild;
  if (msg.type === "verified") {
    // Cas 1 : Vérification réussie → Envoi d'un embed et attribution du rôle vérifié.
    const embed = new EmbedBuilder()
      .setTitle("Vérification réussie")
      .setDescription(`<@${msg.userId}> (${msg.userId}) a été correctement vérifié par BLZbot.`)
      .setColor(0x00ff00)
      .setTimestamp();
    channel.send({ embeds: [embed] });
    if (guild) {
      try {
        const member = await guild.members.fetch(msg.userId);
        if (member && !member.roles.cache.has(VERIFIED_ROLE_ID)) {
          await member.roles.add(VERIFIED_ROLE_ID);
          console.log(`Rôle vérifié attribué à ${member.user.tag}`);
        }
      } catch (err) {
        console.error("Erreur lors de l'attribution du rôle vérifié :", err.message);
      }
    }
  } else if (msg.type === "double") {
    // Cas 2 / 3 : Double compte détecté → Envoi d'un embed et attribution du rôle alt.
    const embed = new EmbedBuilder()
      .setTitle("Double compte détecté")
      .setDescription(msg.notification)
      .setColor(0xff0000)
      .setTimestamp();
    channel.send({ embeds: [embed] });
    if (guild) {
      try {
        const member = await guild.members.fetch(msg.userId);
        if (member && !member.roles.cache.has(ALT_ROLE_ID)) {
          await member.roles.add(ALT_ROLE_ID);
          console.log(`Rôle alt attribué à ${member.user.tag}`);
        }
      } catch (err) {
        console.error("Erreur lors de l'attribution du rôle alt :", err.message);
      }
    }
  }
});

// --- Commande !verify ---
// Envoie en MP le lien de vérification personnalisé au membre appelant.
client.on("messageCreate", async (message) => {
  if (message.content.startsWith("!verify")) {
    const userId = message.author.id;
    const encodedUserId = Buffer.from(userId).toString("base64");
    try {
      const verifiedResponse = await axios.get(`${SERVER_URL}/isVerified?userId=${encodedUserId}`);
      if (verifiedResponse.data.verified) {
        return message.reply("Vous êtes déjà vérifié !");
      }
      const keyResponse = await axios.get(`${SERVER_URL}/key`);
      const link = `${SERVER_URL}/collect?userId=${encodedUserId}&key=${keyResponse.data.key}&from=bot`;
      await message.author.send(
        `:warning: **Attention** : En cliquant sur ce lien, vous acceptez que votre IP soit récupérée par le bot.\nCette méthode de vérification n'est pas obligatoire, mais elle nous permet d'être sûrs que vous n'utilisez pas de comptes multiples.\n\n**Lien de vérification** : ${link}`
      );
      return message.reply("Le lien de vérification vous a été envoyé en MP.");
    } catch (err) {
      console.error("Erreur lors de !verify :", err.message);
      return message.reply("Une erreur est survenue lors de votre vérification.");
    }
  }
});

// --- Commande !button ---
// Réservée aux administrateurs : publie un message public avec un embed contenant un bouton interactif.  
// Quand un utilisateur clique sur ce bouton, il reçoit en MP un lien de vérification personnalisé.
// Avant de générer un lien, le bot vérifie si l'utilisateur est déjà vérifié.
client.on("messageCreate", async (message) => {
  if (message.content.startsWith("!button")) {
    if (!message.member.permissions.has("Administrator")) {
      return message.reply("Seuls les administrateurs peuvent utiliser cette commande.");
    }
    const userId = message.author.id;
    const encodedUserId = Buffer.from(userId).toString("base64");
    try {
      const keyResponse = await axios.get(`${SERVER_URL}/key`);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("generate_verification_link")
          .setLabel("Générez votre lien de vérification")
          .setStyle(ButtonStyle.Primary)
      );
      const embed = new EmbedBuilder()
        .setTitle("Vérification de compte")
        .setDescription(
          `:warning: **Attention** : Cliquez sur le bouton ci-dessous pour obtenir un lien de vérification personnalisé.\nCe lien sera valable pendant 60 secondes.`
        )
        .setColor(0xffaa00)
        .setTimestamp();
      return message.channel.send({ embeds: [embed], components: [row] });
    } catch (err) {
      console.error("Erreur lors de !button :", err.message);
      return message.reply("Une erreur est survenue lors de la création du bouton de vérification.");
    }
  }
});

// --- Gestion des interactions sur les boutons ---
// Avant de générer un nouveau lien, le bot vérifie si l'utilisateur est déjà vérifié.
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;
  if (interaction.customId === "generate_verification_link") {
    const userId = interaction.user.id;
    const encodedUserId = Buffer.from(userId).toString("base64");
    try {
      const verifiedResponse = await axios.get(`${SERVER_URL}/isVerified?userId=${encodedUserId}`);
      if (verifiedResponse.data.verified) {
        return interaction.reply({
          content: "Vous êtes déjà vérifié !",
          ephemeral: true,
        });
      }
      const keyResponse = await axios.get(`${SERVER_URL}/key`);
      const link = `${SERVER_URL}/collect?userId=${encodedUserId}&key=${keyResponse.data.key}&from=bot`;
      await interaction.reply({
        content: `:warning: **Attention** : En cliquant sur ce lien, vous acceptez que votre IP soit récupérée par le bot.\n\n**Lien de vérification** : ${link}`,
        ephemeral: true,
      });
    } catch (err) {
      console.error("Erreur lors de l'interaction sur le bouton :", err.message);
      await interaction.reply({
        content: "Une erreur est survenue lors de la génération du lien.",
        ephemeral: true,
      });
    }
  }
});

// --- Commande slash /recherche ---
// Recherche globalement les doubles comptes associés à un compte donné.
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isCommand()) return;
  if (interaction.commandName === "recherche") {
    const compte = interaction.options.getString("compte");
    if (!compte) {
      return interaction.reply({ content: "Veuillez fournir un compte à rechercher.", ephemeral: true });
    }
    db.get("SELECT hashed_ip FROM user_data WHERE user_id = ?", [compte], (err, row) => {
      if (err) {
        console.error("Erreur lors de la recherche :", err.message);
        return interaction.reply({ content: "Erreur lors de la recherche.", ephemeral: true });
      }
      if (!row) {
        return interaction.reply({ content: "Aucun compte trouvé pour ce membre.", ephemeral: true });
      }
      const targetHash = row.hashed_ip;
      db.all("SELECT user_id FROM user_data WHERE hashed_ip = ?", [targetHash], (err, rows) => {
        if (err) {
          console.error("Erreur lors de la recherche multiple :", err.message);
          return interaction.reply({ content: "Erreur lors de la recherche des comptes associés.", ephemeral: true });
        }
        if (rows.length <= 1) {
          return interaction.reply({ content: "Aucun double compte détecté pour ce membre.", ephemeral: true });
        }
        const list = rows.map(r => `<@${r.user_id}> (${r.user_id})`).join("\n");
        const embed = new EmbedBuilder()
          .setTitle("Résultat de la recherche de doubles comptes")
          .setDescription(`Les comptes suivants partagent la même IP que <@${compte}> :\n${list}`)
          .setColor(0xff0000)
          .setTimestamp();
        interaction.reply({ embeds: [embed], ephemeral: true });
      });
    });
  }
});

client.login("process.env.BOT_TOKEN");

