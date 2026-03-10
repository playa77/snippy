# Snippy v1.1.9

Desktop client for managing a remote VPS running [OpenClaw](https://openclaw.ai).

## Install

Download the latest release from the [Releases](../../releases) page:

- **AppImage** — make executable and run: `chmod +x Snippy-*.AppImage && ./Snippy-*.AppImage`
- **deb** — install with: `sudo dpkg -i snippy_*.deb`

Both packages work as a normal (non-root) user with no manual steps.

## Build from source

```bash
git clone <repo-url> && cd snippy
npm install
npm start                # run in dev mode
npm run build:appimage   # build AppImage
npm run build:deb        # build .deb package
npm run build:all        # build both
```

## Features

**Dual SSH Terminals** — Two tabs: AGENT runs a configurable command (default: `openclaw tui`) with automatic reconnection on disconnect (exponential backoff, gives up after 5 attempts). VPS provides a plain SSH shell for admin work. Supports password and SSH key authentication.

**Copy and Paste** — Ctrl+Shift+C / Ctrl+Shift+V in terminals. Right-click context menu for copy/paste works everywhere in the app — terminals, input fields, text editors, settings.

**SFTP File Manager** — FILES tab provides full access to the workspace directory (default: `~/.openclaw/workspace`, configurable). Browse directories, view and edit text files in-app, create and rename files and directories, delete, upload from local machine, download to local machine. Upload and download use native OS file dialogs.

**Gateway Health and Control** — Status LED in the header polls the OpenClaw gateway (default: `localhost:18789`) every 5 seconds. Start, stop, and restart buttons with confirmation dialogs. Every gateway action opens a live log window showing real-time command output, which stays open until dismissed.

**Settings** — Gear icon opens a settings panel. Configurable: VPS host, port, username, password, SSH key path, agent command, workspace path, gateway host and port. All settings persist to disk across sessions.

**Font Size** — A+ / A- buttons in the header scale the entire UI including terminal font size. Persists across sessions.

**Close Confirmation** — Closing the window always prompts a confirmation dialog.

## Configuration

Settings are stored in `~/.config/snippy/snippy-config.json` (Linux). Edit via the in-app settings panel or directly in the JSON file.

## License

MIT
