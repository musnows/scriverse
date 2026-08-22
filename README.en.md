<p align="center">
  <a href="https://scriverse.top/">
    <img src="./showcase/public/favicon.svg" alt="Scriverse" width="96">
  </a>
</p>

<h1 align="center">Scriverse</h1>

<p align="center">
  A local AI-assisted writing workspace for long-form fiction
</p>

<p align="center">
  <a href="README.md">中文</a> | English
</p>

<p align="center">
  Scriverse is a local AI-assisted writing workspace for long-form fiction. It keeps manuscript text, volumes, characters, organizations, worldbuilding, timelines, relationship graphs, outlines, foreshadowing, and AI assistance in one project. It is designed for large, continuity-heavy novel projects.
</p>

<p align="center">
  Live demo: <a href="https://scriverse.top/">https://scriverse.top/</a>
</p>

## Features

- Work shelf for multiple novels, covers, authors, and descriptions.
- Manuscript editor with a volume/chapter tree, autosave, version history, line citations, blank-line normalization, and full-text search.
- Four chapter types: manuscript, setting, author's note, and other.
- TXT and DOCX import with volume, chapter, and postscript recognition.
- Setting library with character aliases, attributes, and locked fields.
- Organizations with descriptions, setting lists, and multi-organization character membership.
- Kanban-style timelines with multiple event tracks, split, merge, and ordering operations.
- Character relationships with categories, keyword lists, evidence, confidence, a standard graph, and an interactive 3D galaxy view.
- Chapter outlines and foreshadowing setup, reminder, and payoff tracking.
- Streaming AI chat with Markdown rendering, chapter line citations, and optional character or setting context.
- AI tasks for structure, chapters, character extraction, timelines, relationships, and consistency checks.
- OpenAI Chat Completions-compatible providers with configurable models, maximum output tokens, concurrency, and RPM.
- JSON, TXT, and Markdown export without AI credentials.

## Technology

- Node.js 22.5+
- TypeScript
- Express 5
- Node.js SQLite
- Vanilla HTML, CSS, and JavaScript
- Vitest and Supertest

## Quick Start

### Requirements

- Node.js `>= 22.5.0`
- npm

### Install and run for development

```bash
git clone git@github.com:musnows/Scriverse.git
cd Scriverse
npm ci
npm run dev
```

Open [http://localhost:13210](http://localhost:13210).

### Production build

```bash
npm run build
npm start
```

### Docker deployment

The official `musnows/scriverse` image supports `linux/amd64` and `linux/arm64`. See the [Docker deployment guide](docs/docker-deployment.en.md) for a complete Compose configuration, first-administrator setup, persistence, upgrades, backups, logs, health checks, and HTTPS reverse proxy guidance.

### Command-line client

The CLI can start Scriverse locally or connect to any running server to query and edit work data. Install it globally to use the `scriverse` command:

```bash
npm install --global @musnows/scriverse
scriverse serve --data-dir ./scriverse-data
```

`serve` listens on `http://127.0.0.1:13210` by default. Starting a local server is not required for the other CLI commands; you can save a remote server as the default target:

```bash
scriverse connect https://your-scriverse.example.com
scriverse auth login --api-key-file ./api-key.txt
scriverse work list
```

The CLI stores credentials per server. Every data command accepts `--server <url>` to override the default for that invocation, for example `scriverse work list --server https://another.example.com`; authenticate to that server first with `auth login --server <url>`. Run `scriverse connect` to show the current default server.

Run `scriverse --help` for all local server, default server, authentication, work, manuscript, resource, history, and search commands. The CLI requires Node.js `>= 22.5.0`.

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `13210` | HTTP server port |
| `HOST` | `127.0.0.1` | Listen address; use `0.0.0.0` for a server deployment |
| `DATA_DIR` | `<project>/.data` | Default data directory |
| `DATABASE_PATH` | `<DATA_DIR>/novel.db` | SQLite database path |
| `AI_NOVEL_MASTER_KEY` | Generated and stored at `<DATA_DIR>/master.key` | Master key used to encrypt AI provider credentials; at least 32 characters when configured manually |
| `SCRIVERSE_AI_RETRY_COUNT` | `3` | Retry count for AI upstream HTTP errors other than `403`, `429`, and `502`; valid integers are clamped to `1`–`20` |
| `SCRIVERSE_AI_BACKOFF_RETRY_COUNT` | `10` | Backoff retry count when an AI upstream returns `429` or `502`; valid integers are clamped to `1`–`20` |
| `SCRIVERSE_AI_STREAM_IDLE_TIMEOUT_SECONDS` | `30` | Maximum idle time while an interactive AI stream waits for its first or next valid event; valid integers are clamped to `10`–`120`, and invalid values fall back to `30` |
| `APP_AUTH_USERNAME` | Empty | Optional deployment gateway username; the in-app user system is always enabled |
| `APP_AUTH_PASSWORD` | Empty | Optional deployment gateway password, at least 12 characters; must be transported over HTTPS |
| `APP_TRUST_PROXY` | `false` | Set to the trusted proxy hop count (usually `1`) or `true` behind a trusted reverse proxy |
| `APP_ALLOW_PRIVATE_AI_ENDPOINTS` | `true` in development, `false` in production | Loopback and private-network AI provider URLs are blocked by default. Setting `true`/`1` allows them with a warning toast and a startup warning log; link-local and cloud metadata addresses stay blocked |
| `APP_ALLOW_REGISTRATION` | `false` | Registration is enabled only when explicitly set to `true`; unset and all other values stay closed, including first-admin setup |
| `APP_SETUP_TOKEN` | Empty | Required when registration is enabled and must contain at least 32 characters; only the first administrator must enter it |

`APP_ALLOW_PRIVATE_AI_ENDPOINTS` weakens SSRF protection and should be enabled only when you must reach a trusted local or private-network model. Unset production deployments keep blocking these addresses; when enabled, connection tests no longer fail for that reason, the UI shows a warning, and startup writes a warning log. Link-local and cloud metadata addresses remain blocked.

`SCRIVERSE_AI_STREAM_IDLE_TIMEOUT_SECONDS` is read when the service starts and only controls how long an interactive AI stream may remain without a new event. Every valid stream event restarts the timer, so generation may continue beyond 60 seconds; this setting does not impose a total-duration limit or change timeout behavior for analysis tasks and other AI requests. Restart the service after changing it.

The AI upstream HTTP retry settings are read when the service starts. `403` is never retried. `429` and `502` use exponential backoff starting at 500 milliseconds and capped at 5 seconds, honoring a numeric `Retry-After` within the same cap; other HTTP errors use a linear delay. Invalid values fall back to their defaults. Restart the service after changing either setting.

Custom configuration example:

```bash
PORT=13211 DATA_DIR=/path/to/scriverse-data npm run dev
```

Server deployment example:

```bash
NODE_ENV=production \
HOST=0.0.0.0 \
APP_AUTH_USERNAME=admin \
APP_AUTH_PASSWORD='replace-with-a-long-random-password' \
npm start
```

Production deployments must use HTTPS at a trusted reverse proxy. For first-time setup, set `APP_ALLOW_REGISTRATION=true` and configure `APP_SETUP_TOKEN` with at least 32 random characters. The first registered user must enter that token and becomes the system administrator. Afterwards, remove both variables or disable registration and restart the service. Later ordinary registrations do not require the setup token. Optional HTTP Basic Auth is only an additional deployment gateway, and its credentials are merely Base64 encoded. `/api/health` remains public for health checks, while business APIs require an in-app login.

## AI Provider Setup

1. Start Scriverse and open the top-level **AI Management** page.
2. Add an OpenAI Chat Completions-compatible provider with its base URL, API key, concurrency, RPM, and maximum output tokens.
3. Add models with their supported context-window size in tokens.
4. Set a platform-wide system prompt; it is appended after Scriverse's built-in prompt.
5. In a work, open **More → AI Settings** to set the work-specific appended system prompt and default models. The work prompt is appended after the platform prompt.

New providers default to `10` concurrent requests, `10` RPM, and `32000` maximum output tokens. New models default to a `128000`-token context window. The chat sidebar displays a context-usage ring for the selected model.

## Data and Security

- Application data is stored in `.data/novel.db` by default.
- AI provider credentials are encrypted. The default master key is `.data/master.key`.
- Back up both the database and the master key. Existing provider credentials cannot be decrypted if the master key is lost.
- Scriverse includes an in-app multi-user system, and the first registered user becomes an administrator. HTTP Basic Auth is an optional additional deployment gateway and does not replace application login.
- The server listens on `127.0.0.1` by default. Non-loopback listening also requires authentication. Public entry points must use HTTPS, a trusted reverse proxy, and firewall access controls.
- CSP, clickjacking protection, MIME sniffing protection, same-origin write validation, authentication and API rate limits, body/upload limits, and AI-provider SSRF protection are enabled by default.
- SQLite values are bound through prepared statements. Dynamic SQL fragments are limited to server-controlled branches and never contain request input.

## Testing

```bash
# Type checking
npm run typecheck

# All Vitest tests
npm test

# Unit, integration, and system suites
npm run test:unit
npm run test:integration
npm run test:system

# Real end-to-end tests against a running server
npm run test:e2e:real

# Type checking, all tests, and a production build
npm run check
```

`test:e2e:real` uses `http://127.0.0.1:13210/api` by default. Set `E2E_BASE_URL` when the server runs elsewhere:

```bash
E2E_BASE_URL=http://127.0.0.1:13211/api npm run test:e2e:real
```

## Project Structure

```text
src/
  ai.ts                  AI calls, context building, and task orchestration
  app.ts                 Express API and static UI entry point
  database.ts            SQLite schema and migrations
  parser.ts              TXT/DOCX novel structure parser
  server.ts              Server startup and shutdown
  store.ts               Application data access
  public/                Browser UI and visualizations
tests/
  unit/                  Unit tests
  integration/           API and data integration tests
  system/                Complete author workflow tests
  e2e/                   End-to-end tests against a running server
```

## Health Check

```bash
curl http://127.0.0.1:13210/api/health
```

Expected response:

```json
{
  "data": {
    "status": "ok",
    "version": "0.3.3",
    "protocol": "openai-chat-completions"
  }
}
```

## Project Status

Scriverse is currently an MVP. APIs and data structures may still change. Back up the `.data` directory before upgrading.

## Contributing

Read the [contribution guide](docs/CONTRIBUTING.md) before submitting code or documentation. Start everyday changes from the latest `develop` branch and merge them through a Pull Request targeting `develop`.

## License

Copyright (C) 2026 musnows

Except for third-party components identified separately, the project is licensed from this license change onward under the [GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`). You may use, modify, distribute, or commercialize the software, but distributed derivative versions must continue to provide their corresponding source under AGPLv3. Modified versions that interact with users over a network must also offer those users the corresponding source of that version.

Versions published before this license change remain under the license included with their respective releases.

## 🌟 Special Thanks

Thanks to the open-source [Vditor](https://github.com/Vanessa219/vditor) project for providing the Markdown editor, instant rendering, and split preview capabilities used by Scriverse.

<p align="center">
  <a href="https://linux.do">
    <img src="showcase/public/linuxdo.png" alt="LINUX DO" width="420" />
  </a>
</p>
<p align="center"><b>学AI，上L站！祝小破站越来越好～</b></p>
