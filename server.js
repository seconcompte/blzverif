const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const crypto = require("crypto");
const axios = require("axios");
const { spawn } = require("child_process");

// URL publique de votre projet (à ne pas modifier)
const SERVER_URL = "blzverif.netlify.app";

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Gestion dynamique de la clé secrète ----
// Deux clés sont toujours valides : la clé actuelle et la précédente.
// Elles restent valides 60 secondes au total (mise à jour toutes les 30 sec).
let currentKey = generateSecretKey();
let previousKey = currentKey;
function generateSecretKey() {
  return crypto.randomBytes(16).toString("hex");
}
setInterval(() => {
  previousKey = currentKey;
  currentKey = generateSecretKey();
  console.log(`Nouvelle clé secrète générée : ${currentKey}`);
  console.log(`Clé précédente : ${previousKey}`);
}, 30000);

// ---- Connexion à la base de données SQLite ----
const db = new sqlite3.Database("./database.db", (err) => {
  if (err) {
    console.error("Erreur lors de la connexion à la DB :", err.message);
  } else {
    console.log("Base de données SQLite connectée.");
    db.run(
      "CREATE TABLE IF NOT EXISTS user_data (id INTEGER PRIMARY KEY, hashed_ip TEXT, user_id TEXT)",
      (err) => {
        if (err) console.error(err.message);
      }
    );
  }
});

// ---- Route /collect ----
// URL attendue : /collect?userId=[ID_EN_BASE64]&key=[CLEF]&from=bot
app.get("/collect", (req, res) => {
  // Récupérer l'IP (si plusieurs, on prend la première)
  const ip = (req.headers["x-forwarded-for"] || req.connection.remoteAddress)
    .split(",")[0]
    .trim();

  // L'ID utilisateur est envoyé en Base64 et doit être décodé.
  const encodedUserId = req.query.userId;
  if (!encodedUserId) {
    console.log("Requête rejetée : ID utilisateur manquant.");
    return res.status(400).send("ID utilisateur manquant !");
  }
  let userId;
  try {
    userId = Buffer.from(encodedUserId, "base64").toString("utf8");
  } catch (err) {
    console.error("Erreur lors du décodage de l'ID utilisateur :", err.message);
    return res.status(400).send("Format d'ID invalide !");
  }

  const key = req.query.key;
  const from = req.query.from;
  const userAgent = req.headers["user-agent"];
  console.log(`Requête reçue : IP=${ip}, userId=${userId}, key=${key}, from=${from}, userAgent=${userAgent}`);

  // Bloquer les requêtes provenant des bots Discord (ex. prévisualisation)
  if (userAgent && userAgent.includes("Discordbot")) {
    console.log("Requête ignorée car elle provient de Discordbot.");
    return res.status(204).send();
  }

  // Vérifier la clé : elle doit être égale à currentKey ou previousKey, et "from" doit être "bot"
  if (!key || (key !== currentKey && key !== previousKey) || !from || from !== "bot") {
    console.log("Requête rejetée : clé invalide ou paramètres incorrects.");
    return res
      .status(403)
      .send("Accès interdit : votre clé est périmée ou invalide. Veuillez régénérer un lien.");
  }

  // Empêcher la re‑vérification : l'utilisateur ne peut pas se faire vérifier s'il est déjà enregistré
  db.get("SELECT * FROM user_data WHERE user_id = ?", [userId], (err, existingUser) => {
    if (err) {
      console.error("Erreur lors de la vérification de l'utilisateur :", err.message);
      return res.status(500).send("Erreur interne.");
    }
    if (existingUser) {
      console.log(`L'utilisateur ${userId} est déjà vérifié.`);
      return res.status(403).send("Vous êtes déjà vérifié !");
    }

    const hashedIP = crypto.createHash("sha256").update(ip).digest("hex");
    console.log(`IP récupérée : ${ip}`);
    console.log(`ID utilisateur (décodé) : ${userId}`);

    // Vérifier si cette IP est déjà utilisée pour détecter des doubles comptes
    db.all("SELECT * FROM user_data WHERE hashed_ip = ?", [hashedIP], (err, rows) => {
      if (err) {
        console.error("Erreur lors de la vérification des IP partagées :", err.message);
        return res.status(500).send("Erreur interne.");
      }

      // Insérer l'enregistrement dans la DB, même en cas de doubles,
      // pour que la commande /recherche fonctionne correctement.
      db.run(
        "INSERT INTO user_data (hashed_ip, user_id) VALUES (?, ?)",
        [hashedIP, userId],
        (err) => {
          if (err) {
            console.error("Erreur lors de l'insertion dans la DB :", err.message);
            return res.status(500).send("Erreur lors de l'enregistrement.");
          }
          console.log("Enregistrement réussi pour", userId);

          if (rows.length === 0) {
            // Cas 1 : Vérification réussie (premier compte pour cette IP)
            if (botProcess && botProcess.send) {
              botProcess.send({ type: "verified", userId });
            }
            return res.send("Enregistrement réussi.");
          } else {
            // Cas 2 / 3 : Double compte détecté
            console.log("Suspicion de comptes multiples détectée !");
            let notification = "";
            if (rows.length === 1) {
              notification = `<@${userId}> est un alt de <@${rows[0].user_id}>.`;
            } else {
              const others = rows.map(r => `<@${r.user_id}> (${r.user_id})`).join("\n");
              notification = `<@${userId}> est un double compte de <@${rows[0].user_id}>.\nLes comptes suivants lui appartiennent également :\n${others}`;
            }
            if (botProcess && botProcess.send) {
              botProcess.send({ type: "double", userId, notification });
            }
            return res.send(`Enregistrement réussi. Toutefois, ${notification}`);
          }
        }
      );
    });
  });
});

// --- Route /key ---
// Fournit la clé secrète actuelle (pour la génération des liens par le bot)
app.get("/key", (req, res) => {
  console.log(`Clé actuelle demandée : ${currentKey}`);
  res.json({ key: currentKey });
});

// --- Route /isVerified ---
// Vérifie (avec l'ID en Base64) si un utilisateur est déjà enregistré.
app.get("/isVerified", (req, res) => {
  const encodedUserId = req.query.userId;
  if (!encodedUserId) {
    return res.status(400).send("ID utilisateur manquant !");
  }
  let userId;
  try {
    userId = Buffer.from(encodedUserId, "base64").toString("utf8");
  } catch (err) {
    return res.status(400).send("Format d'ID invalide !");
  }
  db.get("SELECT * FROM user_data WHERE user_id = ?", [userId], (err, row) => {
    if (err) {
      console.error("Erreur lors de la vérification :", err.message);
      return res.status(500).send("Erreur interne.");
    }
    res.json({ verified: !!row });
  });
});

// --- Lancement automatique de bot.js via IPC ---
// On lance bot.js avec l'option IPC pour la communication de notifications.
const botProcess = spawn("node", ["bot.js"], { stdio: ["inherit", "inherit", "inherit", "ipc"] });
botProcess.on("close", (code) => {
  console.log(`Le script bot.js s'est terminé avec le code ${code}`);
});

// --- Lancement du serveur ---
app.listen(PORT, () => {
  console.log(`Serveur lancé sur ${SERVER_URL} (localement sur le port ${PORT})`);
});
