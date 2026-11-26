# FamilySearch MCP Server

A local [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server for [FamilySearch](https://www.familysearch.org). Gives AI assistants access to your Family Tree (people, pedigrees, sources, memories, notes, change history, and how you're related to anyone), FamilySearch's research aids (record hints and data-quality checks), and its historical records (indexed records, full-text document search, record collections, and the library catalog).

## Features

- **Family Tree** — search people; full person view with facts and immediate family; ancestors (up to 8 generations) and descendants (up to 4) in a single call
- **Your connection** — how you're related to any person, with the full path; most tools default to your own tree person
- **Evidence** — attached sources, full historical records (everyone on a census page, marriage entry, etc.), memories, notes, and change history with contributors' reasons
- **Research aids** — FamilySearch's record hints and data-quality issues (date conflicts, name mismatches, untagged facts)
- **Historical records** — indexed record search with spouse/parent/residence matching and paging, full-text search of handwritten documents, collection finder, and library catalog search
- **Standardization** — match place names and interpret genealogical dates ("abt 1869") the way FamilySearch does
- **Browser session auth** — log in once with Brave; no FamilySearch API key required

## How it works

FamilySearch does not approve direct API access for most personal projects. This server reuses your **browser session cookies** and calls the same endpoints the website uses: internal `/service/` endpoints plus FamilySearch's official GEDCOM X `/platform/` API, which accepts the browser session as a bearer token. Your session is stored locally at `~/.familysearch-mcp/config.json`.

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
| `get-current-user` | Your account: name, email, and own tree person ID (also confirms the session is valid) |
| `search-persons` | Search individuals in the Family Tree |
| `get-person` | Names, all facts, parents, siblings, spouses (with marriage), and children |
| `get-ancestors` | Pedigree, Ahnentafel-numbered (default 4 generations, max 8) |
| `get-descendants` | Descendants with spouses (default 2 generations, max 4) |
| `relationship-to-me` | How you're related to a person, with the full path |
| `get-sources` | Sources attached to a person, with record IDs |
| `get-record` | A full historical record: every person on it, ages, relationships, events |
| `get-memories` | Photos, stories, and documents attached to a person |
| `get-notes` | Research notes on a person |
| `get-change-history` | Who changed a person, when, and why |
| `get-record-hints` | FamilySearch's suggested matching records |
| `get-data-quality` | Quality scores and specific issues (conflicts, missing sources) |
| `search-records` | Search indexed historical records (names, dates, places, spouse, parents, collection; paged) |
| `search-fulltext` | Search the text of handwritten documents (wills, deeds); quote phrases for exact match |
| `search-collections` | Find record collections by keyword and/or year covered |
| `search-catalog` | Search the FamilySearch Library catalog |
| `standardize-place` | Match a place name to FamilySearch's standard places |
| `standardize-date` | Interpret a genealogical date into standard form |

Tools that take a `personId` marked optional default to your own tree person.

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
How am I related to person G2KQ-JTH?
```

```
Show the sources attached to G2KQ-JTH, then open the 1870 census record
```

```
Find full-text documents mentioning "John Smith"
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Not authenticated" errors | Run `npm run login` or use `set-session-cookie` |
| "Session is not signed in or has expired" | Re-run `npm run login`, then reconnect the MCP server |
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
