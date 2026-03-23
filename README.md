# 🦞 OpenClaw Deploy

Web UI for deploying [OpenClaw](https://github.com/nichochar/openclaw) AI agents to [Nebius Cloud](https://nebius.com).

## Features

- **One-click deploy** — Choose agent, model, region, provider and deploy
- **Multi-provider** — Token Factory, OpenRouter, or HuggingFace (all routed through Nebius GPUs)
- **In-browser terminal** — SSH into running endpoints via xterm.js
- **Dashboard access** — Open the OpenClaw Control UI via HTTPS reverse proxy
- **MysteryBox integration** — Load and save API keys in Nebius secrets manager
- **Endpoint management** — Start, stop, expand details, view model/resources
- **Health monitoring** — Live status badges from running endpoints
- **Multi-region** — Auto-detects Nebius CLI profiles across eu-north1, eu-west1, us-central1

## Quick Start

### Run locally

```bash
cd web
npm install
npm start
# Open http://localhost:3000
```

### Deploy to a Nebius VM

```bash
# SSH into any Nebius VM, then run the one-liner setup:
curl -sSL https://raw.githubusercontent.com/colygon/openclaw-deploy/main/setup-deploy-vm.sh | bash
```

This installs Node.js, Nebius CLI, nginx (HTTPS), generates SSH keys, creates a systemd service, and opens the app at `https://<VM_IP>`.

See the [Nebius Setup Guide](NEBIUS-SETUP-GUIDE.md#cloud-hosting-nebius-vm) for detailed cloud hosting instructions.

## Prerequisites

- **Node.js** 18+
- **Nebius CLI** installed and logged in (`nebius iam login`)
- At least one Nebius CLI profile configured (`~/.nebius/config.yaml`)

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `PORT` | `3000` | Server port |
| `SESSION_SECRET` | random | Set for persistent sessions across restarts |
| `SSH_KEY_PATH` | auto-detect | Path to SSH key for endpoint access |

## Architecture

```
web/
  server.js        Express + WebSocket server (wraps Nebius CLI)
  public/
    index.html     SPA with sidebar navigation
    app.js         Frontend logic (deploy wizard, endpoints, terminal)
    style.css      Dark theme UI with responsive layout
```

The server acts as a thin wrapper around the `nebius` CLI. Authentication flows through the CLI's OAuth login — no credentials are stored in the app.

## Related Projects

- **[nebius-skill](https://github.com/colygon/nebius-skill)** — Claude Code skill for the Nebius CLI. Teaches Claude how to use `nebius` commands for managing VMs, endpoints, registries, and more.

## Guides & Documentation

| Document | Description |
|----------|-------------|
| [Nebius Setup Guide](NEBIUS-SETUP-GUIDE.md) | Comprehensive guide covering all deployment options, multi-region setup, troubleshooting |
| [Build Plan](BUILD_PLAN.md) | Original architecture plan and design decisions |
| [OpenClaw Prompt](openclaw-prompt.md) | Prompt template for installing NemoClaw locally with Token Factory |
| [Sandbox Policy](openclaw-sandbox-policy.yaml) | OpenClaw sandbox security policy for file/network access |

## Scripts

| Script | Description |
|--------|-------------|
| [`setup-deploy-vm.sh`](setup-deploy-vm.sh) | One-command VM setup (Node.js, Nebius CLI, nginx, systemd) |
| [`install-openclaw-serverless.sh`](install-openclaw-serverless.sh) | Deploy OpenClaw to Nebius serverless (CPU, Token Factory) |
| [`install-nemoclaw-serverless.sh`](install-nemoclaw-serverless.sh) | Deploy NemoClaw to Nebius serverless (CPU, Token Factory) |
| [`install-nemoclaw-vm.sh`](install-nemoclaw-vm.sh) | Deploy NemoClaw to a Nebius GPU VM (local vLLM inference) |
| [`deploy-cloud.sh`](deploy-cloud.sh) | Provision a VM and deploy the web UI to it |
| [`entrypoint.sh`](entrypoint.sh) | Container entrypoint for OpenClaw serverless image |
| [`healthcheck.sh`](healthcheck.sh) | Container health check script |

## Deployment Options

| Option | GPU | Inference | Best For |
|--------|-----|-----------|----------|
| **OpenClaw Serverless** | No (cpu-e2) | Token Factory | Lightest, cheapest |
| **NemoClaw Serverless** | No (cpu-e2) | Token Factory | Agent orchestration, no GPU |
| **NemoClaw GPU VM** | H100/H200 | Local vLLM | Full self-hosted, max control |
| **Web Deploy UI** | Any | Token Factory / OpenRouter / HuggingFace | Browser-based multi-region deploy |

See the [Nebius Setup Guide](NEBIUS-SETUP-GUIDE.md) for detailed instructions on each option.

## Security

- **CLI auth** — authenticates via your existing Nebius CLI session (OAuth)
- **No stored secrets** — API keys are passed to endpoints at deploy time, not persisted
- **HTTPS** — nginx reverse proxy with SSL for cloud deployments
- **Input validation** — all user inputs validated before use in CLI commands
- **XSS protection** — all dynamic content is HTML-escaped

## License

MIT
