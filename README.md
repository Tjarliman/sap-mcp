# sap-mcp

MCP server for SAP S/4HANA via the ADT API. Runs locally over stdio.

## Setup on a new machine

Requires **Node.js >= 20.12** (needs `process.loadEnvFile`).

```bash
git clone <repo-url> sap-mcp
cd sap-mcp
npm install
cp .env.example .env        # Windows: copy .env.example .env
# then edit .env and fill in YOUR OWN SAP credentials
```

## Register with Claude Code

Use the absolute path to `server.js` on this machine:

```bash
claude mcp add sap-adt --scope user -- node /absolute/path/to/sap-mcp/server.js
```

## Credentials

Each person uses their **own named SAP user** per system. All connection
details and credentials live in `.env` (gitignored); `server.js` contains no
real hostnames. Never commit or share `.env` — sharing a service account breaks
the SE24/transport audit trail and usually violates license terms.

Fill in `HOST`, `CLIENT`, `USER` and `PASS` for each profile in `.env`:

| Profile  | Role                     |
|----------|--------------------------|
| `ABLD`   | Development              |
| `dev120` | Development (client 120) |
| `snet`   | QA/Test                  |
| `ABLP`   | Production               |
| `snet2`  | S/4HANA on-prem          |

Writes to `ABLP` (production) are blocked in `server.js`; read access is allowed.
