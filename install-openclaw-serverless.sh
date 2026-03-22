#!/bin/bash
# =============================================================================
# OpenClaw Serverless on Nebius — Deployment Script
# =============================================================================
# Deploys OpenClaw as a serverless endpoint on Nebius cpu-e2 (Intel Ice Lake)
# with inference routed to Nebius Token Factory.
#
# Prerequisites:
#   - nebius CLI installed and authenticated (nebius iam whoami)
#   - Docker installed (for building the image)
#   - A Nebius project in eu-north1 (or change REGION/PROJECT_ID below)
#   - A Token Factory API key (https://tokenfactory.nebius.com)
#
# Usage:
#   export TOKEN_FACTORY_API_KEY="v1.xxx..."
#   ./install-openclaw-serverless.sh
# =============================================================================

set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────────────
REGION="${REGION:-eu-north1}"
PROJECT_ID="${PROJECT_ID:-}"
ENDPOINT_NAME="openclaw-serverless"
PLATFORM="cpu-e2"
CONTAINER_PORT=8080
INFERENCE_MODEL="${INFERENCE_MODEL:-deepseek-ai/DeepSeek-R1-0528}"
TOKEN_FACTORY_URL="${TOKEN_FACTORY_URL:-https://api.tokenfactory.nebius.com/v1}"

# ── Colors ───────────────────────────────────────────────────────────────────
info()  { printf '\033[1;34m>>>\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m✓\033[0m   %s\n' "$*"; }
error() { printf '\033[1;31m✗\033[0m   %s\n' "$*"; exit 1; }

# ── Preflight checks ────────────────────────────────────────────────────────
info "Preflight checks..."

[ -z "${TOKEN_FACTORY_API_KEY:-}" ] && error "Set TOKEN_FACTORY_API_KEY env var. Get one at https://tokenfactory.nebius.com"
command -v nebius &>/dev/null || error "Nebius CLI not installed. Run: curl -sSL https://storage.ai.nebius.cloud/nebius/install.sh | bash"
command -v docker &>/dev/null || error "Docker not installed."

# Verify auth
nebius iam get-access-token >/dev/null 2>&1 || error "Not authenticated. Run: nebius iam whoami"
ok "Authenticated"

# Auto-detect project ID if not set
if [ -z "$PROJECT_ID" ]; then
  PROJECT_ID=$(nebius iam project list --format json 2>/dev/null | \
    python3 -c "import sys,json; items=json.load(sys.stdin).get('items',[]); print(items[0]['metadata']['id'] if items else '')" 2>/dev/null || echo "")
  [ -z "$PROJECT_ID" ] && error "Could not auto-detect project. Set PROJECT_ID env var."
  ok "Using project: $PROJECT_ID"
fi

# ── Step 1: Create Container Registry ────────────────────────────────────────
info "Step 1: Creating container registry..."

REGISTRY_ID=$(nebius registry list --format json 2>/dev/null | \
  python3 -c "import sys,json; items=json.load(sys.stdin).get('items',[]); print(items[0]['metadata']['id'] if items else '')" 2>/dev/null || echo "")

if [ -z "$REGISTRY_ID" ]; then
  REGISTRY_ID=$(nebius registry create \
    --name openclaw \
    --parent-id "$PROJECT_ID" \
    --format json | python3 -c "import sys,json; print(json.load(sys.stdin)['metadata']['id'])")
  ok "Created registry: $REGISTRY_ID"
else
  ok "Using existing registry: $REGISTRY_ID"
fi

REGISTRY_URL="cr.${REGION}.nebius.cloud"
IMAGE="${REGISTRY_URL}/${REGISTRY_ID}/openclaw-serverless:latest"

# ── Step 2: Build Docker image ───────────────────────────────────────────────
info "Step 2: Building Docker image..."

BUILD_DIR=$(mktemp -d)
trap "rm -rf $BUILD_DIR" EXIT

cat > "$BUILD_DIR/Dockerfile" << 'DOCKERFILE'
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates procps git python3 \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g openclaw

RUN useradd -m -s /bin/bash openclaw

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 8080 18789
USER openclaw
WORKDIR /home/openclaw
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
DOCKERFILE

cat > "$BUILD_DIR/entrypoint.sh" << 'ENTRYPOINT'
#!/bin/bash
set -e

MODEL="${INFERENCE_MODEL:-deepseek-ai/DeepSeek-R1-0528}"
TF_KEY="${TOKEN_FACTORY_API_KEY}"
TF_URL="${TOKEN_FACTORY_URL:-https://api.tokenfactory.nebius.com/v1}"

echo "=== OpenClaw Serverless ==="
echo "Model: $MODEL"
echo "Inference: Token Factory"

if [ -z "$TF_KEY" ]; then
  echo "WARNING: TOKEN_FACTORY_API_KEY not set"
fi

# Configure OpenClaw
mkdir -p ~/.openclaw
cat > ~/.openclaw/openclaw.json << OCJSON
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "token-factory/${MODEL}"
      }
    }
  },
  "models": {
    "mode": "merge",
    "providers": {
      "token-factory": {
        "baseUrl": "${TF_URL}",
        "apiKey": "${TF_KEY}",
        "api": "openai-completions",
        "models": [{"id": "${MODEL}", "name": "Token Factory"}]
      }
    }
  },
  "gateway": {
    "port": 18789,
    "mode": "local",
    "bind": "lan",
    "auth": {"mode": "token"}
  }
}
OCJSON
echo "OpenClaw configured."

# Start gateway in background with token auth (required for LAN bind)
export OPENCLAW_GATEWAY_TOKEN="${GATEWAY_TOKEN:-openclaw-serverless-$(hostname)}"
openclaw gateway --bind lan --auth token > /tmp/gateway.log 2>&1 &
echo "Gateway started (PID: $!) token=\$OPENCLAW_GATEWAY_TOKEN"

# Main process: health check HTTP server on port 8080
exec python3 -c "
import http.server, json, os

class Health(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        body = {
            'status': 'healthy',
            'service': 'openclaw-serverless',
            'model': os.environ.get('INFERENCE_MODEL', 'unknown'),
            'inference': 'token-factory',
            'gateway_port': 18789
        }
        self.wfile.write(json.dumps(body).encode())
    def log_message(self, format, *args):
        pass

print('Health server starting on :8080')
http.server.HTTPServer(('0.0.0.0', 8080), Health).serve_forever()
"
ENTRYPOINT

# Build for linux/amd64 (required for Nebius cpu-e2 / Intel Ice Lake)
docker buildx build --platform linux/amd64 -t "$IMAGE" "$BUILD_DIR" 2>&1 | tail -5
ok "Image built: $IMAGE"

# ── Step 3: Push to Nebius Container Registry ────────────────────────────────
info "Step 3: Pushing image to registry..."

nebius iam get-access-token | docker login "$REGISTRY_URL" --username iam --password-stdin 2>&1
docker push "$IMAGE" 2>&1 | tail -5
ok "Image pushed"

# ── Step 4: Deploy endpoint ──────────────────────────────────────────────────
info "Step 4: Deploying endpoint on $PLATFORM..."

nebius ai endpoint create \
  --name "$ENDPOINT_NAME" \
  --image "$IMAGE" \
  --platform "$PLATFORM" \
  --container-port "$CONTAINER_PORT" \
  --env "TOKEN_FACTORY_API_KEY=${TOKEN_FACTORY_API_KEY}" \
  --env "TOKEN_FACTORY_URL=${TOKEN_FACTORY_URL}" \
  --env "INFERENCE_MODEL=${INFERENCE_MODEL}" \
  --public \
  2>&1

# ── Step 5: Wait for endpoint to be ready ────────────────────────────────────
info "Step 5: Waiting for endpoint to start..."

ENDPOINT_ID=$(nebius ai endpoint list --format json 2>/dev/null | \
  python3 -c "import sys,json; items=json.load(sys.stdin).get('items',[]); [print(i['metadata']['id']) for i in items if i['metadata']['name']=='$ENDPOINT_NAME']" 2>/dev/null | head -1)

for i in $(seq 1 30); do
  STATE=$(nebius ai endpoint get "$ENDPOINT_ID" --format json 2>/dev/null | \
    python3 -c "import sys,json; print(json.load(sys.stdin).get('status',{}).get('state','UNKNOWN'))" 2>/dev/null || echo "UNKNOWN")

  if [ "$STATE" = "RUNNING" ]; then
    ok "Endpoint is RUNNING!"
    break
  elif [ "$STATE" = "ERROR" ]; then
    error "Endpoint failed to start. Run: nebius ai endpoint logs $ENDPOINT_ID"
  fi

  printf '.'
  sleep 10
done

# ── Get endpoint info ────────────────────────────────────────────────────────
PUBLIC_IP=$(nebius ai endpoint get "$ENDPOINT_ID" --format json 2>/dev/null | \
  python3 -c "
import sys,json
d=json.load(sys.stdin)
inst=d.get('status',{}).get('instances',[])
for i in inst:
    ip=i.get('public_ip','') or i.get('public_ip_address','')
    if ip: print(ip.split('/')[0])
" 2>/dev/null || echo "N/A")

echo ""
echo "============================================="
echo "  OpenClaw Serverless — Deployed!"
echo "============================================="
echo ""
echo "  Endpoint ID:  $ENDPOINT_ID"
echo "  Health check: http://${PUBLIC_IP}:8080"
echo "  Gateway:      ws://${PUBLIC_IP}:18789"
echo "  Model:        $INFERENCE_MODEL"
echo "  Platform:     $PLATFORM"
echo ""
echo "  Connect via TUI:"
echo "    openclaw tui --url ws://${PUBLIC_IP}:18789"
echo ""
echo "  Manage:"
echo "    nebius ai endpoint logs $ENDPOINT_ID"
echo "    nebius ai endpoint stop $ENDPOINT_ID"
echo "    nebius ai endpoint delete $ENDPOINT_ID"
echo ""
