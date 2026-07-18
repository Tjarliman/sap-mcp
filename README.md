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

## Testing your install

After `npm install` and filling in `.env`, verify it works with the bundled
self-check (no Claude Code needed):

```bash
node test.mjs          # structural: boots the server, lists tools, reads your profiles
node test.mjs --live   # also runs a harmless read (T000) against the active SAP system
```

`node test.mjs` should end with `PASS`. Use `--live` to confirm credentials and
network reachability to the SAP host — if that step fails, it's almost always
VPN/network or credentials, not the code. (`npm test` runs the structural check.)

You can also verify through Claude Code once registered — ask it to run
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
