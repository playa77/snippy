# Snippy v1.0.0

Desktop client for remote OpenClaw VPS management.

## Setup

```bash
cd snippy
npm install
npm start
```

## Features

**Terminal** — Two SSH tabs: AGENT (runs configurable command, auto-reconnects with exponential backoff up to 5 attempts) and VPS (plain shell). Password and key-based auth.

**Copy/Paste** — Ctrl+Shift+C to copy selected text, Ctrl+Shift+V to paste. Right-click context menu also available in both terminals.

**File Manager** — FILES tab provides full SFTP access to the workspace directory. Browse, view/edit text files, create files and directories, rename, delete, upload from local machine, download to local machine. Native OS file dialogs for upload/download.

**Gateway Health** — LED in the header polls the OpenClaw gateway every 5 seconds. Start/stop/restart buttons beside the LED.

**Settings** — Gear icon opens a settings panel. Configurable: host, port, username, password, SSH key path, agent command, workspace path, gateway host/port. All settings persist to disk across sessions.

**Font Size** — A+/A- buttons in the header scale the entire UI and terminal font size. Persists across sessions.

**Close Confirmation** — Closing the window with active SSH sessions prompts a confirmation dialog.
