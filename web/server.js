const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const { execSync, exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// ── Region config ──────────────────────────────────────────────────────────
const REGIONS = {
  'eu-north1': {
    name: 'EU North (Finland)',
    registry: 'cr.eu-north1.nebius.cloud',
    projectId: 'project-e00r2jeapr00j2q7e7n3yn',
    cpuPlatform: 'cpu-e2',
    flag: '🇫🇮'
  },
  'eu-west1': {
    name: 'EU West (Paris)',
    registry: 'cr.eu-west1.nebius.cloud',
    projectId: '',
    cpuPlatform: 'cpu-d3',
    flag: '🇫🇷'
  },
  'us-central1': {
    name: 'US Central',
    registry: 'cr.us-central1.nebius.cloud',
    projectId: 'project-u00pcxzdpr009qf929wrpn',
    cpuPlatform: 'cpu-e2',
    flag: '🇺🇸'
  }
};

const IMAGES = {
  'openclaw': {
    name: 'OpenClaw',
    description: 'Lightweight AI agent — OpenClaw only',
    icon: '🦞',
    getImage: (registryId, region) =>
      `cr.${region}.nebius.cloud/${registryId}/openclaw-serverless:latest`
  },
  'nemoclaw': {
    name: 'NemoClaw',
    description: 'Full agent — OpenClaw + NVIDIA NemoClaw plugin',
    icon: '🔱',
    getImage: (registryId, region) =>
      `cr.${region}.nebius.cloud/${registryId}/nemoclaw-serverless:latest`
  },
  'custom': {
    name: 'Custom Image',
    description: 'Provide your own Docker image URL',
    icon: '🐳',
    getImage: (registryId, region, customUrl) => customUrl
  }
};

// ── Auth middleware ─────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.authenticated) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

// ── Nebius CLI helper ──────────────────────────────────────────────────────
function nebius(cmd, profile) {
  const profileFlag = profile ? `--profile ${profile}` : '';
  try {
    const result = execSync(`nebius ${profileFlag} ${cmd}`, {
      encoding: 'utf-8',
      timeout: 30000,
      env: { ...process.env, PATH: process.env.PATH }
    });
    return result.trim();
  } catch (err) {
    throw new Error(err.stderr || err.message);
  }
}

function nebiusJson(cmd, profile) {
  const raw = nebius(`${cmd} --format json`, profile);
  return JSON.parse(raw);
}

// ── Routes: Auth ───────────────────────────────────────────────────────────

// Check if user is authenticated via nebius CLI
app.get('/api/auth/status', (req, res) => {
  try {
    const token = nebius('iam get-access-token');
    if (token) {
      req.session.authenticated = true;
      req.session.token = token;

      // Try to get user info
      let user = 'Nebius User';
      try {
        const whoami = execSync('nebius iam whoami --format json', { encoding: 'utf-8', timeout: 10000 }).trim();
        const identity = JSON.parse(whoami);
        const attrs = identity.user_profile?.attributes || {};
        user = attrs.name || attrs.given_name || attrs.email || identity.user_profile?.id || 'Nebius User';
      } catch (e) {}

      res.json({ authenticated: true, user });
    } else {
      res.json({ authenticated: false });
    }
  } catch (err) {
    res.json({ authenticated: false, error: 'Run: nebius iam login' });
  }
});

// Trigger browser-based Nebius login
app.post('/api/auth/login', (req, res) => {
  try {
    // This opens the browser for OAuth — runs async
    exec('nebius iam login', (err) => {
      if (err) console.error('Login error:', err.message);
    });
    res.json({ message: 'Login initiated — check your browser' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ message: 'Logged out' });
});

// ── Routes: MysteryBox Secrets ─────────────────────────────────────────────

app.get('/api/secrets', requireAuth, (req, res) => {
  try {
    const data = nebiusJson('mysterybox secret list');
    const secrets = (data.items || []).map(s => ({
      id: s.metadata.id,
      name: s.metadata.name,
      description: s.spec?.description || '',
      state: s.status?.state || 'UNKNOWN'
    }));
    res.json(secrets);
  } catch (err) {
    res.json([]);
  }
});

app.get('/api/secrets/:id/payload', requireAuth, (req, res) => {
  try {
    const data = nebiusJson(`mysterybox payload get --secret-id ${req.params.id}`);
    // Return all key-value pairs from the secret
    const payload = {};
    for (const entry of (data.data || [])) {
      payload[entry.key] = entry.string_value || entry.binary_value || '';
    }
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: `Failed to retrieve secret: ${err.message.split('\n')[0]}` });
  }
});

// ── Routes: Config ─────────────────────────────────────────────────────────

app.get('/api/regions', (req, res) => {
  res.json(REGIONS);
});

app.get('/api/images', (req, res) => {
  res.json(Object.fromEntries(
    Object.entries(IMAGES).map(([k, v]) => [k, { name: v.name, description: v.description, icon: v.icon }])
  ));
});

// ── Routes: Models (Token Factory) ────────────────────────────────────────
let cachedModels = null;
let modelsCacheTime = 0;
const MODELS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

app.get('/api/models', requireAuth, async (req, res) => {
  // Return cached if fresh
  if (cachedModels && Date.now() - modelsCacheTime < MODELS_CACHE_TTL) {
    return res.json(cachedModels);
  }

  try {
    const fetch = require('node-fetch');
    const tfUrl = 'https://api.tokenfactory.nebius.com/v1/models';

    // Try user-provided API key first, then try to get one from MysteryBox
    let authToken = req.query.apiKey;
    if (!authToken) {
      try {
        const secretsJson = execSync('nebius mysterybox secret list --format json', { encoding: 'utf-8', timeout: 15000 });
        const secrets = JSON.parse(secretsJson);
        const tfSecret = (secrets.items || []).find(s =>
          (s.metadata?.name || '').toLowerCase().includes('token') && (s.metadata?.name || '').toLowerCase().includes('key')
        );
        if (tfSecret) {
          const payloadJson = execSync(`nebius mysterybox payload get --secret-id ${tfSecret.metadata.id} --format json`, { encoding: 'utf-8', timeout: 15000 });
          const payload = JSON.parse(payloadJson);
          const entry = (payload.data || [])[0];
          if (entry) authToken = entry.string_value || entry.text_value || '';
        }
      } catch (e) {
        console.warn('[Models] Could not fetch TF key from MysteryBox:', e.message);
      }
    }

    if (!authToken) {
      throw new Error('No Token Factory API key available');
    }

    const response = await fetch(tfUrl, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Token Factory API returned ${response.status}: ${body}`);
    }

    const data = await response.json();
    cachedModels = (data.data || data.models || [])
      .map(m => ({ id: m.id, owned_by: m.owned_by || '' }))
      .sort((a, b) => a.id.localeCompare(b.id));
    modelsCacheTime = Date.now();

    res.json(cachedModels);
  } catch (err) {
    console.error('Failed to fetch models:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Routes: Endpoints ──────────────────────────────────────────────────────

// Map regions to CLI profiles
const REGION_PROFILES = {
  'eu-north1': 'eu-north1',
  'eu-west1': null,           // no profile yet
  'us-central1': 'sa-vibehack'
};

app.get('/api/endpoints', requireAuth, async (req, res) => {
  const allEndpoints = [];

  for (const [region, profile] of Object.entries(REGION_PROFILES)) {
    if (!profile) continue;
    try {
      const data = nebiusJson('ai endpoint list', profile);
      const regionInfo = REGIONS[region] || {};

      for (const ep of (data.items || [])) {
        // Also try to extract region from image URL as fallback
        let detectedRegion = region;
        const imageMatch = (ep.spec.image || '').match(/cr\.([^.]+)\.nebius\.cloud/);
        if (imageMatch) detectedRegion = imageMatch[1];
        const ri = REGIONS[detectedRegion] || regionInfo;

        allEndpoints.push({
          id: ep.metadata.id,
          name: ep.metadata.name,
          state: ep.status.state,
          publicIp: ep.status.instances?.[0]?.public_ip || null,
          image: ep.spec.image,
          platform: ep.spec.platform,
          region: detectedRegion,
          regionName: ri.name || detectedRegion || 'Unknown',
          regionFlag: ri.flag || '🌐',
          createdAt: ep.metadata.created_at,
          health: null, // filled in below
          dashboardToken: endpointPasswords[ep.metadata.name] || null
        });
      }
    } catch (err) {
      // Region query failed — skip silently
      console.log(`Skipping ${region} (${profile}): ${err.message.split('\n')[0]}`);
    }
  }

  // Fetch health status from each running endpoint (in parallel, non-blocking)
  const fetch = require('node-fetch');
  await Promise.all(allEndpoints.map(async (ep) => {
    if (ep.publicIp && ep.state === 'RUNNING') {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const resp = await fetch(`http://${ep.publicIp}:8080`, { signal: controller.signal });
        clearTimeout(timeout);
        ep.health = await resp.json();
      } catch (e) {
        ep.health = null;
      }
    }
  }));

  res.json(allEndpoints);
});

// ── Deploy-time secrets (password stored per endpoint name) ────────────────
const endpointPasswords = {}; // { endpointName: password }

// ── Routes: Deploy ─────────────────────────────────────────────────────────

app.post('/api/deploy', requireAuth, async (req, res) => {
  const { imageType, model, region, provider, customImage, endpointName, apiKey } = req.body;

  if (!imageType || !region) {
    return res.status(400).json({ error: 'imageType and region are required' });
  }

  const regionConfig = REGIONS[region];
  if (!regionConfig) {
    return res.status(400).json({ error: `Unknown region: ${region}` });
  }

  if (!apiKey) {
    const providerLabels = { 'token-factory': 'Token Factory', 'openrouter': 'OpenRouter', 'huggingface': 'HuggingFace' };
    return res.status(400).json({ error: `${providerLabels[provider] || 'API'} key is required` });
  }

  const name = endpointName || `${imageType}-${region}-${Date.now().toString(36)}`;

  try {
    // Find or create project for this region
    let projectId = regionConfig.projectId;
    if (!projectId) {
      try {
        const tenantId = 'tenant-e00zj418j5m8a78scb';
        const projName = `openclaw-${region}`;
        console.log(`Setting up project for ${region}...`);

        // List all projects at tenant level and find one in the right region
        const projects = nebiusJson(
          `iam project list --parent-id ${tenantId}`, 'eu-north1'
        );
        // Prefer default-project-<region>, then openclaw-<region>, then any match
        const allInRegion = (projects.items || []).filter(
          p => p.status?.region === region || p.spec?.region === region
        );
        const defaultProj = allInRegion.find(p => p.metadata.name === `default-project-${region}`);
        const oclawProj = allInRegion.find(p => p.metadata.name === projName);
        const picked = defaultProj || oclawProj || allInRegion[0];

        if (picked) {
          projectId = picked.metadata.id;
          console.log(`Using existing project "${picked.metadata.name}" (${projectId}) in ${region}`);
        } else {
          console.log(`Creating project "${projName}"...`);
          const projResult = nebius(
            `iam project create --name "${projName}" --parent-id ${tenantId} --format json`,
            'eu-north1'
          );
          projectId = JSON.parse(projResult).metadata.id;
        }
        regionConfig.projectId = projectId;

        // Write the profile directly into ~/.nebius/config.yaml
        const configPath = path.join(process.env.HOME, '.nebius', 'config.yaml');
        let config = fs.readFileSync(configPath, 'utf-8');

        if (!config.includes(`    ${region}:`)) {
          // Insert new profile after "profiles:" line
          const profileBlock = [
            `    ${region}:`,
            `        endpoint: api.nebius.cloud`,
            `        auth-type: federation`,
            `        federation-endpoint: auth.nebius.com`,
            `        parent-id: ${projectId}`,
            `        tenant-id: ${tenantId}`
          ].join('\n');

          config = config.replace(
            /^profiles:\n/m,
            `profiles:\n${profileBlock}\n`
          );
          fs.writeFileSync(configPath, config, 'utf-8');
          console.log(`Wrote profile ${region} to config`);
        }

        // Update REGION_PROFILES so endpoint polling picks it up
        REGION_PROFILES[region] = region;

        console.log(`Created project ${projectId} for ${region}`);
      } catch (err) {
        return res.status(500).json({
          error: `Failed to create project in ${region}: ${err.message.split('\n')[0]}`
        });
      }
    }

    // Determine which CLI profile to use for this region
    const profile = REGION_PROFILES[region] || 'eu-north1';
    const profileFlag = `--profile ${profile}`;

    // Auto-detect cheapest CPU platform in this region
    try {
      const platforms = nebiusJson('compute platform list', profile);
      const cpuPlatforms = (platforms.items || []).filter(p =>
        p.metadata.name.startsWith('cpu-')
      );

      if (cpuPlatforms.length > 0) {
        // Pick the platform with the smallest preset (least vCPUs = cheapest)
        let cheapest = null;
        let cheapestVcpu = Infinity;

        for (const plat of cpuPlatforms) {
          const presets = plat.spec?.presets || [];
          for (const pr of presets) {
            const vcpu = pr.resources?.vcpu_count || Infinity;
            if (vcpu < cheapestVcpu) {
              cheapestVcpu = vcpu;
              cheapest = { platform: plat.metadata.name, preset: pr.name };
            }
          }
        }

        if (cheapest) {
          regionConfig.cpuPlatform = cheapest.platform;
          regionConfig.cpuPreset = cheapest.preset;
          console.log(`Auto-detected cheapest CPU in ${region}: ${cheapest.platform} / ${cheapest.preset} (${cheapestVcpu} vCPUs)`);
        }
      }
    } catch (err) {
      console.log(`Platform detection failed for ${region}, using default: ${err.message.split('\n')[0]}`);
    }

    // Find or create registry in this region
    let registryId;
    try {
      const registries = nebiusJson('registry list', profile);
      registryId = registries.items?.[0]?.metadata?.id;
    } catch (e) {}

    if (!registryId) {
      try {
        console.log(`Creating container registry in ${region}...`);
        const regResult = nebius(
          `registry create --name openclaw --parent-id ${projectId} --format json`
        );
        registryId = JSON.parse(regResult).metadata.id;
        console.log(`Created registry ${registryId}`);
      } catch (err) {
        return res.status(500).json({
          error: `Failed to create registry in ${region}: ${err.message.split('\n')[0]}`
        });
      }
    }

    // Resolve image URL
    const imageConfig = IMAGES[imageType];
    if (!imageConfig) {
      return res.status(400).json({ error: `Unknown image type: ${imageType}` });
    }

    const image = imageConfig.getImage(registryId, region, customImage);
    if (!image) {
      return res.status(400).json({ error: 'Could not resolve image URL' });
    }

    // Build env vars based on provider
    const envFlags = [];
    envFlags.push(`--env "INFERENCE_MODEL=${model || 'deepseek-ai/DeepSeek-R1-0528'}"`);

    // Generate a dashboard password and store it for later use
    const webPassword = crypto.randomBytes(24).toString('base64url');
    envFlags.push(`--env "OPENCLAW_WEB_PASSWORD=${webPassword}"`);

    switch (provider) {
      case 'openrouter':
        envFlags.push(`--env "OPENROUTER_API_KEY=${apiKey}"`);
        envFlags.push('--env "INFERENCE_URL=https://openrouter.ai/api/v1"');
        envFlags.push('--env "INFERENCE_PROVIDER=openrouter"');
        envFlags.push('--env "OPENROUTER_PROVIDER_ONLY=nebius"');
        break;
      case 'huggingface':
        envFlags.push(`--env "HUGGINGFACE_API_KEY=${apiKey}"`);
        envFlags.push('--env "INFERENCE_PROVIDER=huggingface"');
        envFlags.push('--env "HUGGINGFACE_PROVIDER=nebius"');
        // Also set HF_TOKEN for faster model downloads (same as RunPod template)
        envFlags.push(`--env "HF_TOKEN=${apiKey}"`);
        break;
      case 'token-factory':
      default:
        envFlags.push(`--env "TOKEN_FACTORY_API_KEY=${apiKey}"`);
        envFlags.push('--env "TOKEN_FACTORY_URL=https://api.tokenfactory.nebius.com/v1"');
        break;
    }

    // Deploy endpoint
    const cmd = [
      `${profileFlag} ai endpoint create`,
      `--name "${name}"`,
      `--image "${image}"`,
      `--platform ${regionConfig.cpuPlatform || 'cpu-e2'}`,
      regionConfig.cpuPreset ? `--preset ${regionConfig.cpuPreset}` : '',
      '--container-port 8080',
      '--container-port 18789',
      ...envFlags,
      '--public'
    ].join(' ');

    // Store the dashboard password keyed by endpoint name
    endpointPasswords[name] = webPassword;
    console.log(`[Deploy] Stored dashboard password for "${name}" (${webPassword.length} chars)`);

    // Run async so we don't block
    exec(`nebius ${cmd}`, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        console.error(`Deploy error (${region}):`, stderr || err.message);
      } else {
        console.log(`Deploy success (${region}):`, stdout);
      }
    });

    res.json({
      status: 'deploying',
      name,
      image,
      region: regionConfig.name,
      platform: regionConfig.cpuPlatform || 'cpu-e2',
      preset: regionConfig.cpuPreset || 'default',
      message: `Deploying ${imageConfig.name} to ${regionConfig.name} (${regionConfig.cpuPlatform || 'cpu-e2'} / ${regionConfig.cpuPreset || 'default'})...`
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Routes: Manage ─────────────────────────────────────────────────────────

app.delete('/api/endpoints/:id', requireAuth, (req, res) => {
  try {
    exec(`nebius ai endpoint delete --id ${req.params.id}`, { timeout: 60000 }, (err) => {
      if (err) console.error('Delete error:', err.message);
    });
    res.json({ status: 'deleting', id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Routes: SSH Tunnel for Dashboard ──────────────────────────────────────
const activeTunnels = {}; // { ip: { proc, localPort } }
let nextTunnelPort = 19000;

app.post('/api/tunnel', requireAuth, (req, res) => {
  const { ip, endpointName } = req.body;
  if (!ip) return res.status(400).json({ error: 'IP is required' });

  const sshKeys = [
    path.join(process.env.HOME, '.ssh', 'id_ed25519_vm'),
    path.join(process.env.HOME, '.ssh', 'id_ed25519'),
    path.join(process.env.HOME, '.ssh', 'id_rsa')
  ];
  const sshKey = sshKeys.find(k => fs.existsSync(k)) || sshKeys[0];

  // Reuse existing tunnel if alive
  if (activeTunnels[ip]) {
    const existing = activeTunnels[ip];
    if (!existing.proc.killed) {
      return res.json({ url: `http://localhost:${existing.localPort}`, localPort: existing.localPort, token: existing.gatewayToken || null, reused: true });
    }
    // Dead tunnel — clean up
    delete activeTunnels[ip];
  }

  const localPort = nextTunnelPort++;

  console.log(`[Tunnel] Creating SSH tunnel localhost:${localPort} → ${ip} (container:18789)`);

  // Step 1: Try to get dashboard token
  // First check our stored passwords (set during deploy), then SSH extract as fallback
  let gatewayToken = null;

  if (endpointName && endpointPasswords[endpointName]) {
    gatewayToken = endpointPasswords[endpointName];
    console.log(`[Tunnel] Using stored OPENCLAW_WEB_PASSWORD for "${endpointName}" (${gatewayToken.length} chars)`);
  } else {
    // Fallback: SSH in and extract token — check both OPENCLAW_WEB_PASSWORD and OPENCLAW_GATEWAY_TOKEN
    try {
      const tokenCmd = `ssh -i ${sshKey} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 nebius@${ip} "sudo docker exec \\$(sudo docker ps -q | head -1) env 2>/dev/null | grep -E 'OPENCLAW_WEB_PASSWORD|OPENCLAW_GATEWAY_TOKEN' | head -1 | cut -d= -f2-"`;
      console.log(`[Tunnel] No stored password — fetching token via SSH from ${ip}...`);
      gatewayToken = execSync(tokenCmd, { timeout: 15000, encoding: 'utf-8' }).trim();
      if (gatewayToken) {
        console.log(`[Tunnel] Got token via SSH (${gatewayToken.length} chars)`);
      } else {
        console.log(`[Tunnel] No gateway token found in container env`);
      }
    } catch (err) {
      console.warn(`[Tunnel] Could not fetch gateway token: ${err.message}`);
    }
  }

  // Step 2: Create the SSH tunnel with socat bridge
  // Port 18789 is inside the Docker container but not mapped to the host.
  // So we SSH in and run socat to bridge host port → container port,
  // then forward our local port to that.
  const remoteProxyPort = 28789;
  const proc = spawn('ssh', [
    '-tt',
    '-L', `${localPort}:localhost:${remoteProxyPort}`,
    '-i', sshKey,
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ConnectTimeout=10',
    '-o', 'ExitOnForwardFailure=yes',
    `nebius@${ip}`,
    // On the remote host: get the container's IP, then use socat to proxy
    `CONTAINER_IP=$(sudo docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' $(sudo docker ps -q | head -1)); `
    + `echo "Proxying to container at $CONTAINER_IP:18789"; `
    + `sudo socat TCP-LISTEN:${remoteProxyPort},fork,reuseaddr TCP:$CONTAINER_IP:18789 || `
    + `sudo apt-get install -y socat > /dev/null 2>&1 && sudo socat TCP-LISTEN:${remoteProxyPort},fork,reuseaddr TCP:$CONTAINER_IP:18789`
  ]);

  proc.on('close', (code) => {
    console.log(`[Tunnel] Tunnel to ${ip}:${localPort} closed (code ${code})`);
    delete activeTunnels[ip];
  });

  proc.on('error', (err) => {
    console.error(`[Tunnel] Error for ${ip}:`, err.message);
    delete activeTunnels[ip];
  });

  activeTunnels[ip] = { proc, localPort, gatewayToken };

  // Give SSH a moment to establish the tunnel
  setTimeout(() => {
    if (proc.killed) {
      res.status(500).json({ error: 'SSH tunnel failed to start' });
    } else {
      res.json({ url: `http://localhost:${localPort}`, localPort, token: gatewayToken || null, reused: false });
    }
  }, 2000);
});

app.delete('/api/tunnel/:ip', requireAuth, (req, res) => {
  const { ip } = req.params;
  const tunnel = activeTunnels[ip];
  if (tunnel) {
    tunnel.proc.kill('SIGTERM');
    delete activeTunnels[ip];
    console.log(`[Tunnel] Closed tunnel to ${ip}`);
  }
  res.json({ status: 'closed' });
});

app.get('/api/tunnels', requireAuth, (req, res) => {
  const tunnels = {};
  for (const [ip, t] of Object.entries(activeTunnels)) {
    tunnels[ip] = { localPort: t.localPort, alive: !t.proc.killed };
  }
  res.json(tunnels);
});

// ── WebSocket SSH Terminal ─────────────────────────────────────────────────
const wss = new WebSocket.Server({ server, path: '/ws/terminal' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const ip = url.searchParams.get('ip');

  if (!ip) {
    ws.send(JSON.stringify({ type: 'error', data: 'No IP provided' }));
    ws.close();
    return;
  }

  console.log(`[Terminal] Connecting to ${ip}...`);
  ws.send(JSON.stringify({ type: 'status', data: `Connecting to ${ip}...\r\n` }));

  // Find SSH key — try common locations
  const sshKeys = [
    path.join(process.env.HOME, '.ssh', 'id_ed25519_vm'),
    path.join(process.env.HOME, '.ssh', 'id_ed25519'),
    path.join(process.env.HOME, '.ssh', 'id_rsa')
  ];
  const sshKey = sshKeys.find(k => fs.existsSync(k)) || sshKeys[0];

  // SSH into the endpoint, then exec into the container to run openclaw
  const sshProc = spawn('ssh', [
    '-tt',
    '-i', sshKey,
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ConnectTimeout=10',
    `nebius@${ip}`,
    // After SSH connects, find the running container and exec openclaw tui
    'sudo docker exec -it $(sudo docker ps -q | head -1) openclaw tui 2>/dev/null || echo "No container running — dropping to shell"; bash'
  ], {
    env: { ...process.env, TERM: 'xterm-256color' }
  });

  sshProc.stdout.on('data', (data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'data', data: data.toString('utf-8') }));
    }
  });

  sshProc.stderr.on('data', (data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'data', data: data.toString('utf-8') }));
    }
  });

  sshProc.on('close', (code) => {
    console.log(`[Terminal] SSH to ${ip} closed (code ${code})`);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'exit', code }));
      ws.close();
    }
  });

  sshProc.on('error', (err) => {
    console.error(`[Terminal] SSH error for ${ip}:`, err.message);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'error', data: `SSH error: ${err.message}` }));
      ws.close();
    }
  });

  // Forward input from browser to SSH stdin
  ws.on('message', (msg) => {
    try {
      const parsed = JSON.parse(msg);
      if (parsed.type === 'input' && sshProc.stdin.writable) {
        sshProc.stdin.write(parsed.data);
      } else if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
        // Send SIGWINCH-style resize — use stty via the SSH channel
        // This is handled by the terminal itself via xterm.js fit addon
      }
    } catch (e) {
      // Raw string fallback
      if (sshProc.stdin.writable) {
        sshProc.stdin.write(msg);
      }
    }
  });

  ws.on('close', () => {
    console.log(`[Terminal] WebSocket closed for ${ip}`);
    sshProc.kill('SIGTERM');
  });
});

// ── SPA fallback ───────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`\n  🦞 OpenClaw Deploy UI`);
  console.log(`  http://localhost:${PORT}\n`);
});
