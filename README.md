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
   reason="August invoice")        global lock?
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
- Each login triggers the macOS Keychain dialog before the password is read: answer **Allow**. Never click **Always Allow** (it would let any local process read the item silently, see SECURITY.md).
- An agent running JavaScript in the Sésame Chrome (Claude in Chrome installed there) can observe what Sésame types into the page. Sésame always submits and clears the field on failure, but cannot hide the DOM from an extension you installed. See SECURITY.md.

## Troubleshooting

```bash
sesame doctor
```

- *"Cannot reach Chrome on http://127.0.0.1:9222"* → `sesame chrome` (the regular Chrome is not enough).
- *"No username/password field visible"* → open the login page (Claude can call `sesame_open_login`) or set `--url`.
- Claude does not see the tools → restart Claude Desktop; in Claude Code, `claude mcp list` must show `sesame`.
- Files: `~/.sesame/sites.json` (config), `~/.sesame/journal.jsonl` (journal), `~/.sesame/LOCKED` (lock), `~/.sesame/chrome-profile/`, `~/.sesame/http-token` (HTTP token).

## Security — summary

- Secrets: macOS Keychain only, encrypted by the system, bound to your session.
- Claude: no API returns a secret; errors are sanitized.
- Control: per-site policy, dialog approval (default), revocation, global lock.
- Traceability: append-only journal, readable by you and by Claude.
- Scope: everything runs locally on the Mac; no outbound network except Chrome itself.

## Development

```bash
npm install
npm run check        # syntax, MCP handshake, HTTP transport
npm run test:live    # real form filling in the Sésame Chrome (needs `sesame chrome`)
npm run pack         # builds sesame-macos.zip for a release
```

Language note: the product, its dialogs and its journal speak French, because that is where it was born. Contributions to add English strings are welcome.
