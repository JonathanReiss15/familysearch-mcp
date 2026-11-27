# FamilySearch MCP Server

A local [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server for [FamilySearch](https://www.familysearch.org). Gives AI assistants access to search the Family Tree, view person details, explore ancestors and descendants, and search historical records.

## Features

- **Family Tree search** — find individuals by name, dates, places, and gender
- **Person details** — view a person card by ID
- **Pedigree exploration** — ancestors (up to 8 generations) and descendants (up to 3)
- **Historical records** — search record collections
- **Record images** — list a digitized film's images, view them, and save them as full-resolution JPGs
- **Browser session auth** — log in once with Brave; no FamilySearch API key required

## How it works

FamilySearch does not approve direct API access for most personal projects. This server reuses your **browser session cookies** and calls the same internal `/service/` endpoints the website uses. Your session is stored locally at `~/.familysearch-mcp/config.json`.

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
| `search-records` | Search historical record collections |
| `get-film-images` | List a digitized film's images (DGS / image group number): catalog titles and image ARKs in viewer order |
| `view-image` | Return one image inline (scaled, default 1600 px wide) for reading or transcription; no file is saved |
| `download-image` | Save one image as a full-resolution JPG |
| `download-film-images` | Save a range of a film's images (up to 200 per call, with a pause between requests; files already saved are skipped) |

### Record images

Images are addressed by their ARK (`3:1:XXXX-XXXX-XXXX-X`, or the viewer URL `https://www.familysearch.org/ark:/61903/3:1:…`) or by film plus image number. The image number is the 1-based "Image N of M" the viewer shows; a `/search/film/…?i=11` URL is image 12.

Files are named `<DGS>_<image number>.jpg` and saved to `outputDir`, or by default to `$FAMILYSEARCH_DOWNLOAD_DIR/<DGS>/` (falling back to `~/Downloads/familysearch/<DGS>/`).

FamilySearch marks many images view-only (`allowDownload=false`): the site shows them but disables Download. The download tools refuse such images and point to `view-image`. Passing `ignoreDownloadRestriction: true` saves them anyway; that goes against FamilySearch's download setting and is at your own risk. Images your account may not view are never fetched.

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
Show image 12 of film 007819272 and transcribe the births on it
```

```
Download images 10-40 of film 007819272 to ~/research/scans
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
