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
