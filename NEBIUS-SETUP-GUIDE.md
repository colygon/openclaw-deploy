# NemoClaw / OpenClaw on Nebius Cloud

Three deployment options for running AI coding agents on Nebius Cloud, plus a web UI for one-click deployment.

| Option | Script | GPU | Inference | Best For |
|---|---|---|---|---|
| A. OpenClaw Serverless | `install-openclaw-serverless.sh` | No (cpu-e2) | Token Factory | Lightest, cheapest, quick setup |
| B. NemoClaw Serverless | `install-nemoclaw-serverless.sh` | No (cpu-e2) | Token Factory | NemoClaw sandbox + agent orchestration, no GPU |
| C. NemoClaw GPU VM | `install-nemoclaw-vm.sh` | Yes (H100/H200) | Local vLLM | Full self-hosted inference, max control |
| D. Web Deploy UI | `web/server.js` | Any | Token Factory | Browser-based multi-region deploy + terminal |

---

## Option A: OpenClaw Serverless (cpu-e2, no GPU)

Lightweight deployment of OpenClaw only. No NemoClaw plugin, no GPU. Inference is routed to Nebius Token Factory.

### Quick Start

```bash
# 1. Install Nebius CLI
curl -sSL https://storage.ai.nebius.cloud/nebius/install.sh | bash

# 2. Authenticate
nebius iam whoami

# 3. Get a Token Factory API key at https://tokenfactory.nebius.com

# 4. Deploy
export TOKEN_FACTORY_API_KEY="v1.xxx..."
./install-openclaw-serverless.sh
```

### What It Does

1. Creates a container registry in your Nebius project
2. Builds a Docker image with OpenClaw (linux/amd64)
3. Pushes to Nebius Container Registry
4. Deploys on `cpu-e2` (Intel Ice Lake, 2 vCPU, 8 GB RAM)
5. Exposes health check on port 8080 and gateway on port 18789

### Architecture

```
┌─────────────────────────────────────────┐
│  Nebius Endpoint (cpu-e2, no GPU)       │
│  ┌────────────────────────────────────┐ │
│  │  OpenClaw Container               │ │
│  │  ├── Health check (:8080)         │ │
│  │  ├── Gateway (:18789)             │ │
│  │  └── Agent runtime               │ │
│  └────────────────────────────────────┘ │
│           │                             │
│           ▼ (OpenAI-compatible API)     │
│  Token Factory (hosted inference)       │
│  └── deepseek-ai/DeepSeek-R1-0528     │
└─────────────────────────────────────────┘
```

### Connect to the Agent

```bash
# Via TUI (interactive terminal chat)
openclaw tui --url ws://<PUBLIC_IP>:18789

# Health check
curl http://<PUBLIC_IP>:8080
```

### Manage

```bash
nebius ai endpoint list
nebius ai endpoint logs <ENDPOINT_ID>
nebius ai endpoint stop <ENDPOINT_ID>
nebius ai endpoint delete <ENDPOINT_ID>
```

---

## Option B: NemoClaw Serverless (cpu-e2, no GPU)

Deploys the full NemoClaw stack (OpenClaw + NVIDIA NemoClaw plugin) on a CPU-only serverless endpoint. Inference is routed to Nebius Token Factory — no GPU quota needed.

This is the right choice when you want NemoClaw's sandbox orchestration and agent capabilities without paying for a dedicated GPU VM.

### Quick Start

```bash
# 1. Install Nebius CLI
curl -sSL https://storage.ai.nebius.cloud/nebius/install.sh | bash

# 2. Authenticate
nebius iam whoami

# 3. Get a Token Factory API key at https://tokenfactory.nebius.com

# 4. Deploy
export TOKEN_FACTORY_API_KEY="v1.xxx..."
./install-nemoclaw-serverless.sh
```

### What It Does

1. Creates a container registry in your Nebius project
2. Builds a Docker image with OpenClaw + NemoClaw plugin (linux/amd64)
3. Pushes to Nebius Container Registry
4. Deploys on `cpu-e2` (Intel Ice Lake, 2 vCPU, 8 GB RAM)
5. Exposes health check on port 8080 and gateway on port 18789

### Architecture

```
┌─────────────────────────────────────────┐
│  Nebius Endpoint (cpu-e2, no GPU)       │
│  ┌────────────────────────────────────┐ │
│  │  NemoClaw Container               │ │
│  │  ├── OpenClaw runtime             │ │
│  │  ├── NemoClaw plugin (sandbox)    │ │
│  │  ├── Health check (:8080)         │ │
│  │  └── Gateway (:18789)             │ │
│  └────────────────────────────────────┘ │
│           │                             │
│           ▼ (OpenAI-compatible API)     │
│  Token Factory (hosted inference)       │
│  └── deepseek-ai/DeepSeek-R1-0528     │
└─────────────────────────────────────────┘
```

### Connect to the Agent

```bash
# Via TUI (interactive terminal chat)
openclaw tui --url ws://<PUBLIC_IP>:18789

# Health check
curl http://<PUBLIC_IP>:8080
```

### Manage

```bash
nebius ai endpoint list
nebius ai endpoint logs <ENDPOINT_ID>
nebius ai endpoint stop <ENDPOINT_ID>
nebius ai endpoint delete <ENDPOINT_ID>
```

---

## Option C: NemoClaw GPU VM (H100/H200)

Full GPU VM with local inference via vLLM. The model runs directly on the GPU — no external API calls, full privacy, lowest latency.

### Quick Start

```bash
# 1. Install Nebius CLI
curl -sSL https://storage.ai.nebius.cloud/nebius/install.sh | bash

# 2. Authenticate
nebius iam whoami

# 3. Deploy
./install-nemoclaw-vm.sh
```

### What It Does

1. Creates a boot disk with Ubuntu 22.04 + CUDA 12
2. Finds or creates a VPC subnet
3. Launches a GPU VM (H200 by default, 141 GB VRAM)
4. Cloud-init installs OpenClaw + vLLM + model weights
5. Starts vLLM server on port 8000, OpenClaw gateway on port 18789

### Architecture

```
┌───────────────────────────────────────────┐
│  Nebius GPU VM (gpu-h200-sxm)             │
│  ┌──────────────────────────────────────┐ │
│  │  OpenClaw + NemoClaw                 │ │
│  │  ├── Gateway (:18789)               │ │
│  │  ├── Agent runtime                  │ │
│  │  └── Sandbox (code execution)       │ │
│  └──────────┬───────────────────────────┘ │
│             │                             │
│  ┌──────────▼───────────────────────────┐ │
│  │  vLLM (:8000)                        │ │
│  │  └── Nemotron 70B on H200 GPU       │ │
│  └──────────────────────────────────────┘ │
└───────────────────────────────────────────┘
```

### Connect to the Agent

```bash
# SSH into the VM (username is "nebius", not root/ubuntu/admin)
ssh -i ~/.ssh/id_ed25519_vm nebius@<PUBLIC_IP>

# Start OpenClaw (after bootstrap finishes)
openclaw gateway &
openclaw tui

# Or connect remotely from your machine
openclaw tui --url ws://<PUBLIC_IP>:18789
```

### GPU Platforms

| Platform | GPU | VRAM | Notes |
|---|---|---|---|
| `gpu-h100-sxm` | H100 | 80 GB | General inference |
| `gpu-h200-sxm` | H200 | 141 GB | Large models (default) |
| `gpu-b200-sxm` | B200 | 180 GB | Next-gen |
| `gpu-b300-sxm` | B300 | 288 GB | Largest |
| `gpu-l40s-pcie` | L40S | 48 GB | Cost-effective |

Presets: `1gpu-16vcpu-200gb` or `8gpu-128vcpu-1600gb`

### Manage

```bash
nebius compute instance list
nebius compute instance stop --id <INSTANCE_ID>    # pause billing
nebius compute instance start --id <INSTANCE_ID>   # resume
nebius compute instance delete --id <INSTANCE_ID>  # permanent
```

---

## Option D: Web Deploy UI

A browser-based deployment dashboard that lets you deploy OpenClaw or NemoClaw to any Nebius region with a single click, plus an in-browser SSH terminal to interact with running agents.

### Quick Start

```bash
cd web
npm install
node server.js
# Open http://localhost:3000
```

### Features

- **One-click deploy** to any region (eu-north1, eu-west1, us-central1)
- **Auto-provisioning** — automatically creates projects, registries, and CLI profiles for new regions
- **Auto-detects cheapest CPU** platform per region (cpu-e2 in eu-north1, cpu-d3 in eu-west1)
- **In-browser terminal** — SSH into any running endpoint and interact with the OpenClaw TUI directly from the browser
- **Dashboard access** — SSH tunnel to the OpenClaw web dashboard (port 18789) with one click
- **Multi-region endpoint polling** — shows all running endpoints across all regions
- **Nebius OAuth login** — authenticates via `nebius iam login` (browser-based)

### Architecture

```
┌─────────────────────────────────────────────┐
│  Your Machine (localhost:3000)               │
│  ┌────────────────────────────────────────┐ │
│  │  Express Server                        │ │
│  │  ├── REST API (deploy, endpoints)     │ │
│  │  ├── WebSocket (SSH terminal)         │ │
│  │  └── SSH Tunnel (dashboard proxy)     │ │
│  └────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────┐ │
│  │  Browser UI (xterm.js)                 │ │
│  │  ├── Deploy wizard (agent/region)     │ │
│  │  ├── Terminal (full-screen SSH)       │ │
│  │  └── Dashboard (tunneled)             │ │
│  └────────────────────────────────────────┘ │
│           │                                 │
│           ▼ SSH / nebius CLI                 │
│  ┌────────────────────────────────────────┐ │
│  │  Nebius Endpoints (multi-region)       │ │
│  │  ├── eu-north1 (cpu-e2)              │ │
│  │  ├── eu-west1  (cpu-d3)              │ │
│  │  └── us-central1 (cpu-e2)            │ │
│  └────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

---

## Nebius Container Registry

Options A and B use the Nebius Container Registry. Here's how to set it up manually:

```bash
# Create registry
nebius registry create --name openclaw --parent-id <PROJECT_ID> --format json

# Login (use IAM token)
nebius iam get-access-token | docker login cr.<REGION>.nebius.cloud --username iam --password-stdin

# Build for AMD64 (required — Nebius runs Intel/AMD CPUs)
docker buildx build --platform linux/amd64 -t cr.<REGION>.nebius.cloud/<REGISTRY_ID>/myimage:latest .

# Push
docker push cr.<REGION>.nebius.cloud/<REGISTRY_ID>/myimage:latest
```

**Regions**: `eu-north1`, `eu-west1`, `us-central1`

**Important**: If building on Apple Silicon (M1/M2/M3), always use `--platform linux/amd64`. ARM64 images will fail with `exec format error` on Nebius.

---

## Nebius Regions & CPU Platforms

Different regions have different CPU platforms. The web UI auto-detects this, but if deploying manually, you need to match the platform to the region.

| Region | CPU Platform | CPU Type | Notes |
|---|---|---|---|
| `eu-north1` | `cpu-e2` | Intel Ice Lake | Default region, most tested |
| `eu-west1` | `cpu-d3` | AMD EPYC Genoa | Does NOT have `cpu-e2` |
| `us-central1` | `cpu-e2` | Intel Ice Lake | Separate project required |

To check available platforms in a region:

```bash
nebius --profile <region-profile> compute platform list --format json
```

**Gotcha**: Deploying to eu-west1 with `--platform cpu-e2` will fail with `no platform found with name = 'cpu-e2'`. Always check what's available first.

---

## Multi-Region Profiles

Each Nebius region requires its own CLI profile with the correct project ID. The web UI creates these automatically, but here's how to set them up manually:

```bash
# List all projects across your tenant
nebius --profile eu-north1 iam project list \
  --parent-id tenant-e00zj418j5m8a78scb --format json

# Create a profile for a new region
# Edit ~/.nebius/config.yaml and add under "profiles:":
#   eu-west1:
#     endpoint: api.nebius.cloud
#     auth-type: federation
#     federation-endpoint: auth.nebius.com
#     parent-id: <project-id-in-that-region>
#     tenant-id: tenant-e00zj418j5m8a78scb
```

**Gotcha**: `nebius profile create` requires interactive input and won't work in scripts. Write directly to `~/.nebius/config.yaml` instead.

**Gotcha**: Listing projects with `nebius iam project list` is scoped to the active profile's parent. To find projects in other regions, list at the tenant level with `--parent-id <tenant-id>`.

---

## OpenClaw Gateway & Dashboard

The OpenClaw gateway runs on port 18789 inside the container and serves both WebSocket connections (for the TUI) and the web-based Control UI dashboard.

### Key Ports

| Port | Service | Exposed to Host? | Protocol |
|---|---|---|---|
| 8080 | Health check (HTTP) | Yes (Docker mapped) | HTTP |
| 18789 | Gateway + Dashboard | **No** (container only) | WS + HTTP |

### Accessing the Dashboard

Port 18789 is exposed inside the Docker container but **not mapped to the host**. You need an SSH tunnel to reach it:

```bash
# 1. SSH into the endpoint host
ssh -i ~/.ssh/id_ed25519_vm nebius@<PUBLIC_IP>

# 2. Find the container's internal IP
CONTAINER_IP=$(sudo docker inspect -f \
  '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' \
  $(sudo docker ps -q | head -1))

# 3. Set up a local proxy (socat must be installed)
sudo apt-get install -y socat
sudo socat TCP-LISTEN:28789,fork,reuseaddr TCP:$CONTAINER_IP:18789 &

# 4. From your local machine, create the SSH tunnel
ssh -L 19000:localhost:28789 -i ~/.ssh/id_ed25519_vm nebius@<PUBLIC_IP>

# 5. Open http://localhost:19000 in your browser
```

The web UI's **Dashboard** button automates all of this.

### Origin Errors

If the dashboard shows `origin not allowed`, you need to configure `allowedOrigins`:

```bash
# Inside the container:
openclaw config set gateway.controlUi.allowedOrigins \
  '["http://localhost:18789","http://127.0.0.1:18789","*"]'

# Then restart the gateway:
# Kill the old gateway process
kill $(pgrep -f openclaw-gateway)

# Start a new one (must use token auth with lan binding)
OPENCLAW_GATEWAY_TOKEN=<your-token> openclaw gateway \
  --bind lan --auth token --port 18789 &
```

**Gotcha**: The gateway refuses `--auth none` when `--bind lan` is set. You must use `--auth token` (with `OPENCLAW_GATEWAY_TOKEN` env var) or `--auth password`.

**Gotcha**: Sending `SIGHUP` to the gateway kills it — it does not gracefully reload. You need to manually restart it after config changes.

### Gateway Auth Modes

| Bind Mode | Allowed Auth | Notes |
|---|---|---|
| `loopback` | `none`, `token`, `password` | Only accessible from localhost |
| `lan` | `token`, `password` | **Requires auth** — `none` is rejected |
| `tailnet` | `none`, `token`, `password` | Via Tailscale network |

---

## SSH Access to Endpoints

Nebius AI Endpoints run in VMs that you can SSH into.

### Connection Details

| Field | Value |
|---|---|
| Username | `nebius` (not `root`, `ubuntu`, `admin`, or `openclaw`) |
| SSH Key | Your registered key (e.g., `~/.ssh/id_ed25519_vm`) |
| Port | 22 (standard) |

```bash
ssh -i ~/.ssh/id_ed25519_vm nebius@<PUBLIC_IP>
```

### Running OpenClaw TUI via SSH

Once connected, exec into the running Docker container:

```bash
# Find the container and run the TUI
sudo docker exec -it $(sudo docker ps -q | head -1) openclaw tui
```

The web UI's **Terminal** button automates this — it opens a full-screen xterm.js terminal in your browser that SSH's in and launches the TUI.

---

## Docker Build Gotchas

### ARM64 vs AMD64

Nebius runs Intel/AMD CPUs. If you build on Apple Silicon (M1/M2/M3/M4), the default Docker build produces ARM64 images that crash with `exec format error` on Nebius.

**Fix**: Always use buildx with platform targeting:

```bash
docker buildx build --platform linux/amd64 -t <image> .
```

Cross-compilation via QEMU is slow (10-30 minutes for a full build). For faster builds, build directly on a Nebius VM.

### BuildKit Corruption

Docker BuildKit can corrupt its metadata database, especially after crashes:

```
write /var/lib/docker/buildkit/metadata_v2.db: input/output error
```

**Fix**: Restart Docker Desktop:

```bash
# macOS
osascript -e 'quit app "Docker Desktop"' && open -a "Docker Desktop"
```

### Git Required for npm

OpenClaw and NemoClaw npm packages install from GitHub, which requires git:

```dockerfile
# Must include git in your Dockerfile
RUN apt-get update && apt-get install -y git
```

Without git, `npm install -g openclaw` will fail silently or with cryptic errors.

---

## Troubleshooting

### Nebius CLI & Auth

| Issue | Fix |
|---|---|
| `PermissionDenied` | Check `nebius iam whoami` — ensure correct profile is active. Grant `admin` role in IAM > Access Permits. |
| Token expired | Re-run `nebius auth login` (opens browser for OAuth). |
| Wrong project scoped | Check `nebius config get parent-id`. Switch profiles with `nebius --profile <name>`. |
| Profile not found | Write profile directly to `~/.nebius/config.yaml`. `nebius profile create` requires interactive input. |

### Docker & Container Registry

| Issue | Fix |
|---|---|
| `exec format error` | Image built for ARM64. Rebuild with `--platform linux/amd64`. |
| Registry auth expired | IAM tokens expire in ~1hr. Re-run `nebius iam get-access-token \| docker login ...`. |
| BuildKit corruption | Restart Docker Desktop. |
| `npm install` needs git | Add `git` to Dockerfile `apt-get install`. |

### Endpoints & Deployments

| Issue | Fix |
|---|---|
| Endpoint `StartFailed` | Container crashing. Health check must be the foreground process. Test locally: `docker run -p 8080:8080 <image>`. |
| `cpu-e2` not found | Wrong region. `eu-west1` uses `cpu-d3`, not `cpu-e2`. Check available platforms first. |
| `AlreadyExists` error | Registry or project name taken. List existing resources first, or use a different name. |
| Public IP quota exceeded | Nebius tenants are limited to ~3 public IPv4 addresses. Delete unused endpoints first. |
| `network_ssd` vs `network-ssd` | Use underscores: `network_ssd`. |

### OpenClaw Gateway

| Issue | Fix |
|---|---|
| `Refusing to bind to lan without auth` | Use `--auth token` with `OPENCLAW_GATEWAY_TOKEN=<token>`. Cannot use `--auth none` with `--bind lan`. |
| Dashboard shows `origin not allowed` | Add your URL to `gateway.controlUi.allowedOrigins` config. Use `"*"` to allow all. Restart gateway after. |
| Gateway died after config change | `SIGHUP` kills the gateway (no graceful reload). Restart manually with `openclaw gateway --bind lan --auth token --port 18789`. |
| Can't reach dashboard on port 18789 | Port 18789 is inside the container but not mapped to host. Need SSH tunnel through the container's internal IP. See "Accessing the Dashboard" section. |
| Device pairing required | Remote TUI connections may need approval. Run `openclaw devices approve` on the gateway host. |

### VM Specific

| Issue | Fix |
|---|---|
| VM preempted | Default VMs are preemptible. Use `--preemptible-priority 0` for on-demand. |
| Cloud-init user `root`/`admin` | Reserved names. Use any other username. |
| SSH user unknown | Nebius VMs use username `nebius`. Not `root`, `ubuntu`, or `admin`. |
| Model name not found | Use correct HuggingFace name, e.g., `nvidia/Llama-3.1-Nemotron-70B-Instruct-HF` (note the `-HF` suffix). |

---

## Agent Instructions

If you are an AI agent managing Nebius infrastructure:

```bash
# Always use --format json for parseable output
nebius compute instance list --format json

# Parse with python3
nebius ai endpoint list --format json | \
  python3 -c "import sys,json; [print(i['metadata']['id'], i['status']['state']) for i in json.load(sys.stdin).get('items',[])]"

# Get IAM token for API calls
TOKEN=$(nebius iam get-access-token)

# Call Token Factory / AI Studio directly
curl -s https://api.tokenfactory.nebius.com/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-ai/DeepSeek-R1-0528","messages":[{"role":"user","content":"Hello"}]}'

# List endpoints across all regions
for profile in eu-north1 sa-vibehack; do
  echo "=== $profile ==="
  nebius --profile $profile ai endpoint list --format json 2>/dev/null | \
    python3 -c "import sys,json; [print(f\"  {i['metadata']['name']}: {i['status']['state']}\") for i in json.load(sys.stdin).get('items',[])]" 2>/dev/null
done

# Get container IP inside an endpoint
ssh -i ~/.ssh/id_ed25519_vm nebius@<IP> \
  'sudo docker inspect -f "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}" $(sudo docker ps -q | head -1)'
```
