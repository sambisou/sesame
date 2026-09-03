// Serveur MCP (stdio). Expose des outils qui agissent SANS jamais renvoyer un secret.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadSites } from "./config.js";
import { hasSecret, keychainAvailable } from "./keychain.js";
import { readJournal, logEvent } from "./journal.js";
import { isLocked } from "./policy.js";
import { login, openLogin, waitCode, requestSite } from "./login.js";

const UNKNOWN_HINT = "Ce site n'est pas dans Sésame. N'envoie pas l'utilisateur dans un terminal : appelle sesame_request_site(site, url, reason) — une fenêtre Sésame s'ouvre sur son Mac pour qu'il saisisse ses identifiants, puis rappelle sesame_login.";
/** Dernier filet : aucun message d'erreur ne doit jamais transporter une ligne de commande ou un JSON de secret. */
export function scrub(msg) {
  let m = String(msg || "erreur inconnue").split("\n")[0];
  if (/\bsecurity\b.*\s-w\b|"password"\s*:|Command failed/i.test(m)) m = "opération Trousseau échouée (détail masqué)";
  return m.slice(0, 300);
}
async function guarded(fn) {
  try {
    const r = await fn();
    if (r && typeof r.message === "string") r.message = scrub(r.message);
    return r;
  } catch (e) {
    const msg = scrub(e.message || e);
    if (/Site inconnu/.test(msg)) return { ok: false, message: msg, hint: UNKNOWN_HINT };
    return { ok: false, message: msg };
  }
}

const CALLER = process.env.SESAME_CALLER || process.argv[2] || "mcp";

const text = obj => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });

/** @param {string} [caller] nom de l'appelant journalisé (stdio : argument de ligne de commande ; HTTP : en-tête X-Sesame-Caller) */
export function buildServer(caller = CALLER) {
  const server = new McpServer({ name: "sesame", version: "0.5.1" });

  server.tool(
    "sesame_list_sites",
    "Liste les sites pour lesquels l'utilisateur a enregistré des identifiants dans Sésame (nom, domaine, politique d'accès, dernière utilisation). Ne révèle aucun secret. Appelle-le pour savoir quel nom de site utiliser avec sesame_login.",
    {},
    async () => {
      const sites = loadSites();
      const list = Object.entries(sites).map(([key, s]) => ({
        site: key, domain: s.domain, loginUrl: s.loginUrl, policy: s.policy,
        hasCredentials: keychainAvailable() ? hasSecret(key) : null, lastUsed: s.lastUsed || null, note: s.note || undefined,
      }));
      return text({ locked: isLocked(), sites: list });
    }
  );

  server.tool(
    "sesame_login",
    "Demande à Sésame de remplir (et par défaut soumettre) le formulaire de connexion d'un site dans l'onglet Chrome de l'utilisateur. Sésame lit les identifiants dans le Trousseau macOS et les tape lui-même : tu ne les vois jamais. Selon la politique du site, l'utilisateur devra valider une boîte de dialogue sur son Mac. Si le site demande ensuite un code (SMS, e-mail, application), Sésame prévient l'utilisateur, attend qu'il le saisisse lui-même dans Chrome, et ne rend la main qu'une fois le code accepté (ou le délai écoulé : alors appelle sesame_wait_code). Chaque demande est journalisée. Utilise le nom exact renvoyé par sesame_list_sites. Fournis un motif court et honnête (reason) : il est affiché à l'utilisateur.",
    {
      site: z.string().describe("Nom du site tel que listé par sesame_list_sites (ex. « edf »)"),
      reason: z.string().max(200).optional().describe("Pourquoi tu as besoin de te connecter (affiché à l'utilisateur)"),
      openIfMissing: z.boolean().optional().default(true).describe("Ouvrir la page de connexion si aucun onglet du site n'est ouvert"),
      waitForCode: z.boolean().optional().default(true).describe("Si le site demande un code (2e facteur), attendre que l'utilisateur le saisisse avant de répondre (défaut true)"),
      codeTimeoutSec: z.number().int().min(10).max(900).optional().default(180).describe("Délai maximal d'attente du code, en secondes (défaut 180)"),
    },
    async ({ site, reason, openIfMissing, waitForCode, codeTimeoutSec }) =>
      text(await guarded(async () => {
        // Toujours soumettre : un formulaire laissé rempli sans soumission exposerait le mot de passe dans la page.
        const r = await login({ site, reason, submit: true, openIfMissing, waitForCode, codeTimeoutSec, caller });
        if (!r.ok && /Aucun identifiant enregistré/.test(r.message || "")) r.hint = UNKNOWN_HINT;
        return r;
      }))
  );

  server.tool(
    "sesame_request_site",
    "Quand un site n'est pas encore dans Sésame : ouvre une fenêtre Sésame sur le Mac de l'utilisateur qui lui propose de saisir lui-même identifiant et mot de passe pour ce site (rangés dans le Trousseau macOS, jamais transmis). À utiliser À LA PLACE de « lance sesame add … dans un terminal ». Donne le nom court du site, l'URL exacte de sa page de connexion et un motif honnête. Réponse : enregistré / refusé / déjà connu — jamais les valeurs. Ensuite, appelle sesame_login.",
    {
      site: z.string().max(40).describe("Nom court du site, minuscules (ex. « infomaniak »)"),
      url: z.string().url().describe("URL de la page de connexion (ex. https://login.infomaniak.com/)"),
      reason: z.string().max(200).optional().describe("Pourquoi tu as besoin de ce site (affiché à l'utilisateur)"),
      note: z.string().max(120).optional().describe("Mémo utile, ex. « connexion en 2 étapes : e-mail, Continuer, mot de passe »"),
      replace: z.boolean().optional().default(false).describe("true pour réenregistrer un site déjà connu (mot de passe changé, ou élément du Trousseau à recréer)"),
    },
    async ({ site, url, reason, note, replace }) => text(await guarded(() => requestSite({ site, url, reason, note, replace, caller })))
  );

  server.tool(
    "sesame_wait_code",
    "Reprend l'attente du code (2e facteur) sur l'onglet du site : Sésame prévient l'utilisateur, attend qu'il tape le code reçu par e-mail, SMS ou application dans le Chrome Sésame, et répond quand le site l'a accepté. À appeler quand sesame_login a signalé un code non saisi dans le délai. Ne remplit rien, ne voit jamais le code.",
    {
      site: z.string().describe("Nom du site (voir sesame_list_sites)"),
      timeoutSec: z.number().int().min(10).max(900).optional().default(180).describe("Délai maximal d'attente, en secondes (défaut 180)"),
    },
    async ({ site, timeoutSec }) => text(await guarded(() => waitCode({ site, timeoutSec, caller })))
  );

  server.tool(
    "sesame_open_login",
    "Ouvre (ou ramène au premier plan) la page de connexion d'un site dans le Chrome de l'utilisateur, sans rien remplir. Utile avant sesame_login si la page n'est pas encore ouverte.",
    { site: z.string().describe("Nom du site (voir sesame_list_sites)") },
    async ({ site }) => text(await guarded(() => openLogin({ site, caller })))
  );

  server.tool(
    "sesame_journal",
    "Lit le journal d'accès de Sésame : quand, quel site, quel appelant, autorisé/refusé/réussi. Lecture seule, aucun secret. Sert à rendre compte à l'utilisateur de ce qui a été fait.",
    {
      site: z.string().optional().describe("Filtrer sur un site"),
      limit: z.number().int().min(1).max(500).optional().default(30),
    },
    async ({ site, limit }) => text(readJournal({ site, limit }))
  );

  return server;
}

export async function main() {
  const server = buildServer();
  const transport = new StdioServerTransport();
  logEvent({ action: "server_start", caller: CALLER, result: "ok", detail: `pid ${process.pid}` });
  await server.connect(transport);
}
