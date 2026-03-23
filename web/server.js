const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const { execSync, exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const fetch = require('node-fetch');
const yaml = require('js-yaml');

const app = express();
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
const IS_VERCEL = !!process.env.VERCEL;

// Trust reverse proxy (nginx) for X-Forwarded-* headers
app.set('trust proxy', true);

// ── Input validation ──────────────────────────────────────────────────────
function validateId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new Error('Invalid ID format');
  }
  return value;
}

function validateIp(value) {
  if (typeof value !== 'string' || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)) {
    throw new Error('Invalid IP format');
  }
  return value;
}

// ── Session ───────────────────────────────────────────────────────────────
// Set SESSION_SECRET env var for persistent sessions across restarts
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, httpOnly: true, sameSite: 'lax', maxAge: 24 * 60 * 60 * 1000 }
}));

// ── Auto-detect Nebius config from CLI ────────────────────────────────────
const REGION_META = {
  'eu-north1':   { name: 'EU North (Finland)', flag: '🇫🇮', registry: 'cr.eu-north1.nebius.cloud',   cpuPlatform: 'cpu-e2' },
  'eu-west1':    { name: 'EU West (Paris)',     flag: '🇫🇷', registry: 'cr.eu-west1.nebius.cloud',    cpuPlatform: 'cpu-d3' },
  'us-central1': { name: 'US Central',          flag: '🇺🇸', registry: 'cr.us-central1.nebius.cloud', cpuPlatform: 'cpu-e2' }
};

function loadNebiusConfig() {
  const configPath = process.env.NEBIUS_CONFIG_PATH || path.join(process.env.HOME, '.nebius', 'config.yaml');
  if (!fs.existsSync(configPath)) {
    console.warn('⚠ No Nebius CLI config found at', configPath);
    console.warn('  Run: nebius iam login');
    return { regions: {}, profiles: {}, tenantId: null };
  }

  try {
    const config = yaml.load(fs.readFileSync(configPath, 'utf-8'));
    const regions = {};
    const profiles = {};
    let tenantId = null;

    // Track seen project IDs to avoid duplicate regions
    const seenProjects = new Set();

    for (const [profileName, profile] of Object.entries(config.profiles || {})) {
      const parentId = profile['parent-id'] || '';

      // Skip profiles without a valid project ID
      if (!parentId.startsWith('project-')) continue;

      // Deduplicate — skip if we already have a region for this project
      if (seenProjects.has(parentId)) continue;
      seenProjects.add(parentId);

      // Match profile to a known region by name or by trying the nebius CLI
      let regionKey = Object.keys(REGION_META).find(r =>
        profileName === r || profileName.includes(r)
      );

      // If no region match, try to detect region from the project
      if (!regionKey) {
        try {
          const projInfo = JSON.parse(
            execSync(`nebius --profile ${profileName} iam project get --id ${parentId} --format json`, { encoding: 'utf-8', timeout: 10000 })
          );
          const detectedRegion = projInfo.status?.region || projInfo.spec?.region;
          if (detectedRegion && REGION_META[detectedRegion]) {
            regionKey = detectedRegion;
          }
        } catch (e) {
          // Fall back to profile name
        }
      }

      regionKey = regionKey || profileName;

      const meta = REGION_META[regionKey] || {
        name: regionKey,
        flag: '🌐',
        registry: `cr.${regionKey}.nebius.cloud`,
        cpuPlatform: 'cpu-e2'
      };

      regions[regionKey] = {
        ...meta,
        projectId: parentId
      };
      profiles[regionKey] = profileName;

      if (!tenantId && profile['tenant-id']) {
        tenantId = profile['tenant-id'];
      }
    }

    console.log(`  Loaded ${Object.keys(regions).length} region(s) from ${configPath}`);
    return { regions, profiles, tenantId };
  } catch (err) {
    console.error('Failed to parse Nebius config:', err.message);
    return { regions: {}, profiles: {}, tenantId: null };
  }
}

const nebiusConfig = IS_VERCEL ? { regions: {}, profiles: {}, tenantId: null } : loadNebiusConfig();
const REGIONS = nebiusConfig.regions;
const REGION_PROFILES = nebiusConfig.profiles;
const TENANT_ID = nebiusConfig.tenantId;

// ── Demo mode (Vercel) ──────────────────────────────────────────────────
const DEMO_REGIONS = {
  'eu-north1':   { name: 'EU North (Finland)', flag: '🇫🇮', registry: 'cr.eu-north1.nebius.cloud',   cpuPlatform: 'cpu-e2' },
  'eu-west1':    { name: 'EU West (Paris)',     flag: '🇫🇷', registry: 'cr.eu-west1.nebius.cloud',    cpuPlatform: 'cpu-d3' },
  'us-central1': { name: 'US Central',          flag: '🇺🇸', registry: 'cr.us-central1.nebius.cloud', cpuPlatform: 'cpu-e2' }
};

const DEMO_MODELS = [
  { id: 'deepseek-ai/DeepSeek-R1-0528', owned_by: 'deepseek-ai' },
  { id: 'zai-org/GLM-5', owned_by: 'zai-org' },
  { id: 'MiniMaxAI/MiniMax-M2.5', owned_by: 'MiniMaxAI' },
  { id: 'Qwen/Qwen3-235B-A22B', owned_by: 'Qwen' },
  { id: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct', owned_by: 'meta-llama' },
  { id: 'google/gemma-3-27b-it', owned_by: 'google' },
  { id: 'mistralai/Mistral-Small-3.2-24B-Instruct-2506', owned_by: 'mistralai' }
];

const DEMO_ENDPOINTS = [
  {
    id: 'demo-ep-1', name: 'openclaw-eu-north1-demo', state: 'RUNNING',
    publicIp: '203.0.113.10', image: 'cr.eu-north1.nebius.cloud/demo/openclaw-serverless:latest',
    platform: 'cpu-e2', region: 'eu-north1', regionName: 'EU North (Finland)', regionFlag: '🇫🇮',
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    health: { status: 'healthy', service: 'openclaw-serverless', model: 'zai-org/GLM-5', inference: 'token-factory', gateway_port: 18789 },
    dashboardToken: null
  },
  {
    id: 'demo-ep-2', name: 'nemoclaw-us-central1-demo', state: 'DEPLOYING',
    publicIp: null, image: 'cr.us-central1.nebius.cloud/demo/nemoclaw-serverless:latest',
    platform: 'cpu-e2', region: 'us-central1', regionName: 'US Central', regionFlag: '🇺🇸',
    createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    health: null, dashboardToken: null
  }
];

// ── Image config ──────────────────────────────────────────────────────────
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

// ── SSH key finder ─────────────────────────────────────────────────────────
function findSshKey() {
  const customPath = process.env.SSH_KEY_PATH;
  if (customPath && fs.existsSync(customPath)) return customPath;

  const candidates = [
    path.join(process.env.HOME, '.ssh', 'id_ed25519'),
    path.join(process.env.HOME, '.ssh', 'id_ed25519_vm'),
    path.join(process.env.HOME, '.ssh', 'id_rsa')
  ];
  return candidates.find(k => fs.existsSync(k)) || candidates[1];
}

// ── Nebius CLI helper ──────────────────────────────────────────────────────
function nebius(cmd, profile) {
  if (profile && !/^[a-zA-Z0-9_-]+$/.test(profile)) {
    throw new Error('Invalid profile name');
  }
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

// ── Deploy-time secrets (password stored per endpoint name) ────────────────
const MAX_PASSWORDS = 200;
const PASSWORDS_FILE = path.join(__dirname, 'endpoint-passwords.json');
const endpointPasswords = {}; // { endpointName: password }

// Load saved passwords from disk on startup
try {
  if (fs.existsSync(PASSWORDS_FILE)) {
    const saved = JSON.parse(fs.readFileSync(PASSWORDS_FILE, 'utf-8'));
    Object.assign(endpointPasswords, saved);
    console.log(`[Passwords] Loaded ${Object.keys(saved).length} saved passwords`);
  }
} catch (e) {
  console.error('[Passwords] Failed to load:', e.message);
}

function storePassword(name, password) {
  const keys = Object.keys(endpointPasswords);
  if (keys.length >= MAX_PASSWORDS) {
    delete endpointPasswords[keys[0]]; // evict oldest
  }
  endpointPasswords[name] = password;
  // Persist to disk
  try { fs.writeFileSync(PASSWORDS_FILE, JSON.stringify(endpointPasswords, null, 2)); } catch (e) { /* ignore */ }
}

// ── Routes: Auth ───────────────────────────────────────────────────────────

// Check if user is authenticated via nebius CLI
app.get('/api/auth/status', (req, res) => {
  if (IS_VERCEL) {
    req.session.authenticated = true;
    return res.json({ authenticated: true, user: 'Demo User', demo: true });
  }

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
  if (IS_VERCEL) return res.json([{ id: 'demo-secret', name: 'token-factory-key', description: 'Demo API key', state: 'ACTIVE' }]);

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
  if (IS_VERCEL) return res.json({ TOKEN_FACTORY_API_KEY: 'demo-key-not-real' });

  try {
    const id = validateId(req.params.id);
    const data = nebiusJson(`mysterybox payload get --secret-id ${id}`);
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

// Create a new secret in MysteryBox
app.post('/api/secrets', requireAuth, (req, res) => {
  if (IS_VERCEL) return res.json({ id: 'demo-new-secret', name: req.body.name });

  const { name, key, value } = req.body;
  if (!name || !key || !value) {
    return res.status(400).json({ error: 'name, key, and value are required' });
  }

  // Sanitize name (alphanumeric, hyphens, underscores only)
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '-').substring(0, 64);

  // Find a project ID to use as parent
  const projectId = Object.values(REGIONS)[0]?.projectId;
  if (!projectId) {
    return res.status(500).json({ error: 'No project configured. Check Nebius CLI setup.' });
  }

  try {
    const payloadJson = JSON.stringify([{ key, string_value: value }]);
    const result = nebius(
      `mysterybox secret create --name "${safeName}" --parent-id ${projectId} --secret-version-payload '${payloadJson}' --format json`
    );
    const parsed = JSON.parse(result);
    res.json({
      id: parsed.metadata?.id || 'unknown',
      name: safeName,
      message: 'Secret created'
    });
  } catch (err) {
    // If secret already exists, try to update it instead
    if (err.message.includes('AlreadyExists')) {
      try {
        // Find the existing secret ID
        const existing = nebiusJson('mysterybox secret list');
        const found = (existing.items || []).find(s => s.metadata?.name === safeName);
        if (found) {
          const payloadJson = JSON.stringify([{ key, string_value: value }]);
          nebius(`mysterybox secret-version create --parent-id ${found.metadata.id} --payload '${payloadJson}' --set-primary --format json`);
          return res.json({ id: found.metadata.id, name: safeName, message: 'Secret updated (new version)' });
        }
      } catch (updateErr) {
        return res.status(500).json({ error: `Failed to update existing secret: ${updateErr.message.split('\n')[0]}` });
      }
    }
    res.status(500).json({ error: `Failed to create secret: ${err.message.split('\n')[0]}` });
  }
});

// Update an existing secret's payload (creates new version)
app.put('/api/secrets/:id', requireAuth, (req, res) => {
  if (IS_VERCEL) return res.json({ message: 'Secret updated (demo)' });

  const { key, value } = req.body;
  if (!key || !value) {
    return res.status(400).json({ error: 'key and value are required' });
  }

  try {
    const id = validateId(req.params.id);
    const payloadJson = JSON.stringify([{ key, string_value: value }]);
    nebius(`mysterybox secret-version create --parent-id ${id} --payload '${payloadJson}' --set-primary --format json`);
    res.json({ message: 'Secret updated' });
  } catch (err) {
    res.status(500).json({ error: `Failed to update secret: ${err.message.split('\n')[0]}` });
  }
});

// ── Routes: Config ─────────────────────────────────────────────────────────

app.get('/api/regions', (req, res) => {
  res.json(IS_VERCEL ? DEMO_REGIONS : REGIONS);
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

// POST to keep API key out of query params / server logs
app.post('/api/models', requireAuth, async (req, res) => {
  if (IS_VERCEL) return res.json(DEMO_MODELS);

  // Return cached if fresh
  if (cachedModels && Date.now() - modelsCacheTime < MODELS_CACHE_TTL) {
    return res.json(cachedModels);
  }

  try {
    const tfUrl = 'https://api.tokenfactory.nebius.com/v1/models';

    // Try user-provided API key first, then try to get one from MysteryBox
    let authToken = req.body.apiKey || '';
    if (!authToken) {
      try {
        const secretsJson = execSync('nebius mysterybox secret list --format json', { encoding: 'utf-8', timeout: 15000 });
        const secrets = JSON.parse(secretsJson);
        const tfSecret = (secrets.items || []).find(s =>
          (s.metadata?.name || '').toLowerCase().includes('token') && (s.metadata?.name || '').toLowerCase().includes('key')
        );
        if (tfSecret) {
          const payloadJson = execSync(`nebius mysterybox payload get --secret-id ${validateId(tfSecret.metadata.id)} --format json`, { encoding: 'utf-8', timeout: 15000 });
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

app.get('/api/endpoints', requireAuth, async (req, res) => {
  if (IS_VERCEL) return res.json(DEMO_ENDPOINTS);

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

        // Extract model from env vars
        const envVars = ep.spec.environment_variables || [];
        const modelEnv = envVars.find(v => v.name === 'INFERENCE_MODEL');

        allEndpoints.push({
          id: ep.metadata.id,
          name: ep.metadata.name,
          state: ep.status.state,
          publicIp: ep.status.instances?.[0]?.public_ip || null,
          image: ep.spec.image,
          platform: ep.spec.platform,
          preset: ep.spec.preset || null,
          model: modelEnv?.value || null,
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

// ── Routes: Deploy ─────────────────────────────────────────────────────────

app.post('/api/deploy', requireAuth, async (req, res) => {
  if (IS_VERCEL) {
    return res.status(400).json({
      error: 'Demo mode — deploy is only available when running locally. Run: npx nemoclaw or git clone + npm start'
    });
  }

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
        if (!TENANT_ID) {
          return res.status(500).json({ error: 'No tenant ID found. Check your Nebius CLI config.' });
        }
        const projName = `openclaw-${region}`;
        console.log(`Setting up project for ${region}...`);

        // List all projects at tenant level and find one in the right region
        const firstProfile = Object.values(REGION_PROFILES)[0];
        const projects = nebiusJson(
          `iam project list --parent-id ${TENANT_ID}`, firstProfile
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
            `iam project create --name "${projName}" --parent-id ${TENANT_ID} --format json`,
            firstProfile
          );
          projectId = JSON.parse(projResult).metadata.id;
        }
        regionConfig.projectId = projectId;

        // Write the profile directly into ~/.nebius/config.yaml
        const configPath = process.env.NEBIUS_CONFIG_PATH || path.join(process.env.HOME, '.nebius', 'config.yaml');
        let config = fs.readFileSync(configPath, 'utf-8');

        if (!config.includes(`    ${region}:`)) {
          // Insert new profile after "profiles:" line
          const profileBlock = [
            `    ${region}:`,
            `        endpoint: api.nebius.cloud`,
            `        auth-type: federation`,
            `        federation-endpoint: auth.nebius.com`,
            `        parent-id: ${projectId}`,
            `        tenant-id: ${TENANT_ID}`
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
    const profile = REGION_PROFILES[region] || Object.values(REGION_PROFILES)[0];
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
    storePassword(name, webPassword);
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
  if (IS_VERCEL) return res.json({ status: 'demo — delete not available', id: req.params.id });

  try {
    const id = validateId(req.params.id);
    exec(`nebius ai endpoint delete --id ${id}`, { timeout: 60000 }, (err) => {
      if (err) console.error('Delete error:', err.message);
    });
    res.json({ status: 'deleting', id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/endpoints/:id/stop', requireAuth, (req, res) => {
  if (IS_VERCEL) return res.json({ status: 'demo' });
  try {
    const id = validateId(req.params.id);
    exec(`nebius ai endpoint stop --id ${id}`, { timeout: 120000 }, (err) => {
      if (err) console.error('Stop error:', err.message);
    });
    res.json({ status: 'stopping', id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/endpoints/:id/start', requireAuth, (req, res) => {
  if (IS_VERCEL) return res.json({ status: 'demo' });
  try {
    const id = validateId(req.params.id);
    exec(`nebius ai endpoint start --id ${id}`, { timeout: 120000 }, (err) => {
      if (err) console.error('Start error:', err.message);
    });
    res.json({ status: 'starting', id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Routes: SSH Tunnel for Dashboard ──────────────────────────────────────
const activeTunnels = {}; // { ip: { proc, localPort } }
let nextTunnelPort = 19000;

app.post('/api/tunnel', requireAuth, (req, res) => {
  let ip;
  try {
    ip = validateIp(req.body.ip);
  } catch (e) {
    return res.status(400).json({ error: 'Valid IP address is required' });
  }
  const { endpointName } = req.body;

  const sshKey = findSshKey();

  // Determine the tunnel URL scheme and host
  // When running remotely behind HTTPS nginx, use https + nginx dashboard proxy port
  // When running locally, use http://localhost
  const isLocal = req.hostname === 'localhost' || req.hostname === '127.0.0.1';
  const serverHost = isLocal ? 'localhost' : req.hostname;
  const tunnelScheme = isLocal ? 'http' : 'https';
  // nginx listens on 19443 and proxies to the tunnel port (19000)
  const DASHBOARD_HTTPS_PORT = 19443;

  // Reuse existing tunnel if alive
  if (activeTunnels[ip]) {
    const existing = activeTunnels[ip];
    if (!existing.proc.killed) {
      const reusePort = isLocal ? existing.localPort : DASHBOARD_HTTPS_PORT;
      return res.json({ url: `${tunnelScheme}://${serverHost}:${reusePort}`, localPort: existing.localPort, token: existing.gatewayToken || null, reused: true });
    }
    // Dead tunnel — clean up
    delete activeTunnels[ip];
  }

  const localPort = nextTunnelPort++;

  console.log(`[Tunnel] Creating SSH tunnel 0.0.0.0:${localPort} → ${ip} (container:18789)`);

  // Step 1: Try to get dashboard token
  // First check our stored passwords (set during deploy), then SSH extract as fallback
  let gatewayToken = null;

  if (endpointName && endpointPasswords[endpointName]) {
    gatewayToken = endpointPasswords[endpointName];
    console.log(`[Tunnel] Using stored OPENCLAW_WEB_PASSWORD for "${endpointName}" (${gatewayToken.length} chars)`);
  } else {
    // Fallback: SSH in and extract token from multiple sources
    try {
      // Try multiple extraction methods:
      // 1. Docker env vars (OPENCLAW_WEB_PASSWORD or OPENCLAW_GATEWAY_TOKEN)
      // 2. OpenClaw config file (gateway.auth.token)
      // 3. Process command line (OPENCLAW_GATEWAY_TOKEN=xxx set inline)
      const tokenCmd = `ssh -i ${sshKey} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 nebius@${ip} "` +
        `CID=\\$(sudo docker ps -q | head -1); ` +
        `TOKEN=\\$(sudo docker exec \\$CID env 2>/dev/null | grep -E 'OPENCLAW_WEB_PASSWORD|OPENCLAW_GATEWAY_TOKEN' | head -1 | cut -d= -f2-); ` +
        `if [ -z \\"\\$TOKEN\\" ]; then ` +
        `  TOKEN=\\$(sudo docker exec \\$CID cat /home/openclaw/.openclaw/openclaw.json 2>/dev/null | python3 -c \\"import sys,json;d=json.load(sys.stdin);print(d.get('gateway',{}).get('auth',{}).get('token',''))\\" 2>/dev/null); ` +
        `fi; ` +
        `echo \\$TOKEN"`;
      console.log(`[Tunnel] No stored password — fetching token via SSH from ${ip}...`);
      gatewayToken = execSync(tokenCmd, { timeout: 20000, encoding: 'utf-8' }).trim();
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
    '-L', `0.0.0.0:${localPort}:localhost:${remoteProxyPort}`,
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
      const urlPort = isLocal ? localPort : DASHBOARD_HTTPS_PORT;
      res.json({ url: `${tunnelScheme}://${serverHost}:${urlPort}`, localPort, token: gatewayToken || null, reused: false });
    }
  }, 2000);
});

// ── Routes: Auto-approve device pairing ──────────────────────────────────
app.post('/api/pair-approve', requireAuth, (req, res) => {
  let ip;
  try { ip = validateIp(req.body.ip); } catch (e) {
    return res.status(400).json({ error: 'Valid IP address is required' });
  }
  const token = req.body.token || '';
  const sshKey = findSshKey();

  console.log(`[Pairing] Auto-approving pairing for ${ip}...`);

  // Run approve in background with retries — the pairing request may arrive after a short delay
  const tokenFlag = token ? `--token ${token}` : '';
  const approveCmd = `ssh -i ${sshKey} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 nebius@${ip} ` +
    `"for i in 1 2 3 4 5 6; do ` +
    `  RESULT=\\$(sudo docker exec \\$(sudo docker ps -q | head -1) openclaw devices approve --latest ${tokenFlag} 2>&1); ` +
    `  if echo \\"\\$RESULT\\" | grep -q 'Approved'; then echo \\"\\$RESULT\\"; exit 0; fi; ` +
    `  sleep 3; ` +
    `done; echo 'No pending pairing requests found'"`;

  exec(approveCmd, { timeout: 30000, encoding: 'utf-8' }, (err, stdout, stderr) => {
    if (stdout && stdout.includes('Approved')) {
      console.log(`[Pairing] ${stdout.trim()}`);
    } else {
      console.log(`[Pairing] Result for ${ip}: ${(stdout || stderr || err?.message || 'unknown').trim()}`);
    }
  });

  // Return immediately — approval happens in the background
  res.json({ status: 'approving', message: 'Auto-approving pairing in background (up to 18s)' });
});

app.delete('/api/tunnel/:ip', requireAuth, (req, res) => {
  let ip;
  try { ip = validateIp(req.params.ip); } catch (e) {
    return res.status(400).json({ error: 'Invalid IP' });
  }
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
  const rawIp = url.searchParams.get('ip');

  let ip;
  try {
    ip = validateIp(rawIp);
  } catch (e) {
    ws.send(JSON.stringify({ type: 'error', data: 'Invalid IP address' }));
    ws.close();
    return;
  }

  console.log(`[Terminal] Connecting to ${ip}...`);
  ws.send(JSON.stringify({ type: 'status', data: `Connecting to ${ip}...\r\n` }));

  const sshKey = findSshKey();

  if (!sshKey) {
    ws.send(JSON.stringify({ type: 'error', data: 'No SSH key found. Check ~/.ssh/ for id_ed25519 or id_ed25519_vm.' }));
    ws.close();
    return;
  }

  // SSH into the endpoint, then exec into the container to run openclaw
  const sshProc = spawn('ssh', [
    '-tt',
    '-v',
    '-i', sshKey,
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ConnectTimeout=30',
    '-o', 'ConnectionAttempts=2',
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
      const msg = code === 255
        ? 'SSH connection failed. The endpoint may not have SSH enabled, or the connection timed out.'
        : null;
      if (msg) ws.send(JSON.stringify({ type: 'error', data: msg }));
      ws.send(JSON.stringify({ type: 'exit', code }));
      // Small delay before closing so the client receives the messages
      setTimeout(() => { if (ws.readyState === WebSocket.OPEN) ws.close(); }, 500);
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

// ── WebSocket Logs Stream ─────────────────────────────────────────────────
const wssLogs = new WebSocket.Server({ server, path: '/ws/logs' });

wssLogs.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const endpointId = url.searchParams.get('id');

  if (!endpointId || !/^[a-zA-Z0-9_-]+$/.test(endpointId)) {
    ws.send(JSON.stringify({ type: 'error', data: 'Invalid endpoint ID' }));
    ws.close();
    return;
  }

  // Find the profile for this endpoint
  let profile = null;
  for (const [region, info] of Object.entries(REGIONS)) {
    if (info.profile) {
      try {
        const data = nebiusJson('ai endpoint list', info.profile);
        if ((data.items || []).some(ep => ep.metadata.id === endpointId)) {
          profile = info.profile;
          break;
        }
      } catch (e) { /* skip */ }
    }
  }

  console.log(`[Logs] Streaming logs for ${endpointId}...`);
  ws.send(JSON.stringify({ type: 'status', data: `Connecting to logs for ${endpointId}...\r\n` }));

  const args = ['ai', 'endpoint', 'logs', endpointId, '--follow', '--timestamps', '--tail', '100'];
  if (profile) args.push('--profile', profile);

  const logProc = spawn('nebius', args, { env: { ...process.env, PATH: process.env.PATH } });

  logProc.stdout.on('data', (data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'data', data: data.toString('utf-8') }));
    }
  });

  logProc.stderr.on('data', (data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'data', data: data.toString('utf-8') }));
    }
  });

  logProc.on('close', (code) => {
    console.log(`[Logs] Stream ended for ${endpointId} (code ${code})`);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'exit', code }));
      ws.close();
    }
  });

  logProc.on('error', (err) => {
    console.error(`[Logs] Error for ${endpointId}:`, err.message);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'error', data: `Logs error: ${err.message}` }));
      ws.close();
    }
  });

  ws.on('close', () => {
    console.log(`[Logs] WebSocket closed for ${endpointId}`);
    logProc.kill('SIGTERM');
  });
});

// ── Health check ───────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'openclaw-deploy', uptime: process.uptime() });
});

// ── Proxy: single-IP routing to endpoints ─────────────────────────────────
// /proxy/<endpoint-name>/... → http://<endpoint-ip>:8080/...
// /proxy/<endpoint-name>/dashboard/... → http://<endpoint-ip>:18789/...
let proxyEndpointCache = {}; // { name: { ip, dashboardToken } }

// Refresh proxy cache from endpoint list
async function refreshProxyCache() {
  try {
    const allEndpoints = [];
    for (const [region, info] of Object.entries(REGIONS)) {
      const profile = info.profile;
      if (!profile) continue;
      try {
        const data = nebiusJson('ai endpoint list', profile);
        for (const ep of (data.items || [])) {
          const ip = ep.status.instances?.[0]?.public_ip;
          if (ip) {
            proxyEndpointCache[ep.metadata.name] = {
              ip,
              dashboardToken: endpointPasswords[ep.metadata.name] || null
            };
          }
        }
      } catch (e) { /* skip region */ }
    }
    console.log(`[Proxy] Cache refreshed: ${Object.keys(proxyEndpointCache).length} endpoints`);
  } catch (e) {
    console.error('[Proxy] Cache refresh error:', e.message);
  }
}

// Refresh cache periodically (every 2 min)
if (!IS_VERCEL) {
  refreshProxyCache();
  setInterval(refreshProxyCache, 120000);
}

app.use('/proxy/:endpointName', (req, res) => {
  const name = req.params.endpointName;
  const endpoint = proxyEndpointCache[name];

  if (!endpoint) {
    return res.status(404).json({ error: `Endpoint "${name}" not found or has no public IP` });
  }

  // Determine target port: /proxy/name/dashboard/* → :18789, else → :8080
  const subPath = req.url;
  let targetPort = 8080;
  let targetPath = subPath;

  if (subPath.startsWith('/dashboard')) {
    targetPort = 18789;
    targetPath = subPath.replace(/^\/dashboard/, '') || '/';
  }

  const targetUrl = `http://${endpoint.ip}:${targetPort}${targetPath}`;

  // Proxy the request
  const proxyReq = http.request(targetUrl, {
    method: req.method,
    headers: {
      ...req.headers,
      host: `${endpoint.ip}:${targetPort}`,
      'x-forwarded-for': req.ip,
      'x-forwarded-proto': req.protocol,
    }
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('error', (err) => {
    console.error(`[Proxy] Error proxying to ${targetUrl}:`, err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: `Proxy error: ${err.message}` });
    }
  });

  // Pipe request body for POST/PUT
  req.pipe(proxyReq, { end: true });
});

// API to list proxy URLs
app.get('/api/proxy-urls', requireAuth, (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const urls = {};
  for (const [name, ep] of Object.entries(proxyEndpointCache)) {
    urls[name] = {
      api: `${baseUrl}/proxy/${name}/`,
      dashboard: `${baseUrl}/proxy/${name}/dashboard/`,
      health: `${baseUrl}/proxy/${name}/`,
    };
  }
  res.json(urls);
});

// ── SPA fallback ───────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start server ───────────────────────────────────────────────────────────
if (!IS_VERCEL) {
  server.listen(PORT, () => {
    console.log(`\n  🦞 OpenClaw Deploy UI`);
    console.log(`  http://localhost:${PORT}\n`);
  });
}

// Export for Vercel serverless
module.exports = app;

// ── Graceful shutdown ──────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`\n  Received ${signal}, shutting down...`);

  // Close all SSH tunnels
  for (const [ip, tunnel] of Object.entries(activeTunnels)) {
    tunnel.proc.kill('SIGTERM');
    console.log(`  Closed tunnel to ${ip}`);
  }

  // Close WebSocket connections
  wss.clients.forEach(ws => ws.close());

  server.close(() => {
    console.log('  Server closed.');
    process.exit(0);
  });

  // Force exit after 5 seconds
  setTimeout(() => process.exit(1), 5000);
}

if (!IS_VERCEL) {
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
