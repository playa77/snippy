# Snippy v0.1.0

Desktop client for remote OpenClaw VPS management.

## Setup

```bash
cd snippy
npm install
npm start
```

## What's in v0.1.0

- SSH terminal with two tabs: **AGENT** (runs `openclaw tui`, auto-reconnects with exponential backoff, gives up after 5 attempts) and **VPS** (plain shell)
- Password-based SSH authentication
- SSH key authentication (enter path in settings — coming in v0.5.0, for now edit `config` in main.js)
- Connection status LEDs per tab
- Terminal auto-resizes with window
- Quick-connect bar for entering credentials

## What's next

- v0.2.0 — Copy/paste support
- v0.3.0 — File manager
- v0.4.0 — Gateway health indicator + switch
- v0.5.0 — Settings UI with persistence
- v0.6.0 — Font size controls
