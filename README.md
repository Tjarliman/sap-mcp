# sap-mcp

MCP server for SAP S/4HANA via the ADT API. Runs locally over stdio.

## Setup on a new machine

**Prerequisites** (install these first):

- **Node.js >= 20.12** (needs `process.loadEnvFile`; also provides `npm`) — required
- **Claude Code** — required to use the server (only the registration step needs it)
- **Network/VPN reachability** to your SAP hosts (e.g. `fiori-dev...`) — required
- **git** — optional; only used for `git clone`. No git? See below.
  (To install on Windows: `winget install --id Git.Git -e`, then **reopen your
  terminal**. macOS: `brew install git`. Verify with `git --version`.)

Then:

```bash
git clone https://github.com/Tjarliman/sap-mcp.git
cd sap-mcp
npm install
cp .env.example .env      # PowerShell/CMD: copy .env.example .env
```

> **No git?** Instead of `git clone`, download the repo from GitHub: green
> **Code** button -> **Download ZIP**, unzip it, then `cd` into the folder and
> continue from `npm install`. (git is only nicer later, for pulling updates
> with `git pull` instead of re-downloading.)

Now **edit `.env`** and fill in the real `HOST`/`CLIENT` for each system plus
**your own** SAP `USER`/`PASS`. The real hostnames are intentionally not in this
repo — get them from whoever maintains it. Then verify and register:

```bash
node test.mjs             # PASS = install OK  (does NOT check credentials)
node test.mjs --live      # PASS = credentials + SAP reachable  <-- the real proof

# Register with Claude Code (use the ABSOLUTE path to server.js on this machine):
claude mcp add sap-adt --scope user -- node C:\Users\<name>\sap-mcp\server.js
```

Start a **fresh Claude Code session** afterwards for the server to load.

> `node test.mjs` reports PASS even before you edit `.env` — it only checks that
> the server boots and loads profiles. `node test.mjs --live` is what actually
> confirms your credentials and SAP connectivity.

## Testing your install

The `node test.mjs` / `node test.mjs --live` steps above are the self-check
(`npm test` runs the structural one). The bundled harness talks to the server
over stdio — no Claude Code needed.

Once registered, you can also verify through Claude Code — ask it to run
`list_servers`, or a `query_table` with `SELECT MANDT, MTEXT FROM T000`.

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

## Disclaimer

This software is provided **"as is", without warranty of any kind**, express or
implied. You use it entirely **at your own risk**.

- **No liability.** The author accepts no responsibility for any damage, data
  loss, downtime, security incident, or other harm — to your computer, your SAP
  systems, or your data — arising from the use, misuse, or inability to use this
  software.
- **Your access, your responsibility.** You supply your own SAP credentials in
  `.env`. Keep that file private, use your own named user, and connect only to
  systems you are authorized to access.
- **Production risk remains.** Writes to the `ABLP` (production) profile are
  blocked, but the tool can still *read* from any system you configure. Use it
  at your own discretion.
- **Compliance is on you.** Ensure your use complies with your organization's
  policies and your SAP license terms before connecting.
- **Not affiliated with SAP.** SAP and S/4HANA are trademarks of SAP SE. This
  is an independent, unofficial tool and is not endorsed by or affiliated with
  SAP SE.

## License

[MIT](LICENSE). The license text includes the binding "as is" / no-warranty /
no-liability terms; the Disclaimer above restates them in plain language.
