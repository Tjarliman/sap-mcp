import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fetch from "node-fetch";
import https from "https";
import path from "path";
import { fileURLToPath } from "url";

// Credentials live in sap-mcp/.env and must never be written into this file.
// A launcher-supplied environment (e.g. the MCP config "env" block) also works;
// anything already in process.env wins over the file.
try {
  process.loadEnvFile(path.join(path.dirname(fileURLToPath(import.meta.url)), ".env"));
} catch {
  // No .env present - fall back to the ambient environment.
}

// Reads SAP_<PROFILE>_USER / SAP_<PROFILE>_PASS, e.g. SAP_ABLD_USER.
function cred(key) {
  const k = key.toUpperCase();
  return { user: process.env[`SAP_${k}_USER`], pass: process.env[`SAP_${k}_PASS`] };
}

// Connection details (host + client) are not written into this file so it can
// be published without exposing infrastructure. They live in .env next to the
// credentials. Per profile: SAP_<KEY>_HOST, SAP_<KEY>_CLIENT, SAP_<KEY>_USER,
// SAP_<KEY>_PASS. Only the human-readable label stays here.
function conn(key, label) {
  const k = key.toUpperCase();
  return {
    label,
    host: process.env[`SAP_${k}_HOST`],
    client: process.env[`SAP_${k}_CLIENT`],
    ...cred(key),
  };
}

const PROFILES = {
  "ABLD":   conn("ABLD",   "Development"),
  "dev120": conn("dev120", "Development (client 120)"),
  "snet":   conn("snet",   "QA/Test 2022"),
  "ABLP":   conn("ABLP",   "Production"),
  "snet2":  conn("snet2",  "S/4HANA on-prem"),
  // To add a profile: add an entry here, then set SAP_<NAME>_HOST,
  // SAP_<NAME>_CLIENT, SAP_<NAME>_USER and SAP_<NAME>_PASS in .env.
};

let activeProfile = "ABLD";

// Profiles that must never be written to, whatever the caller asks for.
const WRITE_BLOCKED_PROFILES = new Set(["ABLP"]);

function profile() {
  const p = PROFILES[activeProfile];
  if (!p) {
    throw new Error(`Unknown profile: ${activeProfile}. Available: ${Object.keys(PROFILES).join(", ")}`);
  }
  const k = activeProfile.toUpperCase();
  if (!p.host || !p.client) {
    throw new Error(
      `No connection details for profile "${activeProfile}". Set SAP_${k}_HOST and SAP_${k}_CLIENT in sap-mcp/.env`
    );
  }
  if (!p.user || !p.pass) {
    throw new Error(
      `No credentials for profile "${activeProfile}". Set SAP_${k}_USER and SAP_${k}_PASS in sap-mcp/.env`
    );
  }
  return p;
}

function assertWritable() {
  if (WRITE_BLOCKED_PROFILES.has(activeProfile)) {
    const p = PROFILES[activeProfile];
    throw new Error(
      `Writes are blocked on profile "${activeProfile}" (${p.label}, client ${p.client}). ` +
      `This is a production system. Switch to a development profile first.`
    );
  }
}

const agent = new https.Agent({ rejectUnauthorized: false });

function authHeaders(accept = "application/xml") {
  const p = profile();
  const token = Buffer.from(`${p.user}:${p.pass}`).toString("base64");
  return {
    Authorization: `Basic ${token}`,
    "sap-client": p.client,
    Accept: accept,
  };
}

async function adtGet(path, accept) {
  const res = await fetch(`${profile().host}${path}`, {
    headers: authHeaders(accept),
    agent,
  });
  if (!res.ok) throw new Error(`SAP ADT error ${res.status}: ${await res.text()}`);
  return res.text();
}

async function fetchCsrfToken() {
  const res = await fetch(`${profile().host}/sap/bc/adt/datapreview/freestyle`, {
    method: "HEAD",
    headers: { ...authHeaders(), "X-CSRF-Token": "Fetch" },
    agent,
  });
  const token = res.headers.get("x-csrf-token");
  const cookies = res.headers.raw()["set-cookie"] || [];
  return { token, cookies: cookies.map(c => c.split(";")[0]).join("; ") };
}

// ADT locking is stateful: the lock, the PUT and the unlock must all ride the
// same session, so cookies set by any response have to be carried forward.
function mergeCookies(existing, res) {
  const jar = new Map();
  for (const c of (existing || "").split("; ").filter(Boolean)) {
    const i = c.indexOf("=");
    if (i > 0) jar.set(c.slice(0, i), c.slice(i + 1));
  }
  for (const c of res.headers.raw()["set-cookie"] || []) {
    const first = c.split(";")[0];
    const i = first.indexOf("=");
    if (i > 0) jar.set(first.slice(0, i), first.slice(i + 1));
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

function escapeXml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// Parses the <msg .../> list an activation returns. An empty body means success.
function parseActivationMessages(xml) {
  if (!xml || !xml.trim()) return [];
  return [...xml.matchAll(/<msg[^>]*\btype="([^"]*)"[^>]*>([\s\S]*?)<\/msg>/g)].map(m => {
    const txt = m[2].match(/<txt>([\s\S]*?)<\/txt>/);
    return { type: m[1], text: txt ? txt[1] : m[2].replace(/<[^>]+>/g, " ").trim() };
  });
}

function parseDataPreview(xml) {
  const totalMatch = xml.match(/<dataPreview:totalRows>(\d+)<\/dataPreview:totalRows>/);
  const total = totalMatch ? parseInt(totalMatch[1]) : 0;
  const columns = [...xml.matchAll(/<dataPreview:metadata[^>]*dataPreview:name="([^"]*)"[^>]*dataPreview:description="([^"]*)"/g)]
    .map(m => ({ name: m[1], desc: m[2] }));
  const datasets = [...xml.matchAll(/<dataPreview:dataSet>([\s\S]*?)<\/dataPreview:dataSet>/g)]
    .map(m => [...m[1].matchAll(/<dataPreview:data[^>]*>([^<]*)<\/dataPreview:data>/g)].map(d => d[1].trim()));
  if (columns.length === 0) return { total, rows: [] };
  const rowCount = datasets[0]?.length || 0;
  const rows = Array.from({ length: rowCount }, (_, i) =>
    Object.fromEntries(columns.map((col, j) => [col.name, datasets[j]?.[i] ?? ""]))
  );
  return { total, columns: columns.map(c => c.name), rows };
}

function parseObjectRefs(xml) {
  const matches = [...xml.matchAll(
    /adtcore:name="([^"]+)"[^>]*adtcore:type="([^"]+)"[^>]*adtcore:packageName="([^"]+)"[^>]*adtcore:description="([^"]*)"/g
  )];
  return matches.map(m => ({
    name: m[1],
    type: m[2],
    package: m[3],
    description: m[4],
  }));
}

const server = new McpServer({
  name: "sap-adt",
  version: "1.0.0",
});

server.tool(
  "list_servers",
  "List all available SAP server profiles and show which one is currently active",
  {},
  async () => {
    const lines = Object.entries(PROFILES).map(([key, p]) => {
      const active = key === activeProfile ? " ◀ active" : "";
      const creds = p.user && p.pass ? "" : "  [NO CREDENTIALS - check .env]";
      const ro = WRITE_BLOCKED_PROFILES.has(key) ? "  [read-only]" : "";
      return `${key}: ${p.label} | ${p.host} | client ${p.client}${ro}${creds}${active}`;
    });
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "switch_server",
  "Switch the active SAP server profile by name",
  {
    profile: z.string().describe("Profile name to switch to, e.g. dev, prod"),
  },
  async ({ profile: name }) => {
    if (!PROFILES[name]) {
      const available = Object.keys(PROFILES).join(", ");
      return { content: [{ type: "text", text: `Profile "${name}" not found. Available: ${available}` }] };
    }
    activeProfile = name;
    const p = PROFILES[name];
    return { content: [{ type: "text", text: `Switched to profile "${name}": ${p.label} (${p.host}, client ${p.client})` }] };
  }
);

server.tool(
  "search_programs",
  "Search ABAP programs in SAP S/4HANA by name pattern (use * as wildcard)",
  {
    query: z.string().describe("Search pattern, e.g. Z* or ZFIN* or ZMYPROGRAM"),
    maxResults: z.number().optional().default(20).describe("Max number of results"),
    objectType: z.enum(["PROG", "FUGR", "CLAS", "INTF", "TABL", "VIEW"]).optional().default("PROG").describe("Object type"),
  },
  async ({ query, maxResults, objectType }) => {
    const xml = await adtGet(
      `/sap/bc/adt/repository/informationsystem/search?operation=quickSearch&query=${encodeURIComponent(query)}&maxResults=${maxResults}&objectType=${objectType}`
    );
    const refs = parseObjectRefs(xml);
    if (refs.length === 0) return { content: [{ type: "text", text: "No programs found." }] };
    const lines = refs.map(r => `${r.name} (${r.type}) | Package: ${r.package} | ${r.description}`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "get_program_source",
  "Read the ABAP source code of a program from SAP S/4HANA",
  {
    programName: z.string().describe("Exact program name, e.g. ZMYPROGRAM"),
  },
  async ({ programName }) => {
    const name = programName.toLowerCase();
    // Reports/programs live under programs/programs; includes under programs/includes.
    // Try program path first, fall back to include path on 404 (not found).
    const paths = [
      `/sap/bc/adt/programs/programs/${name}/source/main`,
      `/sap/bc/adt/programs/includes/${name}/source/main`,
    ];
    let lastErr;
    for (const path of paths) {
      try {
        const xml = await adtGet(path, "text/plain");
        return { content: [{ type: "text", text: xml }] };
      } catch (e) {
        lastErr = e;
        // Only fall through when the object wasn't found; rethrow real errors.
        if (!/error 404/i.test(String(e && e.message))) throw e;
      }
    }
    throw lastErr;
  }
);

server.tool(
  "list_package_objects",
  "List all repository objects inside an SAP package",
  {
    packageName: z.string().describe("Package name, e.g. ZMYPACKAGE"),
  },
  async ({ packageName }) => {
    const xml = await adtGet(
      `/sap/bc/adt/repository/informationsystem/search?operation=quickSearch&query=*&maxResults=100&objectType=PROG&packageName=${encodeURIComponent(packageName)}`
    );
    const refs = parseObjectRefs(xml);
    if (refs.length === 0) return { content: [{ type: "text", text: `No objects found in package ${packageName}.` }] };
    const lines = refs.map(r => `${r.name} (${r.type}) | ${r.description}`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "get_object_info",
  "Get metadata/details about an ABAP object (program, function group, class, etc.)",
  {
    objectUri: z.string().describe("ADT URI of the object, e.g. /sap/bc/adt/programs/programs/zmyprogram"),
  },
  async ({ objectUri }) => {
    const xml = await adtGet(objectUri);
    return { content: [{ type: "text", text: xml }] };
  }
);

server.tool(
  "get_table_info",
  "Get structure and field definitions of a SAP DDIC table (e.g. EKKO, MARA, BSEG)",
  {
    tableName: z.string().describe("Table name, e.g. EKKO"),
  },
  async ({ tableName }) => {
    const name = tableName.toUpperCase();
    const nameLower = tableName.toLowerCase();
    const [meta, source] = await Promise.all([
      adtGet(`/sap/bc/adt/ddic/tables/${nameLower}`, "*/*"),
      adtGet(`/sap/bc/adt/ddic/tables/${nameLower}/source/main`, "text/plain"),
    ]);
    const descMatch = meta.match(/adtcore:description="([^"]*)"/);
    const description = descMatch ? descMatch[1] : "";
    return {
      content: [{
        type: "text",
        text: `Table: ${name}\nDescription: ${description}\n\n--- Field Definitions ---\n${source}`,
      }],
    };
  }
);

server.tool(
  "query_table",
  "Run a SQL SELECT query against SAP tables and return results as a formatted table",
  {
    sql: z.string().describe("SQL SELECT statement, e.g. SELECT EBELN, BSART FROM EKKO"),
    maxRows: z.number().optional().default(20).describe("Maximum rows to return (default 20)"),
  },
  async ({ sql, maxRows }) => {
    try {
    const { token, cookies } = await fetchCsrfToken();
    const res = await fetch(
      `${profile().host}/sap/bc/adt/datapreview/freestyle?maxRows=${maxRows}&rowNumber=0`,
      {
        method: "POST",
        headers: {
          ...authHeaders("application/vnd.sap.adt.datapreview.table.v1+xml"),
          "Content-Type": "text/plain",
          "X-CSRF-Token": token,
          Cookie: cookies,
        },
        body: sql,
        agent,
      }
    );
    if (!res.ok) throw new Error(`SAP ADT error ${res.status}: ${await res.text()}`);
    const xml = await res.text();
    const { total, columns, rows } = parseDataPreview(xml);
    if (rows.length === 0) return { content: [{ type: "text", text: `Query returned 0 rows. Total in table: ${total}` }] };
    const header = columns.join(" | ");
    const divider = columns.map(c => "-".repeat(c.length)).join("-|-");
    const dataRows = rows.map(r => columns.map(c => r[c]).join(" | "));
    const text = [header, divider, ...dataRows, `\n(${rows.length} of ${total} rows)`].join("\n");
    return { content: [{ type: "text", text }] };
    } catch(e) {
      throw new Error(`query_table failed: ${e.stack || e.message}`);
    }
  }
);

server.tool(
  "create_class",
  "Create a new ABAP class in SAP and activate it. Refuses to run on production profiles. " +
  "Needs the full source (CLASS...DEFINITION...ENDCLASS. CLASS...IMPLEMENTATION...ENDCLASS.) " +
  "and a transport request when the package is transportable.",
  {
    className: z.string().describe("Class name, e.g. ZCLAB_IF_PO_IN_NS"),
    description: z.string().describe("Short description shown in SE24"),
    packageName: z.string().describe("Package, e.g. ZABAP. Use $TMP for a local throwaway class."),
    source: z.string().describe("Complete ABAP source of the class"),
    transport: z.string().optional().describe("Transport request, e.g. ABLK900123. Omit only for $TMP."),
    activate: z.boolean().optional().default(true).describe("Activate after writing the source"),
  },
  async ({ className, description, packageName, source, transport: corrNr, activate }) => {
    assertWritable();

    const name = className.toUpperCase();
    const uri = `/sap/bc/adt/oo/classes/${className.toLowerCase()}`;
    const host = profile().host;
    const log = [];

    const { token, cookies: initialCookies } = await fetchCsrfToken();
    let cookies = initialCookies;
    if (!token) throw new Error("Could not obtain a CSRF token - check credentials/profile.");

    const call = async (path, { method, headers = {}, body, accept = "*/*" }) => {
      const res = await fetch(`${host}${path}`, {
        method,
        headers: {
          ...authHeaders(accept),
          "X-CSRF-Token": token,
          "x-sap-adt-sessiontype": "stateful",
          Cookie: cookies,
          ...headers,
        },
        body,
        agent,
      });
      cookies = mergeCookies(cookies, res);
      const text = await res.text();
      return { ok: res.ok, status: res.status, text };
    };

    // 1) create the (empty) class shell
    const corrQuery = corrNr ? `?corrNr=${encodeURIComponent(corrNr)}` : "";
    const shell =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<class:abapClass xmlns:class="http://www.sap.com/adt/oo/classes" ` +
      `xmlns:adtcore="http://www.sap.com/adt/core" ` +
      `adtcore:name="${escapeXml(name)}" adtcore:type="CLAS/OC" ` +
      `adtcore:description="${escapeXml(description)}" ` +
      `adtcore:language="EN" adtcore:masterLanguage="EN" ` +
      `class:final="true" class:visibility="public">\n` +
      `  <adtcore:packageRef adtcore:name="${escapeXml(packageName.toUpperCase())}"/>\n` +
      `</class:abapClass>`;

    const created = await call(`/sap/bc/adt/oo/classes${corrQuery}`, {
      method: "POST",
      headers: { "Content-Type": "application/vnd.sap.adt.oo.classes.v2+xml" },
      body: shell,
    });
    if (!created.ok) {
      throw new Error(`Create failed (${created.status}). ${created.text}`);
    }
    log.push(`Created shell ${name} in package ${packageName.toUpperCase()}${corrNr ? ` on ${corrNr}` : ""}.`);

    // 2) lock  3) put source  5) unlock — all on the one stateful session
    const locked = await call(`${uri}?_action=LOCK&accessMode=MODIFY`, {
      method: "POST",
      accept: "application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.Result",
    });
    if (!locked.ok) throw new Error(`Lock failed (${locked.status}). ${locked.text}`);
    const handle = (locked.text.match(/<LOCK_HANDLE>([^<]*)<\/LOCK_HANDLE>/) || [])[1];
    if (!handle) throw new Error(`No lock handle returned. ${locked.text}`);
    log.push("Locked.");

    try {
      const put = await call(
        `${uri}/source/main?lockHandle=${encodeURIComponent(handle)}` +
        (corrNr ? `&corrNr=${encodeURIComponent(corrNr)}` : ""),
        { method: "PUT", headers: { "Content-Type": "text/plain; charset=utf-8" }, body: source }
      );
      if (!put.ok) throw new Error(`Source PUT failed (${put.status}). ${put.text}`);
      log.push(`Source written (${source.split("\n").length} lines).`);

      if (activate) {
        const actBody =
          `<?xml version="1.0" encoding="UTF-8"?>\n` +
          `<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">\n` +
          `  <adtcore:objectReference adtcore:uri="${uri}" adtcore:name="${escapeXml(name)}"/>\n` +
          `</adtcore:objectReferences>`;
        const act = await call(`/sap/bc/adt/activation?method=activate&preauditRequests=false`, {
          method: "POST",
          headers: { "Content-Type": "application/xml" },
          body: actBody,
        });
        const msgs = parseActivationMessages(act.text);
        const bad = msgs.filter(m => /^[EAW]$/i.test(m.type));
        if (!act.ok || bad.length) {
          log.push(`ACTIVATION FAILED (HTTP ${act.status}) - the class exists but is INACTIVE.`);
          for (const m of (bad.length ? bad : msgs)) log.push(`  [${m.type}] ${m.text}`);
          // Never swallow the response: without it there is nothing to debug.
          if (!bad.length) log.push(`  Raw response: ${(act.text || "(empty body)").slice(0, 1500)}`);
        } else {
          log.push("Activated cleanly.");
        }
      }
    } finally {
      const unlocked = await call(`${uri}?_action=UNLOCK&lockHandle=${encodeURIComponent(handle)}`, {
        method: "POST",
      });
      log.push(unlocked.ok ? "Unlocked." : `WARNING: unlock failed (${unlocked.status}) - object may stay locked.`);
    }

    return { content: [{ type: "text", text: log.join("\n") }] };
  }
);

server.tool(
  "activate_object",
  "Activate an existing ABAP object and report the raw activation result. " +
  "Use to retry activation without recreating the object. Blocked on production profiles.",
  {
    objectUri: z.string().describe("ADT URI, e.g. /sap/bc/adt/oo/classes/zcl_foo"),
    objectName: z.string().describe("Object name, e.g. ZCL_FOO"),
  },
  async ({ objectUri, objectName }) => {
    assertWritable();

    const { token, cookies: initial } = await fetchCsrfToken();
    const name = objectName.toUpperCase();
    const body =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">\n` +
      `  <adtcore:objectReference adtcore:uri="${objectUri}" adtcore:name="${escapeXml(name)}"/>\n` +
      `</adtcore:objectReferences>`;

    const res = await fetch(
      `${profile().host}/sap/bc/adt/activation?method=activate&preauditRequests=false`,
      {
        method: "POST",
        headers: {
          ...authHeaders("application/xml"),
          "Content-Type": "application/xml",
          "X-CSRF-Token": token,
          Cookie: initial,
        },
        body,
        agent,
      }
    );
    const text = await res.text();
    const msgs = parseActivationMessages(text);

    const out = [`HTTP ${res.status}`];
    if (msgs.length) for (const m of msgs) out.push(`  [${m.type}] ${m.text}`);
    else out.push(`  Body: ${text ? text.slice(0, 2000) : "(empty - usually means success)"}`);
    return { content: [{ type: "text", text: out.join("\n") }] };
  }
);

server.tool(
  "update_program_source",
  "Overwrite the source of an EXISTING ABAP program or include (report, include, module pool). " +
  "Resolves program-vs-include automatically, then locks, PUTs the source, optionally activates, and unlocks. " +
  "Refuses to run on production profiles. IMPORTANT: this replaces the WHOLE object - always read it first " +
  "with get_program_source, edit that text, and send the complete result back.",
  {
    programName: z.string().describe("Program or include name, e.g. ZABLMMNF00002TOP"),
    source: z.string().describe("Complete new ABAP source - REPLACES the entire object"),
    transport: z.string().optional().describe("Transport request, e.g. D01K900123. Omit only for local/$TMP objects."),
    activate: z.boolean().optional().default(false).describe("Activate after writing. Default false - activate in SE38/SE80 yourself."),
  },
  async ({ programName, source, transport: corrNr, activate }) => {
    assertWritable();

    if (!source || !source.trim()) {
      throw new Error("Refusing to write an empty source - that would wipe the object.");
    }

    const name = programName.toUpperCase();
    const lower = programName.toLowerCase();
    const host = profile().host;
    const log = [];

    const { token, cookies: initialCookies } = await fetchCsrfToken();
    let cookies = initialCookies;
    if (!token) throw new Error("Could not obtain a CSRF token - check credentials/profile.");

    const call = async (path, { method, headers = {}, body, accept = "*/*" }) => {
      const res = await fetch(`${host}${path}`, {
        method,
        headers: {
          ...authHeaders(accept),
          "X-CSRF-Token": token,
          "x-sap-adt-sessiontype": "stateful",
          Cookie: cookies,
          ...headers,
        },
        body,
        agent,
      });
      cookies = mergeCookies(cookies, res);
      const text = await res.text();
      return { ok: res.ok, status: res.status, text };
    };

    // Reports live under programs/programs, includes under programs/includes.
    let uri = null;
    let before = "";
    for (const candidate of [
      `/sap/bc/adt/programs/programs/${lower}`,
      `/sap/bc/adt/programs/includes/${lower}`,
    ]) {
      const probe = await call(`${candidate}/source/main`, { method: "GET", accept: "text/plain" });
      if (probe.ok) { uri = candidate; before = probe.text; break; }
      if (probe.status !== 404) throw new Error(`Cannot read ${name} (${probe.status}). ${probe.text}`);
    }
    if (!uri) throw new Error(`Program/include ${name} not found (tried programs/ and includes/).`);
    log.push(`Target: ${uri}`);
    log.push(`Current size: ${before.split("\n").length} lines -> new: ${source.split("\n").length} lines.`);

    const locked = await call(`${uri}?_action=LOCK&accessMode=MODIFY`, {
      method: "POST",
      accept: "application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.Result",
    });
    if (!locked.ok) throw new Error(`Lock failed (${locked.status}). ${locked.text}`);
    const handle = (locked.text.match(/<LOCK_HANDLE>([^<]*)<\/LOCK_HANDLE>/) || [])[1];
    if (!handle) throw new Error(`No lock handle returned. ${locked.text}`);
    log.push("Locked.");

    try {
      const put = await call(
        `${uri}/source/main?lockHandle=${encodeURIComponent(handle)}` +
        (corrNr ? `&corrNr=${encodeURIComponent(corrNr)}` : ""),
        { method: "PUT", headers: { "Content-Type": "text/plain; charset=utf-8" }, body: source }
      );
      if (!put.ok) throw new Error(`Source PUT failed (${put.status}). ${put.text}`);
      log.push(`Source written${corrNr ? ` on ${corrNr}` : ""}.`);

      if (activate) {
        const actBody =
          `<?xml version="1.0" encoding="UTF-8"?>\n` +
          `<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">\n` +
          `  <adtcore:objectReference adtcore:uri="${uri}" adtcore:name="${escapeXml(name)}"/>\n` +
          `</adtcore:objectReferences>`;
        const act = await call(`/sap/bc/adt/activation?method=activate&preauditRequests=false`, {
          method: "POST",
          headers: { "Content-Type": "application/xml" },
          body: actBody,
        });
        const msgs = parseActivationMessages(act.text);
        const bad = msgs.filter(m => /^[EAW]$/i.test(m.type));
        if (!act.ok || bad.length) {
          log.push(`ACTIVATION FAILED (HTTP ${act.status}) - source IS saved but the object is INACTIVE.`);
          for (const m of (bad.length ? bad : msgs)) log.push(`  [${m.type}] ${m.text}`);
          if (!bad.length) log.push(`  Raw response: ${(act.text || "(empty body)").slice(0, 1500)}`);
        } else {
          log.push("Activated cleanly.");
        }
      } else {
        log.push("Not activated (activate=false) - activate it in SE38/SE80.");
      }
    } finally {
      const unlocked = await call(`${uri}?_action=UNLOCK&lockHandle=${encodeURIComponent(handle)}`, {
        method: "POST",
      });
      log.push(unlocked.ok ? "Unlocked." : `WARNING: unlock failed (${unlocked.status}) - object may stay locked.`);
    }

    return { content: [{ type: "text", text: log.join("\n") }] };
  }
);

server.tool(
  "patch_program_source",
  "Modify PART of an existing ABAP program or include without resending the whole object. " +
  "Reads the current source, replaces oldString with newString (must match EXACTLY ONCE), then locks, PUTs, " +
  "optionally activates, and unlocks. Prefer this over update_program_source for edits - it removes any risk of " +
  "corrupting the object by re-transmitting untouched code. Refuses to run on production profiles.",
  {
    programName: z.string().describe("Program or include name, e.g. ZABLMMNF00002TOP"),
    oldString: z.string().describe("Exact existing text to replace. Must occur exactly once - include enough context to be unique."),
    newString: z.string().describe("Replacement text"),
    transport: z.string().optional().describe("Transport request, e.g. D01K903926. Omit only for local/$TMP objects."),
    activate: z.boolean().optional().default(false).describe("Activate after writing. Default false - activate in SE38/SE80 yourself."),
  },
  async ({ programName, oldString, newString, transport: corrNr, activate }) => {
    assertWritable();

    if (!oldString) throw new Error("oldString must not be empty.");
    if (oldString === newString) throw new Error("oldString and newString are identical - nothing to do.");

    const name = programName.toUpperCase();
    const lower = programName.toLowerCase();
    const host = profile().host;
    const log = [];

    const { token, cookies: initialCookies } = await fetchCsrfToken();
    let cookies = initialCookies;
    if (!token) throw new Error("Could not obtain a CSRF token - check credentials/profile.");

    const call = async (path, { method, headers = {}, body, accept = "*/*" }) => {
      const res = await fetch(`${host}${path}`, {
        method,
        headers: {
          ...authHeaders(accept),
          "X-CSRF-Token": token,
          "x-sap-adt-sessiontype": "stateful",
          Cookie: cookies,
          ...headers,
        },
        body,
        agent,
      });
      cookies = mergeCookies(cookies, res);
      const text = await res.text();
      return { ok: res.ok, status: res.status, text };
    };

    // Reports live under programs/programs, includes under programs/includes.
    let uri = null;
    let before = null;
    for (const candidate of [
      `/sap/bc/adt/programs/programs/${lower}`,
      `/sap/bc/adt/programs/includes/${lower}`,
    ]) {
      const probe = await call(`${candidate}/source/main`, { method: "GET", accept: "text/plain" });
      if (probe.ok) { uri = candidate; before = probe.text; break; }
      if (probe.status !== 404) throw new Error(`Cannot read ${name} (${probe.status}). ${probe.text}`);
    }
    if (uri === null) throw new Error(`Program/include ${name} not found (tried programs/ and includes/).`);

    // ADT hands source back with CRLF; callers naturally write LF. Normalise both
    // sides so a multi-line oldString can match. ABAP source is stored server-side
    // as a line table, so the line endings we PUT are not persisted verbatim.
    const nl = s => String(s).replace(/\r\n/g, "\n");
    before = nl(before);
    oldString = nl(oldString);
    newString = nl(newString);

    // Exact-match replace, server side: nothing outside oldString can be disturbed.
    const hits = before.split(oldString).length - 1;
    if (hits === 0) {
      // Help the caller find the drift instead of making them guess.
      const firstLine = oldString.split("\n")[0];
      const near = before.split("\n").filter(l => l.includes(firstLine.trim()) && firstLine.trim());
      throw new Error(
        `oldString not found in ${name}. Nothing written.` +
        (near.length ? ` Lines containing the first line of oldString: ${JSON.stringify(near.slice(0, 5))}` : "")
      );
    }
    if (hits > 1) throw new Error(`oldString matched ${hits} times in ${name}. Nothing written. Add surrounding context to make it unique.`);
    const after = before.replace(oldString, newString);

    log.push(`Target: ${uri}`);
    log.push(`Patched 1 occurrence. Lines ${before.split("\n").length} -> ${after.split("\n").length}.`);

    const locked = await call(`${uri}?_action=LOCK&accessMode=MODIFY`, {
      method: "POST",
      accept: "application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.Result",
    });
    if (!locked.ok) throw new Error(`Lock failed (${locked.status}). ${locked.text}`);
    const handle = (locked.text.match(/<LOCK_HANDLE>([^<]*)<\/LOCK_HANDLE>/) || [])[1];
    if (!handle) throw new Error(`No lock handle returned. ${locked.text}`);
    log.push("Locked.");

    try {
      const put = await call(
        `${uri}/source/main?lockHandle=${encodeURIComponent(handle)}` +
        (corrNr ? `&corrNr=${encodeURIComponent(corrNr)}` : ""),
        { method: "PUT", headers: { "Content-Type": "text/plain; charset=utf-8" }, body: after }
      );
      if (!put.ok) throw new Error(`Source PUT failed (${put.status}). ${put.text}`);
      log.push(`Source written${corrNr ? ` on ${corrNr}` : ""}.`);

      if (activate) {
        const actBody =
          `<?xml version="1.0" encoding="UTF-8"?>\n` +
          `<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">\n` +
          `  <adtcore:objectReference adtcore:uri="${uri}" adtcore:name="${escapeXml(name)}"/>\n` +
          `</adtcore:objectReferences>`;
        const act = await call(`/sap/bc/adt/activation?method=activate&preauditRequests=false`, {
          method: "POST",
          headers: { "Content-Type": "application/xml" },
          body: actBody,
        });
        const msgs = parseActivationMessages(act.text);
        const bad = msgs.filter(m => /^[EAW]$/i.test(m.type));
        if (!act.ok || bad.length) {
          log.push(`ACTIVATION FAILED (HTTP ${act.status}) - source IS saved but the object is INACTIVE.`);
          for (const m of (bad.length ? bad : msgs)) log.push(`  [${m.type}] ${m.text}`);
          if (!bad.length) log.push(`  Raw response: ${(act.text || "(empty body)").slice(0, 1500)}`);
        } else {
          log.push("Activated cleanly.");
        }
      } else {
        log.push("Not activated (activate=false) - activate it in SE38/SE80.");
      }
    } finally {
      const unlocked = await call(`${uri}?_action=UNLOCK&lockHandle=${encodeURIComponent(handle)}`, {
        method: "POST",
      });
      log.push(unlocked.ok ? "Unlocked." : `WARNING: unlock failed (${unlocked.status}) - object may stay locked.`);
    }

    return { content: [{ type: "text", text: log.join("\n") }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
