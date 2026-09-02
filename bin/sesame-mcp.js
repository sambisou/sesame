#!/usr/bin/env node
// Point d'entrée MCP (stdio). Usage : sesame-mcp [nom-de-l-appelant]
import { main } from "../src/server.js";
main().catch(e => { console.error("sesame-mcp :", e.message); process.exit(1); });
