// Test du client IMAP minimal : faux serveur IMAP local (TLS auto-signé), aucun réseau externe,
// aucune interaction. N'ouvre jamais ~/.sesame et ne se connecte à aucune vraie boîte mail.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

setTimeout(() => { console.error("⏱ délai global dépassé"); process.exit(2); }, 40000).unref();

const { findLoginCode, checkMailbox } = await import("../src/imap.js");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "sesame-imap-test-"));
const KEY = path.join(TMP, "key.pem");
const CERT = path.join(TMP, "cert.pem");
execFileSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-keyout", KEY, "-out", CERT,
  "-days", "1", "-nodes", "-subj", "/CN=127.0.0.1",
], { stdio: ["ignore", "ignore", "ignore"] });

const USER = "test@example.test";
const PASS = "un-mot-de-passe-tres-secret-123";

// ---------------------------------------------------------------------------
// Fabrication des messages : dates récentes vs trop anciennes, plusieurs encodages.
// ---------------------------------------------------------------------------

const NOW = new Date();
const RECENT = new Date(NOW.getTime() - 60_000);        // il y a 1 minute
const OLD = new Date(Date.UTC(2020, 0, 1, 0, 0, 0));     // largement trop ancien

function imapDate(d) {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mon = months[d.getUTCMonth()];
  return `${dd}-${mon}-${d.getUTCFullYear()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")} +0000`;
}

function wrapBase64(b64) {
  return (b64.match(/.{1,76}/g) || [b64]).join("\r\n");
}

function msg({ uid, date, from, subject, body }) {
  return {
    uid,
    internalDate: imapDate(date),
    headerText: `From: ${from}\r\nSubject: ${subject}\r\nDate: ${date.toUTCString()}\r\n`,
    bodyText: body,
  };
}

const MESSAGES = [
  // 1: trop ancien -> doit être ignoré malgré un hint qui correspond.
  msg({
    uid: 1, date: OLD,
    from: "Booking.com <noreply@booking.com>",
    subject: "Code de connexion",
    body: "Bonjour,\r\nVotre code de vérification est 999999. Ne le partagez avec personne.\r\n",
  }),
  // 2: autre site -> ne doit jamais être choisi pour les hints "booking".
  msg({
    uid: 2, date: RECENT,
    from: "Assistance <noreply@othersite.test>",
    subject: "Votre code de vérification est prêt",
    body: "Bonjour,\r\nVotre code de vérification est 111222. Merci.\r\n",
  }),
  // 3: le bon message, texte brut.
  msg({
    uid: 3, date: RECENT,
    from: "Booking.com <noreply@booking.com>",
    subject: "Code de connexion",
    body: "Bonjour,\r\nVotre code de vérification est 123456. Ne le partagez avec personne.\r\n",
  }),
  // 4: quoted-printable, avec un saut de ligne souple et un caractère accentué échappé.
  msg({
    uid: 4, date: RECENT,
    from: "Booking.com <noreply@booking.com>",
    subject: "Code qpsite",
    body: "Bonj=\r\nour,\r\nVotre code de v=C3=A9rification est 234567. Merci.\r\n",
  }),
  // 5: base64, replié sur plusieurs lignes.
  msg({
    uid: 5, date: RECENT,
    from: "Booking.com <noreply@booking.com>",
    subject: "Code b64site",
    body: wrapBase64(Buffer.from("Bonjour,\r\nVotre code de securite est 345678. Merci.\r\n", "utf8").toString("base64")),
  }),
  // 6: HTML, avec balises à retirer avant recherche du code.
  msg({
    uid: 6, date: RECENT,
    from: "Booking.com <noreply@booking.com>",
    subject: "Code htmlsite",
    body: "<html><body><p>Bonjour,</p><p>Your verification code is <b>456789</b>.</p></body></html>",
  }),
  // 7: faux positif "facture" -> aucun code ne doit être trouvé.
  msg({
    uid: 7, date: RECENT,
    from: "Booking.com <noreply@booking.com>",
    subject: "Confirmation de commande facturesite",
    body: "Merci pour votre commande n°456123. Aucun code ici. Montant réglé : 129€.\r\n",
  }),
];

const UIDNEXT = Math.max(...MESSAGES.map(m => m.uid)) + 1;

// ---------------------------------------------------------------------------
// Faux serveur IMAP : LOGIN / SELECT (sans UIDNEXT, pour forcer le repli sur STATUS) /
// STATUS INBOX (UIDNEXT) / UID FETCH avec BODY.PEEK / LOGOUT. Ne journalise jamais le mot de passe.
// ---------------------------------------------------------------------------

function frame(...parts) {
  return Buffer.concat(parts.map(p => (Buffer.isBuffer(p) ? p : Buffer.from(String(p), "utf8"))));
}

function buildFetchLine(seq, m) {
  const headerBuf = Buffer.from(m.headerText, "utf8");
  const bodyBuf = Buffer.from(m.bodyText, "utf8");
  return frame(
    `* ${seq} FETCH (UID ${m.uid} INTERNALDATE "${m.internalDate}" BODY[HEADER.FIELDS (FROM SUBJECT DATE)] {${headerBuf.length}}\r\n`,
    headerBuf,
    ` BODY[TEXT]<0> {${bodyBuf.length}}\r\n`,
    bodyBuf,
    `)\r\n`,
  );
}

function startFakeServer() {
  const server = tls.createServer({ key: fs.readFileSync(KEY), cert: fs.readFileSync(CERT) }, socket => {
    let authed = false;
    let buf = "";
    socket.write("* OK fake imap ready\r\n");
    socket.on("data", d => {
      buf += d.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\r\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        handleLine(line);
      }
    });

    function handleLine(line) {
      const sp = line.indexOf(" ");
      if (sp === -1) return;
      const tag = line.slice(0, sp);
      const rest = line.slice(sp + 1);

      const loginMatch = /^LOGIN\s+"((?:[^"\\]|\\.)*)"\s+"((?:[^"\\]|\\.)*)"$/i.exec(rest);
      if (loginMatch) {
        const unq = s => s.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
        const u = unq(loginMatch[1]);
        const p = unq(loginMatch[2]);
        if (u === USER && p === PASS) {
          authed = true;
          socket.write(`${tag} OK LOGIN completed\r\n`);
        } else {
          // Ne JAMAIS renvoyer le mot de passe reçu dans la réponse d'erreur.
          socket.write(`${tag} NO LOGIN failed\r\n`);
        }
        return;
      }

      if (/^SELECT INBOX$/i.test(rest)) {
        if (!authed) { socket.write(`${tag} NO not authenticated\r\n`); return; }
        socket.write(`* ${MESSAGES.length} EXISTS\r\n`);
        socket.write(`* 0 RECENT\r\n`);
        socket.write(`* OK [UIDVALIDITY 1] UIDs valid\r\n`);
        // Volontairement SANS [UIDNEXT] : force le client à se rabattre sur STATUS.
        socket.write(`${tag} OK [READ-WRITE] SELECT completed\r\n`);
        return;
      }

      if (/^STATUS INBOX \(UIDNEXT\)$/i.test(rest)) {
        if (!authed) { socket.write(`${tag} NO not authenticated\r\n`); return; }
        socket.write(`* STATUS INBOX (UIDNEXT ${UIDNEXT})\r\n`);
        socket.write(`${tag} OK STATUS completed\r\n`);
        return;
      }

      const fetchMatch = /^UID FETCH (\d+):\*/i.exec(rest);
      if (fetchMatch) {
        if (!authed) { socket.write(`${tag} NO not authenticated\r\n`); return; }
        const start = parseInt(fetchMatch[1], 10);
        let seq = 0;
        for (const m of MESSAGES) {
          if (m.uid < start) continue;
          seq += 1;
          socket.write(buildFetchLine(seq, m));
        }
        socket.write(`${tag} OK UID FETCH completed\r\n`);
        return;
      }

      if (/^LOGOUT$/i.test(rest)) {
        socket.write(`* BYE logging out\r\n`);
        socket.write(`${tag} OK LOGOUT completed\r\n`);
        socket.end();
        return;
      }

      socket.write(`${tag} BAD unknown command\r\n`);
    }
  });
  return server;
}

const server = startFakeServer();
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const PORT = server.address().port;

const base = { host: "127.0.0.1", port: PORT, user: USER, pass: PASS, insecureTLS: true, timeoutMs: 8000 };

let failed = null;
try {
  // 1+2+3 : le bon message est trouvé, le message trop ancien et celui d'un autre site sont ignorés.
  {
    const r = await findLoginCode({ ...base, since: NOW, hints: ["booking.com", "booking"] });
    assert.ok(r, "un code aurait dû être trouvé");
    assert.equal(r.code, "123456", "doit trouver le code du message récent, pas celui du message ancien (999999)");
    assert.notEqual(r.code, "999999");
    assert.equal(r.from, "Booking.com <noreply@booking.com>");
    console.log("  1 texte brut : code trouvé, message trop ancien et autre site ignorés");
  }

  // Le message "autre site" est bien lisible pour SES propres hints (le mécanisme marche en général).
  {
    const r = await findLoginCode({ ...base, since: NOW, hints: ["othersite"] });
    assert.ok(r);
    assert.equal(r.code, "111222");
    console.log("  2 message d'un autre site : trouvé avec ses propres hints, prouvant que ce n'est pas un bug de parsing");
  }

  // 4 : quoted-printable.
  {
    const r = await findLoginCode({ ...base, since: NOW, hints: ["qpsite"] });
    assert.ok(r, "quoted-printable : aucun code trouvé");
    assert.equal(r.code, "234567");
    console.log("  3 quoted-printable : code trouvé (saut de ligne souple + accent échappé décodés)");
  }

  // 5 : base64.
  {
    const r = await findLoginCode({ ...base, since: NOW, hints: ["b64site"] });
    assert.ok(r, "base64 : aucun code trouvé");
    assert.equal(r.code, "345678");
    console.log("  4 base64 (replié sur plusieurs lignes) : code trouvé");
  }

  // 6 : HTML.
  {
    const r = await findLoginCode({ ...base, since: NOW, hints: ["htmlsite"] });
    assert.ok(r, "HTML : aucun code trouvé");
    assert.equal(r.code, "456789");
    console.log("  5 HTML : balises retirées, code trouvé");
  }

  // 7 : faux positif facture -> null.
  {
    const r = await findLoginCode({ ...base, since: NOW, hints: ["facturesite"] });
    assert.equal(r, null, "un numéro de commande/facture à 6 chiffres ne doit jamais être pris pour un code");
    console.log("  6 numéro de commande/facture à 6 chiffres : correctement écarté (null)");
  }

  // Aucun hint ne correspond -> null.
  {
    const r = await findLoginCode({ ...base, since: NOW, hints: ["site-totalement-inconnu-xyz"] });
    assert.equal(r, null);
    console.log("  7 aucun message ne correspond aux hints : null");
  }

  // checkMailbox : succès avec les bons identifiants.
  {
    const r = await checkMailbox(base);
    assert.deepEqual(r, { ok: true });
    console.log("  8 checkMailbox avec les bons identifiants : ok:true");
  }

  // Mauvais mot de passe : erreur neutre, qui ne contient JAMAIS le mot de passe (ni le bon, ni le mauvais).
  {
    const badPass = "mauvais-mot-de-passe-ne-doit-jamais-apparaitre";
    let threw = null;
    try {
      await findLoginCode({ ...base, pass: badPass, since: NOW, hints: ["booking"] });
    } catch (e) {
      threw = e;
    }
    assert.ok(threw, "un mot de passe invalide doit lever une erreur");
    assert.doesNotMatch(threw.message, new RegExp(badPass.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(threw.message, new RegExp(PASS.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    console.log("  9 mauvais mot de passe : erreur levée sans jamais contenir le mot de passe");

    const r = await checkMailbox({ ...base, pass: badPass });
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.message, new RegExp(badPass.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    console.log(" 10 checkMailbox avec mauvais mot de passe : ok:false, message neutre sans le mot de passe");
  }

  // insecureTLS refusé pour un hôte qui n'est pas 127.0.0.1 (pas de connexion réseau réelle tentée).
  {
    let threw = null;
    try {
      await findLoginCode({ host: "imap.example.test", port: PORT, user: USER, pass: PASS, insecureTLS: true, since: NOW, hints: ["x"], timeoutMs: 500 });
    } catch (e) {
      threw = e;
    }
    assert.ok(threw, "insecureTLS doit être refusé hors 127.0.0.1");
    console.log(" 11 option de test insecureTLS refusée pour un hôte distant");
  }
} catch (e) {
  failed = e;
} finally {
  await new Promise(resolve => { try { server.close(resolve); } catch { resolve(); } });
  fs.rmSync(TMP, { recursive: true, force: true });
}

if (failed) {
  console.error("❌ imap :", failed.message);
  process.exit(1);
}
console.log("✅ imap OK — brut, quoted-printable, base64, HTML, faux positif facture, hints, dates, erreurs neutres");
