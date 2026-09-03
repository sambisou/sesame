# Sésame — a local credential vault for Claude

> 🇫🇷 [Version française](README.fr.md) · Website: [sesamekey.app](https://sesamekey.app) · License: [MIT](LICENSE) · [Security & reporting](SECURITY.md)
>
> **Personal prototype, provided as is, without warranty or support.** Sésame handles your credentials: read [SECURITY.md](SECURITY.md) before installing, use it only for your own accounts, at your own risk.

Sésame lets Claude (Cowork, Claude Code, Claude Desktop) **log in to your web accounts without ever knowing your credentials**.

The idea: Claude never asks *"give me your EDF password"*. It asks Sésame *"fill in the EDF login form in the Chrome tab"*. Sésame reads the secret from the **macOS Keychain**, types it into the page itself, and returns only *"done / refused / failed"* to Claude. Every request is **logged**, and by default **you approve each access** through a dialog on your Mac.

```
   Claude (Cowork / Code)            Sésame (local MCP server)              "Sésame" Chrome
 ─────────────────────────         ──────────────────────────────         ────────────────────
 sesame_login("edf",        ──►    site policy? (ask / always / revoked)
   reason="August invoice")        global Block?
                                   ├─ ask → macOS dialog ──────────────► you: Allow / Refuse
                                   ├─ macOS Keychain → username + password
                                   ├─ finds the edf.fr tab (or opens it) ──►  types the fields, submits
                                   └─ journal.jsonl: who, when, what, result
 ◄── { ok: true, steps: [...] }    (never the values)
```

## What Claude can and cannot do

| MCP tool | What it does | What it returns |
|---|---|---|
| `sesame_list_sites` | lists known sites | names, domains, policies — **no secret** |
| `sesame_login` | fills in (and submits) the login form in Chrome, waits for a second-factor code if the site asks for one | `ok / refused / failed` + steps + URL |
| `sesame_wait_code` | resumes waiting for a second-factor code you type yourself | `ok / failed` |
| `sesame_request_site` | when a site is not registered yet: opens Sésame windows on the Mac so **you** type the username and password (straight to the Keychain) | `registered / refused / already known` — never the values |
| `sesame_open_login` | opens a site's login page | URL |
| `sesame_journal` | reads the access log | events |

There is **no tool** that returns a username or a password. Secrets never leave the Sésame ↔ Keychain ↔ Chrome path, all on your Mac. Error messages are truncated and never contain a field value.

## Install (5 minutes, macOS)

Requirements: macOS 13 or later, Node.js 20 or later (`brew install node` or [nodejs.org](https://nodejs.org)), Google Chrome, Claude Desktop and/or Claude Code.

**Easiest:** download [`sesame-macos.zip`](https://github.com/sambisou/sesame/releases/latest/download/sesame-macos.zip), unzip it, then double-click **`Install Sesame.command`**. The first time, macOS may refuse to open it: right-click → *Open*.

**Or from a terminal:**

```bash
unzip sesame-macos.zip && cd sesame
bash install.sh
```

`install.sh` installs the dependencies, makes the `sesame` command available, and registers the MCP server in Claude Code (`claude mcp add`) and Claude Desktop (`claude_desktop_config.json`, a `.bak-*` backup is kept). Restart Claude Desktop afterwards.

### The "Sésame" Chrome

Since Chrome 136, Chrome refuses remote control of the default profile. Sésame therefore launches **a Chrome with its own profile** (`~/.sesame/chrome-profile`) and DevTools port 9222:

```bash
sesame chrome
```

In that Chrome, the **first time**: install the **Claude in Chrome** extension and connect it to Claude Desktop as usual. *This* is the Chrome where Claude browses and where Sésame fills in credentials. Sessions (cookies) persist there: once logged in to EDF, you stay logged in until expiry, without another call to Sésame.

> Tip: to launch it at login, wrap `sesame chrome` in an Automator "Application" and add it under *System Settings → General → Login Items*.

### Chrome extension (beta)

An alternative to the dedicated Chrome above: a **browser extension** that runs in your **regular** Chrome — no second browser, no DevTools port. Sésame reaches it through a small local bridge process, over Chrome's own native-messaging channel (not the network).

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `extension/` folder of this repo.
4. Copy the ID shown under the extension's name (32 letters).
5. Run:
   ```bash
   sesame install extension --id <that-id>
   ```
   This writes the native-messaging manifest (mode 0600) for Chrome only. Using Brave, Arc, Chromium or Chrome Canary instead? Add `--browser brave|arc|chromium|canary`: the manifest is written for that one browser, never for browsers where the extension isn't loaded.
6. Reload the extension (the ↻ button on its card), open its popup, and click **Test the connection**.

If the popup says *Native host has exited* right after that, and this folder lives in `~/Downloads`, `~/Documents` or `~/Desktop`, macOS is probably refusing to let Chrome run `bin/sesame-bridge.sh` from there (a process started by Chrome has Chrome's file permissions): allow Chrome for that folder in *System Settings → Privacy & Security → Files and Folders*, or move the repo elsewhere (e.g. `~/sesame`) and run step 5 again. Chrome reads the manifest from its own data folder (`~/Library/Application Support/Google/Chrome/NativeMessagingHosts` for the regular profile), which is where step 5 writes it.

`sesame doctor` reports its status: manifest present, bridge reachable, extension connected. When all three are green, `sesame_login` and `sesame_wait_code` use the extension automatically instead of the dedicated Chrome — you keep browsing normally. Force one or the other with `SESAME_BROWSER=chrome-profile` or `SESAME_BROWSER=extension` (default `auto`).

A login through the extension happens in two steps: Sésame first asks the extension to find (or open) the site's tab and check that a login form is visible; only then does it read the Keychain and send the credentials, for that tab, within 60 seconds. The access dialog names where the credentials will be typed ("your regular Chrome (Sésame extension)" or "the Sésame Chrome"). If the extension fails **before** the credentials were sent (bridge gone, Chrome closed during the first step), Sésame falls back to the dedicated Chrome in `auto` mode and says so in `steps`. If it stops answering **after** they were sent, there is **no fallback**: the answer says "the extension did not respond; the form may have been submitted — check the tab", and the journal records the attempt as *uncertain*. Credentials are never typed twice in two browsers.

**Honest limitation:** the extension fills the form inside your everyday Chrome, where you may have other extensions installed. Any extension with access to that page's DOM can, in principle, observe what gets typed there — the same way it could observe you typing it yourself. The dedicated Chrome above doesn't have this exposure, because nothing else is installed in that profile. Pick whichever trade-off suits you; see [SECURITY.md](SECURITY.md) for the details.

## The menu bar app

`Install Sesame.command` also installs **Sésame.app** in the menu bar (a small seed icon). Everything can be done from there, without a terminal:

- see every registered site and change its rule with one click: **Me demander** (ask), **Automatique**, **Coupé** (revoked);
- add a site: one window with username, password and an eye button to reveal it; the secret goes straight to the Keychain;
- delete a site (and its secret), flip the global **Block**, open the Sésame Chrome, read the last journal lines.

When Claude needs a site that is not registered yet, the app opens that same window for you (`sesame_request_site`). If the app is not running, Sésame falls back to macOS dialogs.

Build it yourself: `cd macos && ./scripts/make-app.sh release` (Swift 6, macOS 14+), the bundle lands in `macos/build/Sésame.app`.

## Register a site

```bash
sesame add edf --url https://particulier.edf.fr/fr/accueil/connexion.html
```

Sésame asks for the username and password **at the keyboard, hidden** — the only place they are ever typed. They go to the macOS Keychain (service `sesame`, account `edf`); `~/.sesame/sites.json` only holds the URL, domain and policy.

Useful options:

| Option | Role |
|---|---|
| `--policy ask` (default) | you approve every login through a dialog |
| `--policy always` | automatic login, no dialog (still logged) |
| `--user-sel '#email'` | CSS selector of the username field, if auto-detection fails |
| `--pass-sel '#pwd'` | same for the password field |
| `--submit-sel 'button.login'` | same for the submit button |
| `--code-sel '#otp'` | same for the second-factor code field |
| `--note "work account"` | memo shown by `sesame list` |

Running `sesame add edf` again on an existing site updates the secret (password change).

**No terminal needed:** when Claude needs a site that is not registered yet, it calls `sesame_request_site`. Sésame opens three small windows on your Mac (confirm, username, password), stores everything in the Keychain, and Claude only learns that the site is now available.

## Control access, site by site

```bash
sesame list                       # status of all sites
sesame policy edf always          # no more dialog for EDF
sesame policy edf ask             # back to manual approval
sesame revoke edf                 # cut access (the secret stays in the Keychain)
sesame remove edf                 # delete site + secret
sesame lock / sesame unlock       # global kill switch, all sites
```

## The journal

```bash
sesame log                        # last 30 lines
sesame log --site edf -n 100
```

Each line of `~/.sesame/journal.jsonl` records: timestamp, site, action (`login`, `2fa`, `open_login`, `policy`, `lock`…), caller (`cowork`, `claude-code`, `cli`, `http`…), result (`authorized`, `refused`, `succeeded`, `failed`, `error` — in French in the file) and a readable detail. Claude can read it through `sesame_journal` to report back to you, but cannot erase it.

## The window you will see at every login

Sésame's first principle is to automate: for a site set to **Automatique**, nothing is shown, the login just happens. So there is only **one** window to know about, and it only appears for a site set to **Me demander** (ask):

1. **Sésame — demande d'accès.** Who is asking (Cowork, Claude Code…), which site, and why. *Refuser* is the default; click **Autoriser** to let Sésame fill the form.

The macOS Keychain no longer asks at every login since 0.5.0: Sésame reads the password through its signed **Keychain assistant** (`sesame-keychain`, shipped inside Sésame.app), and that assistant is declared trusted the moment the site is created (`sesame add` or the Sésame window) — every read after that is silent, no dialog at all. The one exception is a site registered before 0.5.0 (or before 0.3.0): for that one, the Keychain will still show its dialog — but only once, not at every login — and the right answer is now **Always Allow**, because the requester named in the dialog is `sesame-keychain`, Sésame's own signed assistant, never `security`. `sesame doctor` tells you which of your sites are still in that state; re-registering them (`sesame add <site>`) skips even that first click. Full details and guarantees: [SECURITY.md](SECURITY.md).

Then, if the site asks for a code (SMS, e-mail, app), a banner appears at the top of the Sésame Chrome and Sésame waits for you.

## Using it with Claude

Just say: *"Log in to my EDF account and fetch the August invoice."*

Claude calls `sesame_list_sites` to find the name `edf`, then `sesame_login(site: "edf", reason: "fetch the August invoice")`. With the `ask` policy, a dialog appears on your Mac: **Allow / Refuse** (Refuse by default, expires after 90 s). Claude then keeps browsing the tab with Claude in Chrome.

To make Claude remember, add to your instructions (Cowork / CLAUDE.md):

> For any site that requires a login, never ask me for my credentials: use the `sesame_*` tools (first `sesame_list_sites`, then `sesame_login` with a clear reason). If the site is not in Sésame, call `sesame_request_site` so that I can type my credentials in the Sésame window — never send me to a terminal.

## Second factor (code by SMS, e-mail or authenticator app)

You type the code — Sésame never sees it. But it does not leave you alone:

1. After the password, if the site asks for a code, Sésame detects it ("verification code" field, "sent by SMS" text…).
2. A macOS notification warns you, and a **banner appears at the top of the page** in the Sésame Chrome: "Sésame is waiting for you to enter the code you received…".
3. You type the code and confirm. As soon as the site accepts it, the banner disappears and Sésame hands back to Claude with "code entered by the user, login continued".
4. With no code after 3 minutes (adjustable, `codeTimeoutSec`), Sésame answers "timed out" and leaves the form open; Claude can resume waiting with `sesame_wait_code` when you are ready.

The journal records each step (`2fa`: waiting, succeeded, pending). If a site uses an unusual code field, point to it with `--code-sel` in `sesame add`.

## Compatibility: which assistants?

Sésame speaks **MCP**, the open protocol for assistant tools, over both standard transports: **stdio** (the client launches `sesame-mcp` locally) and **Streamable HTTP** (`sesame serve`, on 127.0.0.1, token required). Any compliant MCP client can therefore use it. Here is, honestly, what has been verified.

| Client | Transport | Status |
|---|---|---|
| **Claude Code** (terminal and Claude app) | stdio | ✅ **Tested end to end**: real login to an EDF customer account, approval dialog, journal, second-factor wait on a test bench |
| **Claude Desktop / Cowork** | stdio | ✅ **Tested**: `sesame install` registers the server, the five tools show up, calls logged under the `cowork` caller |
| **Official MCP client** (TypeScript SDK) | Streamable HTTP | ✅ **Tested** (`npm run check`): token in header or in URL, tool listing and calls, refusal without token |
| Cursor, VS Code Copilot (agent mode), Windsurf | stdio | 🟡 Compatible by construction (same stdio server). Config printed by `sesame install cursor\|vscode\|windsurf`. **Not tested.** |
| Codex CLI (OpenAI), Gemini CLI (Google) | stdio | 🟡 Compatible by construction. `sesame install codex\|gemini`. **Not tested.** |
| **ChatGPT** (connectors, developer mode) | remote HTTP | 🟡 ChatGPT launches no local process and cannot reach 127.0.0.1: you need `sesame serve` **plus an HTTPS tunnel** (cloudflared, ngrok…), URL `https://<tunnel>/mcp/<token>`. Possible, but **not tested**, and only for people who understand the risk of exposing an entry point (see SECURITY.md). |
| Other agents (LangChain, OpenAI Agents SDK, Mistral, etc.) | either | 🟡 Anything that speaks MCP should work. Not tested. |

Print every configuration at once: `sesame install print`.

## Known limits

- **Captcha**: Sésame does not solve it; it flags it (`hint`) and you do it in Chrome.
- **Unusual forms** (fields without `type`, Shadow DOM): give the selectors with `--user-sel / --pass-sel / --submit-sel / --code-sel`. To find them: right-click the field → Inspect.
- **macOS only** (Keychain + `osascript` dialogs). Node 20 or later.
- Since 0.5.0, the password read goes through the signed Keychain assistant (`sesame-keychain`): the Keychain dialog appears at most once per site, not at every login, and **Always Allow** is then the right answer there (the requester is the assistant, not `security`) — see SECURITY.md.
- An agent running JavaScript in the Sésame Chrome (Claude in Chrome installed there) can observe what Sésame types into the page. Sésame always submits and clears the field on failure, but cannot hide the DOM from an extension you installed. See SECURITY.md.
- Through the extension, if Chrome stops answering after the credentials were handed over, Sésame reports "the extension did not respond: check the tab" and does **not** retry in the dedicated Chrome (the form may already have been submitted).

## Troubleshooting

```bash
sesame doctor
```

- *"Cannot reach Chrome on http://127.0.0.1:9222"* → `sesame chrome` (the regular Chrome is not enough).
- *"No username/password field visible"* → open the login page (Claude can call `sesame_open_login`) or set `--url`.
- Claude does not see the tools → restart Claude Desktop; in Claude Code, `claude mcp list` must show `sesame`.
- Files: `~/.sesame/sites.json` (config), `~/.sesame/journal.jsonl` (journal), `~/.sesame/LOCKED` (Block), `~/.sesame/chrome-profile/`, `~/.sesame/http-token` (HTTP token).

## Security — summary

- Secrets: macOS Keychain only, encrypted by the system, bound to your session.
- Claude: no API returns a secret; errors are sanitized.
- Control: per-site policy, dialog approval (default), revocation, global Block.
- Traceability: append-only journal, readable by you and by Claude.
- Scope: everything runs locally on the Mac; no outbound network except Chrome itself.

## Development

```bash
npm install
npm run check        # syntax, MCP handshake, HTTP transport
npm run test:live    # real form filling in the Sésame Chrome (port 9222 must be free: SESAME_CDP_URL=http://127.0.0.1:9223 to use another)
npm run test:extension  # end to end through the Chrome extension: temporary Chrome profile, extension loaded via DevTools,
                        # bridge started by Chrome (native messaging), test form filled with and without a code
                        # (headless by default; SESAME_TEST_HEADED=1 to watch). Nothing is written to your Chrome or ~/.sesame.
npm run pack         # builds sesame-macos.zip for a release
```

Language note: the product, its dialogs and its journal speak French, because that is where it was born. Contributions to add English strings are welcome.
