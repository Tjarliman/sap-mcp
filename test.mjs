// Self-check for sap-mcp. Boots the server over stdio and verifies it
// initializes, registers its tools, and reads the profiles from your .env.
// Pass --live to also run a harmless read (SELECT ... FROM T000) against the
// active SAP profile, which confirms credentials and network reachability.
//
//   node test.mjs          structural check only (no SAP connection needed)
//   node test.mjs --live    also performs a live SAP read
//
// Exit code 0 = pass, non-zero = fail.

import { spawn } from "child_process";
import readline from "readline";
import { fileURLToPath } from "url";
import path from "path";

const LIVE = process.argv.includes("--live");
const dir = path.dirname(fileURLToPath(import.meta.url));

const child = spawn(process.execPath, ["server.js"], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
let stderr = "";
child.stderr.on("data", (d) => (stderr += d));

const rl = readline.createInterface({ input: child.stdout });
const pending = new Map();
rl.on("line", (line) => {
  line = line.trim();
  if (!line) return;
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});

const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
const rpc = (id, method, params) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout waiting for ${method}`)), 25000);
    pending.set(id, (m) => { clearTimeout(t); res(m); });
    send({ jsonrpc: "2.0", id, method, params });
  });

const hard = setTimeout(() => { console.error("Timed out."); child.kill(); process.exit(2); }, 45000);
const indent = (s) => s.split("\n").map((l) => "      " + l).join("\n");
function finish(code) {
  clearTimeout(hard);
  child.kill();
  if (stderr.trim()) console.log("\nserver stderr:\n" + stderr.trim());
  process.exit(code);
}

try {
  const init = await rpc(1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "self-check", version: "0" },
  });
  if (!init.result) { console.error("FAIL: initialize -", JSON.stringify(init.error)); finish(1); }
  console.log(`ok   server initialized: ${init.result.serverInfo?.name} v${init.result.serverInfo?.version}`);

  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const tools = await rpc(2, "tools/list", {});
  const names = (tools.result?.tools || []).map((t) => t.name);
  if (!names.length) { console.error("FAIL: no tools registered"); finish(1); }
  console.log(`ok   ${names.length} tools registered`);

  const ls = await rpc(3, "tools/call", { name: "list_servers", arguments: {} });
  console.log("ok   profiles read from .env:\n" + indent(ls.result?.content?.[0]?.text || ""));

  if (LIVE) {
    console.log("\n...  live read (SELECT MANDT, MTEXT FROM T000) against the active profile");
    const q = await rpc(4, "tools/call", {
      name: "query_table",
      arguments: { sql: "SELECT MANDT, MTEXT FROM T000", maxRows: 5 },
    });
    const text = q.result?.content?.[0]?.text || JSON.stringify(q.error || q.result);
    if (q.result && !q.result.isError) {
      console.log("ok   live SAP read returned data:\n" + indent(text));
    } else {
      console.error(
        "FAIL: live read returned no data. Usually VPN/network to the SAP host,\n" +
        "      or wrong/missing credentials in .env - not a problem with the code.\n" +
        indent(text)
      );
      finish(1);
    }
  }

  console.log(
    "\nPASS" +
      (LIVE
        ? " - install works and SAP is reachable."
        : " - install looks good. Run `node test.mjs --live` to also test the SAP connection.")
  );
  finish(0);
} catch (e) {
  console.error("FAIL:", e.message);
  finish(1);
}
