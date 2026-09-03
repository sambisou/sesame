# Security

> 🇫🇷 [Version française](SECURITY.fr.md)

Sésame handles credentials. Here is what it guarantees, what it does not, and how to report a problem.

## What Sésame does

- Credentials are stored **only in the macOS Keychain** (service `sesame`, one item per site), encrypted by the system. Sésame keeps no copy: no file, no cache, no log.
- The MCP server **exposes no tool that returns a secret**. The only possible answers are "done", "refused", "failed", the list of sites (names, domains, policies) and the journal.
- Field values never appear in error messages; they are truncated and sanitized.
- By default, **every access is approved through a dialog** on the Mac (`ask` policy). A global kill switch (`sesame lock`) blocks everything.
- The journal (`~/.sesame/journal.jsonl`) is append-only: the MCP server has no tool to erase it.
- Form filling happens in **a Chrome with a dedicated profile**, driven locally (DevTools port 9222 on 127.0.0.1). Nothing goes through a third-party server.
- The optional HTTP transport (`sesame serve`) listens on 127.0.0.1 only and requires a local random token; requests without it are refused and logged.

## Keychain items have no trusted application

Since 0.3.0, Sésame creates its Keychain items with **no trusted application**. Reading a password, by Sésame or by any other process on your Mac, therefore triggers the system Keychain dialog. Answer **Allow** each time. Never click **Always Allow**: it would register `/usr/bin/security` as trusted and make every future read silent, for any local process. Sites registered before 0.3.0 still carry a trusted application: `sesame doctor` flags them, re-register them once with `sesame add <site>` or through the Sésame window.

## The Chrome extension channel (beta)

The optional Chrome extension moves the secret's last hop. Instead of Sésame typing into a Chrome it drives directly (dedicated profile, DevTools port 9222), the secret now travels **Sésame → local bridge process → extension → page**, inside your **regular, everyday Chrome**. The bridge and the extension talk over Chrome's native-messaging channel, not the network; the secret still comes only from the macOS Keychain and is still never returned to Claude — the extension sends back only steps, a URL, and an ok/refused/failed result, never the values.

What actually changes: the page now runs in your normal browsing profile, alongside whatever else you have installed there. **Any other extension with access to that page's DOM (most extensions with broad host permissions) can, in principle, observe what gets typed**, the same way it could observe you typing it yourself. The dedicated Chrome profile does not have this exposure, because nothing else is installed in it. Use the dedicated Chrome if you want that page kept isolated; use the extension if staying in your everyday browser matters more. Both paths keep the same guarantee that no secret is ever handed to the AI model.

**What protects this channel (0.5.0):**

- *Chrome side.* The native-messaging manifest lists a single `allowed_origins` (your extension's ID); the extension has no `externally_connectable` entry, so no web page or other extension can message it; its content script only answers messages from its own service worker (`sender.id` checked) and never reads back a field's value; nothing is stored (the `storage` permission holds the popup's connection status and, for an *unpacked* build only, the test bench's bridge name — a packaged build ignores that key).
- *Peer authentication, not from the argv.* The Unix socket is **not** an access control: any process in your session can create it before the bridge does and answer the ping. So before sending a secret, Sésame authenticates the peer on the pid the pong announces, using only facts the operating system reports about *that pid* — never `process.title` or the command line a process chooses for itself (`ps -o command=`), which any process can set to anything, including a full fake "`node /path/to/bin/sesame-bridge.js`" line:
  1. `~/.sesame/bridge.sock` is a socket, owned by you, mode 0600 (checked again after the rest, in case it was swapped mid-check);
  2. `lsof` confirms this pid actually holds the socket (an impostor cannot claim the real bridge's pid: that one, waiting its turn, holds no socket at all);
  3. `lsof -p <pid> -Ffn`, filtered to the `txt` entry — the binary actually mapped into that pid, not a file it merely opened, and not spoofable by the process — shows a program named `node`;
  4. the **parent** of that pid (`ps -o ppid=`, then the same `lsof` "txt" check on the *parent's* pid — equally unspoofable) must be a Chromium browser under `/Applications/(Google Chrome|Google Chrome Canary|Chromium|Brave Browser|Arc).app/Contents/MacOS/`: it is Chrome, never the AI or an arbitrary script, that is supposed to start this bridge;
  5. the pong's new `script` field (an absolute path, self-reported) must name a file whose SHA-256 hash matches `bin/sesame-bridge.js` of this repository, and whose real path is that repository file itself. **This step is a consistency check, not a boundary**: the path is declared by the peer, and no socket-level check can tie a Node process to the script it is actually running. What really stops an impostor is step 4 — it must have been launched by a Chromium browser, i.e. through the native-messaging manifest and launcher — and those two files live in your own account, see "what remains true".
  Steps 4 and 5 both relax only under `SESAME_TEST=1` in **this process's own environment** — never taken from anything the peer says — for the test bench (`test/bridge.mjs`, `test/extension-live.mjs`): step 4 also accepts a `node` parent (no Chrome in the test), and step 5 also accepts a script anywhere under `~/.sesame` (the bench stages a copy there); the hash check is never relaxed. Failing any step is refused as "bridge not authenticated" — no fallback, nothing sent, logged as refused. The bridge itself starts with `umask 077`, refuses to run if `~/.sesame` is not a 0700 directory you own, and refuses a pre-existing path that is not a socket or not yours; a second bridge yields to one that is already active (it does not "refuse to start": it waits).
- *One connection for the whole exchange.* The ping, the pid authentication above, the `prepare`, and the `fill` all happen on **the same** already-open socket connection — the bridge accepts any number of commands on one connection, so nothing needs reopening between steps. This closes a gap the previous design had: authenticating on one connection and then opening a *second* one for the actual `fill` would let whoever grabs the socket path in between receive that second connection and get re-authenticated in its own right. With a single connection, replacing the path afterward changes nothing (the already-connected file descriptor still talks to the real bridge); and if that real bridge dies in between, the `fill` fails outright on the dead connection — Sésame never silently reconnects to whoever now answers on the path.
- *Two-step protocol.* The secret is not read from the Keychain, and not sent, until the extension has found (or opened) a tab of the site, over **https** (http is accepted only for 127.0.0.1/localhost), and seen a login form there. That first step returns a job id valid for 60 seconds, for that tab only; the `fill` step must carry it, and it is consumed once. A `fill` without a valid job id is refused without touching any page.
- *Domain and scheme checked at the last moment.* The tab's URL is re-checked before each keystroke, and the content script checks its own frame (main frame included: https + host equal to the site or a sub-domain) before acting. A message carrying a secret is never re-injected after a navigation; if the page moves to another host between the username and the password, the fill is abandoned and the password is never typed. Login URLs that are not https are refused by the bridge and by the extension.
- *No fallback after sending.* If the extension stops answering **before** the secret was sent, Sésame may fall back to the dedicated Chrome (`auto` mode) and says so. If it stops answering **after**, it does not: the answer says the form may have been submitted, the journal records *uncertain*, and the credentials are never typed a second time elsewhere.
- *Nothing sensitive in error messages.* URLs in any error, hint or step are reduced to origin + path (no OAuth code, no magic-link token) before reaching the journal or the model.
- The bridge logs nothing containing a secret and does not survive Chrome closing.

**What remains true — stated plainly:**

- **A program running under your macOS session can send its own `prepare`/`fill` commands to the real, legitimate bridge, exactly as Sésame does.** Peer authentication establishes that the process on the other end of the socket really is `bin/sesame-bridge.js`, launched by a real Chrome, unmodified — it does not, and cannot, restrict who on your Mac is allowed to *talk* to that real bridge once it is up. Any process running as you can open the same socket, ask the extension to fill a form, and (if you approve the resulting Chrome prompt, when one appears) have it typed. This is not a bug to be patched by more checks on the socket: a Unix-domain socket writable by your user is inherently reachable by every process running as you.
- A program running under your session can also replace `bin/sesame-bridge.sh`, or rewrite the native-messaging manifest and the `~/.sesame/node-path` file: they are ordinary files of your account, and Chrome executes the launcher without verifying it. Keep the repository out of shared folders and writable by you only (`sesame install extension` sets the launcher to 0755 and the manifest to 0600, and writes the manifest for the one browser you name).
- Another extension with access to the page's DOM can observe what gets typed (see above).
- **Sésame does not protect against a compromised Mac, or against another program running in your own session — it protects the same perimeter the macOS Keychain itself protects, no more.** Whoever controls your session controls the Keychain, the bridge, and Chrome; peer authentication raises the bar for a *remote* or *sandboxed* attacker who cannot spawn arbitrary processes as you, but it is not a boundary between two ordinary programs both running as your user.

## What Sésame does not do

- **An agent that runs JavaScript in the Sésame Chrome can observe what Sésame types.** The Claude in Chrome extension, when installed in that profile, gives the model such access. The guarantee "no tool returns a secret" covers Sésame's MCP tools, not the browser DOM. Sésame mitigates this (always submits, clears the field if the login fails, never leaves an unsent form) but cannot prevent a page-level observer. Install Claude in Chrome in the Sésame profile only if you accept this.

- It does not solve captchas and does not bypass the second factor: the SMS, e-mail or app code is typed by the person, Sésame waits.
- It does not protect against an already compromised Mac: whoever controls your macOS session also controls the Keychain and the Sésame Chrome.
- DevTools port 9222 is open locally on the dedicated Chrome profile: any local process can drive that Chrome. Do not open sessions there that you would not entrust to Sésame.
- If you expose `sesame serve` through a tunnel (for a remote client such as ChatGPT), anyone who knows the URL and token can request logins. They will still be gated by your dialog and logged, and no secret is ever returned, but this is an entry point you chose to open. Rotate the token with `sesame token --rotate`.
- The AI model that calls Sésame remains third-party software: it may request unnecessary logins. The `ask` policy and the journal exist for that.
- Form detection is heuristic: an unusual site may fail or fill the wrong field. Check the journal and the Sésame Chrome when in doubt.

## This software is provided "as is"

Sésame is a personal, free project released under the MIT license, **without warranty of any kind** and without any support commitment. You use it at your own risk, for your own accounts, in compliance with the terms of service of the sites involved. The author cannot be held liable for loss of access, credential leakage or any damage related to its use.

## Reporting a vulnerability

Do not open a public issue for an exploitable flaw. Use the repository's **Security → Report a vulnerability** tab (private report). Describe the scenario, the version and, if possible, a reproduction. A reply is aimed for within 14 days, with no guaranteed fix timeline.

## Good practices for users

- Keep the `ask` policy for any sensitive site (bank, taxes, e-mail).
- Set a site you no longer use to `revoked`; `sesame remove` also deletes the secret from the Keychain.
- Only run `sesame chrome` when you need it; close it afterwards.
- Read `sesame log` from time to time.
