// Client IMAP minimal (lecture seule) pour retrouver un code de connexion à usage unique (2FA)
// envoyé par e-mail. Écrit à la main sur node:tls, sans dépendance npm.
//
// Règle absolue : le mot de passe de la boîte et le code trouvé ne doivent JAMAIS apparaître
// dans un message d'erreur, une exception ou une sortie console. Ce module n'appelle jamais
// console.* et construit ses erreurs à partir de messages fixes, sans jamais y interpoler
// `pass` ni le code trouvé.
//
// Aucune écriture sur le serveur : uniquement LOGIN, SELECT/STATUS, UID FETCH (avec BODY.PEEK,
// qui ne marque jamais un message comme lu) et LOGOUT.
import tls from "node:tls";

/**
 * Cherche dans une boîte IMAP un code à usage unique arrivé récemment.
 * @param {object} o
 * @param {string} o.host      ex. "imap.gmail.com"
 * @param {number} o.port      ex. 993 (TLS implicite)
 * @param {string} o.user      adresse
 * @param {string} o.pass      mot de passe d'application (jamais journalisé)
 * @param {Date}   o.since     ne considérer que les messages reçus après cette date
 * @param {string[]} o.hints   indices du site : domaines et nom court (ex. ["booking.com","booking"])
 * @param {number} [o.maxMessages]  nombre de messages récents à examiner (défaut 25)
 * @param {number} [o.timeoutMs]    délai réseau global (défaut 15000)
 * @returns {Promise<{code: string, from: string, subject: string, receivedAt: Date} | null>}
 *   `code` = le code trouvé ; `from`/`subject` servent au JOURNAL et ne doivent pas contenir le code.
 *   null si rien ne correspond. Lève une erreur NEUTRE en cas d'échec de connexion/authentification.
 */
export async function findLoginCode(o) {
  const { host, port, user, pass, since, hints = [], maxMessages = 25, timeoutMs = 15000, insecureTLS } = o || {};
  return runSession({ host, port, user, pass, timeoutMs, insecureTLS }, async (conn, tagState) => {
    const uidnext = await getUidNext(conn, tagState);
    const start = Math.max(1, uidnext - Math.max(1, maxMessages));
    const fetched = await fetchMessages(conn, tagState, start);
    const parsed = fetched.map(parseFetchResponse);
    const sinceAdj = new Date(since.getTime() - 90_000);
    const hintsFolded = hints.map(foldText).filter(Boolean);
    const candidates = parsed.filter(m => m.receivedAt && m.receivedAt >= sinceAdj && matchesHints(m, hintsFolded));
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.receivedAt - a.receivedAt);
    let chosen = candidates[0];
    // Le premier passage ne lit que le début de chaque message (20 Ko) : le message retenu est relu
    // en entier (un mail HTML lourd met souvent le code bien après les 20 premiers Ko).
    if (chosen.uid) {
      try {
        const full = await fetchMessages(conn, tagState, chosen.uid, { single: true, maxBytes: 400000 });
        const again = full.map(parseFetchResponse).find(m => m.uid === chosen.uid);
        if (again) chosen = { ...chosen, searchText: again.searchText };
      } catch { /* on garde le début déjà lu */ }
    }
    const code = extractCode(chosen.searchText);
    // Diagnostic sans le code : structure du texte autour de la phrase « votre code… », chiffres masqués.
    try {
      EXPLICIT_RE.lastIndex = 0;
      const pm = EXPLICIT_RE.exec(chosen.searchText);
      const at = pm ? pm.index : 0;
      const extrait = chosen.searchText.slice(Math.max(0, at - 80), at + 220).replace(/\d/g, "#").replace(/\s+/g, " ");
      console.error(`[sesame] mail ${chosen.uid || "?"} : ${chosen.searchText.length} car., code ${code ? code.length + " chiffres" : "absent"} ; extrait : ${extrait}`);
    } catch {}
    if (!code) return null;
    return { code, from: chosen.fromDisplay, subject: chosen.subjectDisplay, receivedAt: chosen.receivedAt };
  });
}

/** Vérifie que l'on peut se connecter et lire la boîte. Renvoie {ok:true} ou {ok:false, message} (message neutre). */
export async function checkMailbox({ host, port, user, pass, timeoutMs = 15000, insecureTLS } = {}) {
  try {
    await runSession({ host, port, user, pass, timeoutMs, insecureTLS }, async (conn, tagState) => {
      await getUidNext(conn, tagState);
      return true;
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, message: (e && e.message) || "Connexion à la boîte mail impossible." };
  }
}

// ---------------------------------------------------------------------------
// Session : connexion, LOGIN, exécution du travail, LOGOUT, nettoyage garanti.
// ---------------------------------------------------------------------------

function neutral(message) {
  const e = new Error(message);
  e.__imapNeutral = true;
  return e;
}

/**
 * `insecureTLS` : option interne réservée aux tests (faux serveur local avec certificat auto-signé).
 * Elle désactive la vérification du certificat TLS et est refusée pour tout hôte autre que 127.0.0.1.
 */
function assertInsecureAllowed(insecureTLS, host) {
  if (insecureTLS && host !== "127.0.0.1") {
    throw neutral("Option de test réservée à 127.0.0.1.");
  }
}

async function runSession({ host, port, user, pass, timeoutMs = 15000, insecureTLS }, work) {
  assertInsecureAllowed(insecureTLS, host);
  let socket;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { socket && socket.destroy(); } catch {}
  }, timeoutMs);
  if (timer.unref) timer.unref();
  try {
    socket = tls.connect({
      host,
      port,
      rejectUnauthorized: !insecureTLS,
      servername: insecureTLS ? undefined : host,
    });
    await new Promise((resolve, reject) => {
      socket.once("secureConnect", resolve);
      socket.once("error", reject);
    });
    const conn = new ImapConn(socket);
    const greeting = await readLogicalLine(conn);
    if (!/^\*\s+(OK|PREAUTH)/i.test(greeting.text)) {
      throw neutral("Connexion à la boîte mail refusée.");
    }
    const tagState = { n: 0 };
    await doLogin(conn, tagState, user, pass);
    const result = await work(conn, tagState);
    await doLogout(conn, tagState);
    return result;
  } catch (e) {
    if (timedOut) throw neutral("Délai dépassé pour la boîte mail.");
    if (e && e.__imapNeutral) throw e;
    const code = e && e.code ? ` (${e.code})` : "";
    throw neutral(`Connexion à la boîte mail impossible${code}.`);
  } finally {
    clearTimeout(timer);
    try { socket && socket.destroy(); } catch {}
  }
}

async function doLogin(conn, tagState, user, pass) {
  const cmd = `LOGIN ${imapQuote(user)} ${imapQuote(pass)}`;
  const res = await runCommand(conn, tagState, cmd);
  if (res.status !== "OK") throw neutral("Authentification à la boîte mail refusée.");
}

async function doLogout(conn, tagState) {
  try { await runCommand(conn, tagState, "LOGOUT"); } catch { /* on ferme la socket de toute façon */ }
}

async function getUidNext(conn, tagState) {
  const sel = await runCommand(conn, tagState, "SELECT INBOX");
  if (sel.status !== "OK") throw neutral("Impossible d'ouvrir la boîte de réception.");
  const fromSelect = [sel.tagged, ...sel.untagged]
    .map(r => /\[UIDNEXT (\d+)\]/i.exec(r.text))
    .find(Boolean);
  if (fromSelect) return parseInt(fromSelect[1], 10);

  const st = await runCommand(conn, tagState, "STATUS INBOX (UIDNEXT)");
  if (st.status === "OK") {
    for (const u of st.untagged) {
      const m = /UIDNEXT (\d+)/i.exec(u.text);
      if (m) return parseInt(m[1], 10);
    }
  }
  throw neutral("Boîte de réception : UIDNEXT introuvable.");
}

async function fetchMessages(conn, tagState, start, { single = false, maxBytes = 20000 } = {}) {
  const cmd = `UID FETCH ${start}${single ? "" : ":*"} (UID INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)] BODY.PEEK[TEXT]<0.${maxBytes}>)`;
  const res = await runCommand(conn, tagState, cmd);
  if (res.status !== "OK") throw neutral("Lecture de la boîte de réception impossible.");
  return res.untagged.filter(u => /\bFETCH\b/.test(u.text));
}

// ---------------------------------------------------------------------------
// Protocole IMAP bas niveau : lecture bufferisée, littéraux {N}, tags.
// ---------------------------------------------------------------------------

class ImapConn {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.ended = false;
    this.err = null;
    this._waiter = null;
    socket.on("data", d => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
      this._check();
    });
    socket.on("error", e => { this.err = e; this._check(); });
    socket.on("close", () => { this.ended = true; this._check(); });
  }

  _check() {
    if (!this._waiter) return;
    const { predicate, resolve, reject } = this._waiter;
    if (this.err) { this._waiter = null; return reject(this.err); }
    if (predicate()) { this._waiter = null; return resolve(); }
    if (this.ended) { this._waiter = null; return reject(new Error("connexion IMAP fermée")); }
  }

  _waitFor(predicate) {
    return new Promise((resolve, reject) => {
      if (this.err) return reject(this.err);
      if (predicate()) return resolve();
      if (this.ended) return reject(new Error("connexion IMAP fermée"));
      this._waiter = { predicate, resolve, reject };
    });
  }

  async readCRLFLine() {
    let idx = -1;
    await this._waitFor(() => { idx = this.buf.indexOf("\r\n"); return idx !== -1; });
    const line = this.buf.subarray(0, idx);
    this.buf = this.buf.subarray(idx + 2);
    return line;
  }

  async readExact(n) {
    if (n <= 0) return Buffer.alloc(0);
    await this._waitFor(() => this.buf.length >= n);
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
}

/**
 * Lit une « réponse logique » IMAP : une ligne qui peut contenir des littéraux `{N}\r\n<N octets>`
 * imbriqués. C'est le point délicat du parseur : un littéral doit être lu en comptant exactement
 * N octets, jamais ligne par ligne (ses N octets peuvent eux-mêmes contenir des \r\n).
 *
 * Les octets sont accumulés dans une chaîne via un décodage latin1, qui est une bijection
 * octet<->caractère (0-255) : on peut donc retrouver les octets d'origine exacts de n'importe
 * quelle portion avec `Buffer.from(sous-chaine, "latin1")`, y compris pour du contenu UTF-8.
 */
async function readLogicalLine(conn) {
  let text = "";
  const literals = [];
  for (;;) {
    const lineBuf = await conn.readCRLFLine();
    const lineStr = lineBuf.toString("latin1");
    text += lineStr;
    const m = /\{(\d+)\+?\}$/.exec(lineStr);
    if (!m) return { text, literals };
    const n = parseInt(m[1], 10);
    const lit = await conn.readExact(n);
    literals.push({ start: text.length, length: n });
    text += lit.toString("latin1");
  }
}

async function readUntilTagged(conn, tag) {
  const untagged = [];
  for (;;) {
    const resp = await readLogicalLine(conn);
    if (resp.text.startsWith(tag + " ")) return { untagged, tagged: resp };
    untagged.push(resp);
  }
}

function nextTag(tagState) {
  tagState.n += 1;
  return "A" + tagState.n;
}

async function runCommand(conn, tagState, commandStr) {
  const tag = nextTag(tagState);
  conn.socket.write(`${tag} ${commandStr}\r\n`);
  const { untagged, tagged } = await readUntilTagged(conn, tag);
  const m = /^\S+\s+(OK|NO|BAD)\b/i.exec(tagged.text);
  const status = m ? m[1].toUpperCase() : "BAD";
  return { untagged, tagged, status };
}

function imapQuote(s) {
  return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

// ---------------------------------------------------------------------------
// Interprétation des réponses FETCH : dates, en-têtes, décodage du corps.
// ---------------------------------------------------------------------------

function literalBuffer(text, lit) {
  return Buffer.from(text.slice(lit.start, lit.start + lit.length), "latin1");
}

function parseFetchResponse(u) {
  const uidMatch = /\bUID (\d+)/.exec(u.text);
  const uid = uidMatch ? parseInt(uidMatch[1], 10) : null;
  const dateMatch = /INTERNALDATE "([^"]+)"/i.exec(u.text);
  const internalDate = dateMatch ? parseInternalDate(dateMatch[1]) : null;

  let headerLit = null;
  let bodyLit = null;
  for (const lit of u.literals) {
    const context = u.text.slice(Math.max(0, lit.start - 150), lit.start);
    if (/HEADER\.FIELDS/i.test(context)) headerLit = lit;
    else if (/TEXT\]/i.test(context)) bodyLit = lit;
  }
  // Repli sur l'ordre attendu si le contexte n'a pas permis d'identifier les littéraux.
  if (!headerLit && u.literals[0]) headerLit = u.literals[0];
  if (!bodyLit && u.literals[1]) bodyLit = u.literals[1];

  const headerText = headerLit ? literalBuffer(u.text, headerLit).toString("utf8") : "";
  const headers = parseHeaderBlock(headerText);
  const dateHeader = headers.date ? new Date(headers.date) : null;

  const receivedAt =
    internalDate && !isNaN(internalDate) ? internalDate :
    dateHeader && !isNaN(dateHeader) ? dateHeader : null;

  const bodyRaw = bodyLit ? literalBuffer(u.text, bodyLit).toString("latin1") : "";
  const bodyDecoded = decodeBody(bodyRaw);
  const strippedBody = stripHtml(bodyDecoded);
  const subjectDisplay = headers.subject || "";
  const fromDisplay = headers.from || "";

  return {
    uid,
    receivedAt,
    fromDisplay,
    subjectDisplay,
    searchText: `${subjectDisplay}\n${strippedBody}`,
  };
}

const MONTHS3 = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };

/** Analyse une INTERNALDATE IMAP, ex. "29-Sep-2026 10:00:00 +0000". */
function parseInternalDate(s) {
  const m = /^(\d{1,2})-(\w{3})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s+([+-]\d{4})$/.exec(String(s).trim());
  if (!m) {
    const d = new Date(s);
    return isNaN(d) ? null : d;
  }
  const [, day, mon, year, hh, mm, ss, tz] = m;
  const monthNum = MONTHS3[mon] || "01";
  const dd = day.padStart(2, "0");
  const tzFmt = `${tz.slice(0, 3)}:${tz.slice(3)}`;
  const d = new Date(`${year}-${monthNum}-${dd}T${hh}:${mm}:${ss}${tzFmt}`);
  return isNaN(d) ? null : d;
}

/** En-têtes HEADER.FIELDS (FROM SUBJECT DATE) : déplie les lignes repliées, décode les valeurs. */
function parseHeaderBlock(raw) {
  const unfolded = raw.replace(/\r\n[ \t]+/g, " ");
  const lines = unfolded.split(/\r\n/).filter(Boolean);
  const out = {};
  for (const line of lines) {
    const m = /^([!-9;-~]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1].toLowerCase();
    if (!(name in out)) out[name] = decodeHeaderValue(m[2].trim());
  }
  return out;
}

/** Découpe un corps multipart en parties (texte des parties, sans les frontières) ; null si ce n'en est pas un. */
function splitMimeParts(text) {
  const lines = text.split(/\r?\n/);
  const counts = new Map();
  for (const l of lines) {
    const m = /^--([!-~]{1,70}?)(--)?\s*$/.exec(l);
    if (m) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  }
  const boundaries = [...counts.entries()].filter(([, n]) => n >= 2).map(([b]) => b);
  if (!boundaries.length) return null;
  const parts = [];
  let cur = null;
  for (const l of lines) {
    const m = /^--([!-~]{1,70}?)(--)?\s*$/.exec(l);
    if (m && boundaries.includes(m[1])) {
      if (cur && cur.length) parts.push(cur.join("\n"));
      cur = m[2] ? null : [];
      continue;
    }
    if (cur) cur.push(l);
  }
  if (cur && cur.length) parts.push(cur.join("\n"));
  return parts.length ? parts : null;
}

/** Décode une partie MIME (en-têtes + corps) d'après Content-Transfer-Encoding et charset ; "" si ce n'est pas du texte. */
function decodeMimePart(part) {
  const sep = part.search(/\r?\n\r?\n/);
  if (sep < 0) return "";
  const headers = parseHeaderBlock(part.slice(0, sep).replace(/\r?\n/g, "\r\n"));
  const body = part.slice(sep).replace(/^\r?\n\r?\n/, "");
  const type = (headers["content-type"] || "text/plain").toLowerCase();
  if (type.startsWith("multipart/")) return "";                   // ses parties sont déjà découpées
  if (!type.startsWith("text/")) return "";
  const cte = (headers["content-transfer-encoding"] || "").toLowerCase().trim();
  const charset = (/charset="?([\w-]+)"?/i.exec(type) || [])[1]?.toLowerCase() || "utf-8";
  const latin = /^(iso-8859-1|iso-8859-15|windows-1252|latin1)$/.test(charset);
  let bytes;
  if (cte === "base64") {
    try { bytes = Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ""), "base64"); } catch { return ""; }
  } else if (cte === "quoted-printable") {
    return decodeQuotedPrintable(body);
  } else {
    bytes = Buffer.from(body, "latin1");
  }
  return bytes.toString(latin ? "latin1" : "utf8");
}

/** Décode les en-têtes encodés RFC 2047 : =?UTF-8?B?...?= / =?UTF-8?Q?...?= (utile au journal). */
function decodeHeaderValue(v) {
  if (!v) return v;
  return v.replace(/=\?[^?]+\?([BbQq])\?([^?]*)\?=/g, (whole, enc, data) => {
    try {
      if (/b/i.test(enc)) {
        return Buffer.from(data, "base64").toString("utf8");
      }
      return decodeQuotedPrintable(data.replace(/_/g, " "));
    } catch {
      return whole;
    }
  });
}

/** =XX et = de fin de ligne ; le résultat est toujours redécodé en UTF-8. */
function decodeQuotedPrintable(str) {
  const noSoftBreaks = str.replace(/=\r\n/g, "").replace(/=\n/g, "").replace(/=$/, "");
  const bytes = [];
  for (let i = 0; i < noSoftBreaks.length; i++) {
    const c = noSoftBreaks[i];
    if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(noSoftBreaks.substr(i + 1, 2))) {
      bytes.push(parseInt(noSoftBreaks.substr(i + 1, 2), 16));
      i += 2;
    } else {
      bytes.push(noSoftBreaks.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * Devine l'encodage du corps sans lire Content-Transfer-Encoding (on ne le récupère pas du
 * serveur) : quoted-printable si des sauts de ligne souples ou plusieurs échappements =XX sont
 * présents ; base64 si chaque ligne n'est faite que de l'alphabet base64 ; sinon texte brut.
 */
function decodeBody(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";

  // Message en plusieurs parties (texte + HTML, chacune avec son propre encodage) : chaque partie
  // est décodée selon ses en-têtes, puis le tout est réuni. Sinon la partie en base64 resterait
  // un bloc illisible où des suites de chiffres apparaissent au hasard.
  const parts = splitMimeParts(trimmed);
  if (parts) return parts.map(decodeMimePart).filter(Boolean).join("\n");

  const qpSoftBreaks = (trimmed.match(/=\r?\n/g) || []).length;
  const qpMarkers = (trimmed.match(/=[0-9A-Fa-f]{2}/g) || []).length;
  if (qpSoftBreaks > 0 || qpMarkers >= 3) {
    return decodeQuotedPrintable(trimmed);
  }

  const lines = trimmed.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length > 0 && lines.every(l => /^[A-Za-z0-9+/]+=*$/.test(l) && l.length >= 4)) {
    try {
      const decoded = Buffer.from(lines.join(""), "base64").toString("utf8");
      if (decoded && /[\x09\x0A\x0D\x20-\x7E]/.test(decoded)) return decoded;
    } catch { /* pas du base64 valide : on garde le texte brut */ }
  }

  // Texte brut (pas de CTE particulier détecté) : `trimmed` est encore la projection latin1
  // des octets d'origine (voir literalBuffer/readLogicalLine) — la reconvertir en UTF-8 réel.
  return Buffer.from(trimmed, "latin1").toString("utf8");
}

function stripHtml(s) {
  return String(s)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/\s+/g, " ")
    .trim();
}

function foldText(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function matchesHints(m, hintsFolded) {
  if (!hintsFolded.length) return true;
  const haystack = foldText(`${m.fromDisplay} ${m.subjectDisplay} ${m.searchText}`);
  return hintsFolded.some(h => haystack.includes(h));
}

// ---------------------------------------------------------------------------
// Extraction du code.
// ---------------------------------------------------------------------------

const EXPLICIT_RE = /code\s*(?:de\s+|d['’])?(?:v[ée]rification|s[ée]curit[ée]|confirmation|validation)|code\s*(?:re[çc]u|envoy[ée])|votre\s+code|code\s+est|verification\s+code|security\s+code|one-time\s+(?:code|password)|\d[- ]digit\s+code|enter\s+(?:the|your)\s+code/gi;

const EXCLUDE_PREFIX_RE = /(?:n°|num[ée]ro|commande|facture|r[ée]f(?:\.|[ée]rence)?)\s*[:#]?\s*$/i;

function isExcludedNumber(text, idx, end, digits) {
  if (digits.length === 4 && /^(19|20)\d{2}$/.test(digits)) return true;
  const before = text[idx - 1] || "";
  const after = text[end] || "";
  if ((before && "€$%".includes(before)) || (after && "€$%".includes(after))) return true;
  if (digits.length === 10 && digits[0] === "0") return true;
  const context = text.slice(Math.max(0, idx - 20), idx).toLowerCase();
  if (EXCLUDE_PREFIX_RE.test(context)) return true;
  return false;
}

/**
 * Cherche le code dans `text` (sujet + corps, HTML déjà retiré) en suivant l'ordre de priorité :
 * 1) un nombre de 4 à 8 chiffres à moins de 60 caractères d'une formule explicite ;
 * 2) à défaut, un groupe isolé de 6 chiffres ;
 * 3) à défaut, un groupe isolé de 4 à 8 chiffres.
 * Écarte les années, les nombres collés à une devise/pourcentage, les numéros de téléphone à 10
 * chiffres commençant par 0, et les nombres précédés de n°/commande/facture/réf.
 */
function extractCode(text) {
  const candidates = [];
  const numRe = /(?<![\dA-Za-z])\d{4,8}(?![\dA-Za-z])/g;   // collé à des lettres = identifiant ou base64, pas un code
  let m;
  while ((m = numRe.exec(text))) {
    const digits = m[0];
    const idx = m.index;
    const end = idx + digits.length;
    if (isExcludedNumber(text, idx, end, digits)) continue;
    candidates.push({ digits, idx, end });
  }
  // Code écrit en groupes (« 123 456 », « 12 34 56 », « 1 2 3 4 5 6 », « 123-456 ») : les groupes sont
  // recollés. Seuls des groupes de même taille (1 à 3 chiffres) sont acceptés — une date ou un numéro
  // de téléphone n'a pas cette forme — et le nombre obtenu suit les mêmes exclusions que les autres.
  const groupRe = /(?<![\d])\d{1,3}(?:[ \u00a0\u202f\-\u2013.]\d{1,3}){1,7}(?![\d])/g;
  while ((m = groupRe.exec(text))) {
    const parts = m[0].split(/[^\d]/);
    if (new Set(parts.map(x => x.length)).size !== 1) continue;
    const digits = parts.join("");
    if (digits.length < 4 || digits.length > 8) continue;
    const idx = m.index;
    const end = idx + m[0].length;
    if (/[ \u00a0\u202f\-\u2013.]\d/.test(text.slice(end, end + 2))) continue;   // morceau d'une suite plus longue (date, téléphone)
    if (isExcludedNumber(text, idx, end, digits)) continue;
    if (candidates.some(c => c.idx < end && idx < c.end)) continue;
    candidates.push({ digits, idx, end });
  }
  candidates.sort((a, b) => a.idx - b.idx);
  if (!candidates.length) return null;

  const phrases = [];
  EXPLICIT_RE.lastIndex = 0;
  let pm;
  while ((pm = EXPLICIT_RE.exec(text))) {
    phrases.push({ idx: pm.index, end: pm.index + pm[0].length });
  }

  if (phrases.length) {
    // Près d'une phrase « votre code est… » : un nombre de six chiffres l'emporte sur un plus court
    // (année, numéro de réservation), même un peu plus loin — à distance égale, le plus proche.
    let best = null;
    let bestScore = Infinity;
    for (const c of candidates) {
      for (const p of phrases) {
        const dist = c.idx >= p.end ? c.idx - p.end : p.idx >= c.end ? p.idx - c.end : 0;
        if (dist > 60) continue;
        const score = (c.digits.length === 6 ? 0 : 1000) + dist;
        if (score < bestScore) { bestScore = score; best = c; }
      }
    }
    if (best) return best.digits;
  }

  const six = candidates.find(c => c.digits.length === 6);
  if (six) return six.digits;

  return candidates[0].digits;
}
