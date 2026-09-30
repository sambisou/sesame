import { login } from "./src/login.js";
const r = await login({ site: process.argv[2], caller: "diag", waitForCode: false, codeTimeoutSec: 10 });
console.log(JSON.stringify({ ok: r.ok, msg: (r.message||"").slice(0,90), steps: r.steps, url: r.url, sf: r.secondFactor }));
