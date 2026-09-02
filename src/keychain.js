// Stockage des secrets dans le Trousseau macOS via l'outil système `security`.
// Aucun secret n'est jamais écrit sur disque en clair par Sésame.
import { execFileSync } from "node:child_process";
import { KEYCHAIN_SERVICE } from "./config.js";

function sec(args, input) {
  return execFileSync("/usr/bin/security", args, {
    input,
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf8",
  });
}

export function keychainAvailable() {
  return process.platform === "darwin";
}

/** Enregistre { username, password } pour un site (remplace s'il existe). */
export function setSecret(siteKey, { username, password }) {
  const payload = JSON.stringify({ username, password });
  // -U : update if exists. Le secret est passé via -w ; il n'apparaît pas dans les logs de Sésame.
  sec(["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", siteKey,
       "-l", `Sésame — ${siteKey}`, "-D", "Identifiants Sésame (Claude)", "-w", payload]);
}

/** Lit le secret. Renvoie { username, password } ou lève une erreur si absent. */
export function getSecret(siteKey) {
  let out;
  try {
    out = sec(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", siteKey, "-w"]);
  } catch {
    throw new Error(`Aucun identifiant dans le Trousseau pour « ${siteKey} » (ajoute-le avec : sesame add ${siteKey})`);
  }
  try {
    const obj = JSON.parse(out.trim());
    if (typeof obj.password !== "string") throw new Error();
    return { username: obj.username ?? "", password: obj.password };
  } catch {
    throw new Error(`Secret du Trousseau illisible pour « ${siteKey} »`);
  }
}

export function deleteSecret(siteKey) {
  try {
    sec(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", siteKey]);
    return true;
  } catch {
    return false;
  }
}

export function hasSecret(siteKey) {
  try {
    sec(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", siteKey]);
    return true;
  } catch {
    return false;
  }
}
