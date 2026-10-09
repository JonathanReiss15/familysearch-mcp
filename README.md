# FamilySearch MCP Server

A local [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server for [FamilySearch](https://www.familysearch.org). Gives AI assistants access to search the Family Tree, view person details, explore ancestors and descendants, and search historical records.

## Features

- **Family Tree search** — find individuals by name, dates, places, and gender
- **Person details** — view a person card by ID
- **Pedigree exploration** — ancestors (up to 8 generations) and descendants (up to 3)
- **Family overview** — parents, siblings, spouses with marriage, and children
- **Research suggestions** — ancestors with pending record hints or missing data
- **Historical records** — search record collections with relatives, date ranges and places, and view full records
- **Browser session auth** — log in once with Brave; no FamilySearch API key required

## How it works

FamilySearch does not approve direct API access for most personal projects. This server reuses your **browser session cookies** and calls the same internal `/service/` endpoints the website uses. Record details come from the `/platform/` GEDCOM X API, which receives the same session as a bearer token. Your session is stored locally at `~/.familysearch-mcp/config.json`.

## Prerequisites

- [Node.js](https://nodejs.org/) 18+ and npm
- [Brave browser](https://brave.com/download/) — Playwright's bundled Chromium is blocked by FamilySearch bot detection
- A free FamilySearch account

## Installation

### 1. Clone and build

```bash
git clone https://github.com/JonathanReiss15/familysearch-mcp.git
cd familysearch-mcp
npm install
npm run build
```

### 2. Log in to FamilySearch

```bash
npm run login
```

This opens Brave with a dedicated profile. Sign in when prompted. Your session is saved to `~/.familysearch-mcp/config.json`.

> **Tip:** You can also ask your AI assistant to run the `login-with-browser` tool after the MCP is connected.

### 3. Configure your MCP client

Add the server to your client using **stdio** transport. Replace `/path/to/familysearch-mcp` with the absolute path to this repo.

**Recommended config** (uses `cwd` so you don't need absolute paths in `args`):

```json
{
  "mcpServers": {
    "familysearch": {
      "command": "node",
      "args": ["build/index.js"],
      "cwd": "/path/to/familysearch-mcp"
    }
  }
}
```

Run `npm run build` whenever you pull changes.

---

## MCP client setup

### Cursor

**Project-scoped** — create `.cursor/mcp.json` in your project (or add globally in **Cursor Settings → MCP**):

```json
{
  "mcpServers": {
    "familysearch": {
      "command": "node",
      "args": ["build/index.js"],
      "cwd": "/path/to/familysearch-mcp"
    }
  }
}
```

Restart Cursor or reload MCP servers after saving.

### Claude Desktop

Edit `claude_desktop_config.json`:

| Platform | Config path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "familysearch": {
      "command": "node",
      "args": ["build/index.js"],
      "cwd": "/path/to/familysearch-mcp"
    }
  }
}
```

Restart Claude Desktop after saving.

### Claude Code

From the repo directory:

```bash
claude mcp add familysearch -- node build/index.js
```

Or with an absolute path from anywhere:

```bash
claude mcp add familysearch -- node /path/to/familysearch-mcp/build/index.js
```

Verify with `claude mcp list`.

### Codex

From the repo directory (after `npm run build`):

```bash
codex mcp add familysearch -- node build/index.js
```

Or add to `~/.codex/config.toml`:

```toml
[mcp_servers.familysearch]
command = "node"
args = ["build/index.js"]
cwd = "/path/to/familysearch-mcp"
```

Use `/mcp` in Codex to confirm the server is connected.

This repo also includes `.codex/config.toml` for project-scoped config when the directory is trusted.

### VS Code

Add to your user MCP config (**Command Palette → `MCP: Open User Configuration`**) or `.vscode/mcp.json` in a workspace:

```json
{
  "servers": {
    "familysearch": {
      "command": "node",
      "args": ["build/index.js"],
      "cwd": "/path/to/familysearch-mcp"
    }
  }
}
```

### Windows

If `node` is not found, use the full path to your Node executable. For clients that struggle with direct `node` invocation, wrap with `cmd`:

```json
{
  "mcpServers": {
    "familysearch": {
      "command": "cmd",
      "args": ["/c", "node", "build/index.js"],
      "cwd": "C:\\path\\to\\familysearch-mcp"
    }
  }
}
```

---

## Authentication

### Option 1: Browser login (recommended)

```bash
npm run login
```

Opens Brave (not headless Chromium) to avoid FamilySearch bot detection.

### Option 2: Copy cookies manually

1. Log in at [familysearch.org](https://www.familysearch.org)
2. In DevTools → Console, run: `copy(document.cookie)`
3. Use the `set-session-cookie` MCP tool with the copied string

The full cookie string is required — bot protection cookies like `reese84` and `incap_ses_*` must be included, not just `fssessionid`.

---

## Tools

| Tool | Description |
|---|---|
| `login-with-browser` | Open Brave, log in, and save session locally |
| `set-session-cookie` | Authenticate by pasting cookies from your browser |
| `get-current-user` | View your authenticated account info |
| `search-persons` | Search individuals in the Family Tree |
| `get-person` | Get details for a person by ID |
| `get-ancestors` | View ancestors (default 4 generations, max 8) |
| `get-descendants` | View descendants (default 2 generations, max 3) |
| `get-family` | View parents, siblings, spouses (with marriage date and place) and children of a person |
| `get-research-suggestions` | List ancestors (and the root person's children) with pending record hints or research suggestions such as missing sources or vital dates |
| `search-records` | Search historical record collections by name, gender, birth/death/marriage year ranges and places, residence or any place, spouse and parent names, record country or collection (`limit` up to 100, `offset` for paging). Hits show the collection, facts with places and related persons |
| `get-record` | View a historical record by persona ID: collection, citation, image link, all persons and their relationships |

### Example prompts

```
Search for persons named "John Smith" born in "New York"
```

```
Get person with personId G2KQ-JTH
```

```
Get 4 generations of ancestors for personId G2KQ-JTH
```

```
Search historical records for surname "Reiss" in "Pennsylvania"
```

```
Show the family of personId G2KQ-JTH
```

```
Which of my ancestors have record hints? Start at personId G2KQ-JTH, 6 generations
```

```
Search records for births 1880-1900 with father surname "Reiss" in Germany, then show the full record of the best match
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Not authenticated" errors | Run `npm run login` or use `set-session-cookie` |
| Session expired / 401 errors | Re-run `npm run login` |
| "Request blocked by FamilySearch security (error 15)" | Re-run `npm run login` to refresh bot-protection cookies |
| Brave not found | Install [Brave](https://brave.com/download/) or set `BRAVE_PATH` to your Brave executable |
| MCP tools not appearing | Confirm `npm run build` succeeded and restart your MCP client |
| `node` not found | Use the full path to your Node binary in the MCP config |

---

## Security

- Session cookies are stored locally in `~/.familysearch-mcp/config.json`
- They grant the same access as your browser session — **never share this file**
- Sessions expire after inactivity; re-authenticate when tools return auth errors
- This server runs locally over stdio; no data is sent to third parties

## License

MIT
