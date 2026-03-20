# Channels

Telegram control plane for local Codex threads.

## Workspace

- `apps/control-plane`: Railway-hosted Telegram webhook + agent hub
- `apps/mac-agent`: macOS companion that talks to local Codex app-server
- `packages/shared`: shared protocol, helpers, and policies

## What This Ships

- Private DM Telegram bot for project and thread control
- Hybrid architecture: Railway hosts the control plane, your Mac runs Codex
- Live turn streaming and real `Stop` interrupts through the Codex app-server
- Mostly-automatic approvals with Telegram escalation for out-of-policy actions
- Local project registry in `~/.channels/projects.json`
- macOS LaunchAgent installer for the local companion

## Local Development

1. `pnpm install`
2. `pnpm build`
3. Copy `apps/control-plane/.env.example` values into your shell or Railway service
4. Start the control plane:
   `pnpm dev:control-plane`
5. Import your projects on the Mac:
   `node apps/mac-agent/dist/cli.js import-projects --root /Users/amir/Downloads/Whims`
6. In Telegram, use `/pair` to generate a code
7. Pair the local agent:
   `node apps/mac-agent/dist/cli.js pair --server-url <wss-url> --pair-code <code>`

## One-Command macOS Install

After building, install the LaunchAgent so the local companion starts on login:

```bash
node apps/mac-agent/dist/cli.js install --server-url <wss-url>
```

If you want the optional desktop refresh helper, turn it on during install:

```bash
node apps/mac-agent/dist/cli.js install --server-url <wss-url> --ui-refresh --ui-refresh-strategy deeplink-activate
```

Useful follow-up commands:

```bash
node apps/mac-agent/dist/cli.js doctor
node apps/mac-agent/dist/cli.js run --server-url <wss-url>
node apps/mac-agent/dist/cli.js refresh-ui --thread-id <thread-id>
```

If `launchd` cannot find the Codex binary on your machine, set `CHANNELS_CODEX_BIN` to the full path. The mac-agent also auto-detects common macOS Codex install locations, including `/Applications/Codex.app/Contents/Resources/codex`.

## Optional macOS Desktop Refresh Helper

The Codex desktop app does not expose an official "refresh this open thread UI" API. Channels includes an opt-in, best-effort macOS helper for this using the app's `codex://threads/<threadId>` deep link and, if you choose, AppleScript activation.

- `deeplink`: re-opens the thread in the background without trying to focus Codex
- `deeplink-activate`: re-opens the thread and brings Codex to the foreground
- `applescript`: more aggressive AppleScript/System Events focus flow; this is the most fragile option

Defaults and behavior:

- The helper is off by default
- Even when enabled, it skips refreshes if Codex is closed unless you pass `--open-codex-when-closed`
- `deeplink-activate` is the recommended starting point
- `applescript` may need macOS Accessibility permission for `System Events`

You can test the helper manually against a known thread id:

```bash
node apps/mac-agent/dist/cli.js refresh-ui --thread-id <thread-id> --strategy deeplink-activate
```

## Railway Variables

Control-plane variables:

- `PORT`
- `PUBLIC_BASE_URL`
- `DATABASE_URL`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_OWNER_ID`
- `TELEGRAM_WEBHOOK_SECRET`
- `PAIR_CODE_TTL_SECONDS`
- `AGENT_HEARTBEAT_STALE_SECONDS`

The control plane can boot without Telegram or Postgres so the first deploy succeeds, but full bot pairing and persistence need those variables set.

## Verification

Validated locally:

- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- local control-plane health boot
- live Codex app-server `thread/list` handshake from the mac-agent client
