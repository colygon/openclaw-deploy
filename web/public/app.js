// ── State ────────────────────────────────────────────────────────────────────
let state = {
  selectedImage: null,
  selectedModel: null,
  selectedRegion: null,
  selectedProvider: 'token-factory',
  authenticated: false
};

// Terminal state
let terminal = null;
let fitAddon = null;
let terminalWs = null;
let currentTerminalIp = null;
let currentTerminalName = null;

// Endpoints search/filter state
let endpointsCache = [];
let endpointFilter = 'all';
let endpointSearch = '';

// ── HTML escape helper (XSS prevention) ──────────────────────────────────────
function esc(str) {
  if (str == null) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

// ── Formatting helpers ──────────────────────────────────────────────────────
function formatState(state) {
  if (!state) return 'Unknown';
  return state.charAt(0) + state.slice(1).toLowerCase();
}

function formatPlatform(platform) {
  const names = { 'cpu-e2': 'Non-GPU Intel Ice Lake', 'cpu-d3': 'Non-GPU AMD EPYC' };
  return names[platform] || platform || 'Standard';
}

function formatPreset(preset) {
  // "2vcpu-8gb" → "2 vCPUs, 8 GiB"
  const m = preset.match(/^(\d+)vcpu-(\d+)gb$/i);
  if (m) return `${m[1]} vCPU${m[1] === '1' ? '' : 's'}, ${m[2]} GiB`;
  return preset;
}

function formatDate(iso) {
  if (!iso) return '\u2014';
  const d = new Date(iso), now = new Date(), diff = now - d;
  const mins = Math.floor(diff / 60000), hrs = Math.floor(diff / 3600000), days = Math.floor(diff / 86400000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return mins + 'm ago';
  if (hrs < 24) return hrs + 'h ago';
  if (days < 7) return days + 'd ago';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text);
}

function toggleKebab(btn) {
  const dd = btn.nextElementSibling;
  document.querySelectorAll('.kebab-dropdown').forEach(d => { if (d !== dd) d.classList.add('hidden'); });
  dd.classList.toggle('hidden');
}

// Close kebab menus on outside click
document.addEventListener('click', (e) => {
  if (!e.target.closest('.kebab-menu')) {
    document.querySelectorAll('.kebab-dropdown').forEach(d => d.classList.add('hidden'));
  }
});

// ── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  checkAuth();
  setupDelegatedListeners();
});

// ── Delegated event listeners (avoids inline onclick with user data) ──────────
function setupDelegatedListeners() {
  // Endpoint action buttons (Terminal, Dashboard, Delete)
  document.getElementById('endpoints-list').addEventListener('click', (e) => {
    // Handle copy button
    const copyBtn = e.target.closest('[data-copy]');
    if (copyBtn) {
      e.stopPropagation();
      copyToClipboard(copyBtn.dataset.copy);
      return;
    }

    const btn = e.target.closest('[data-action]');
    if (!btn) return;

    const action = btn.dataset.action;
    const ip = btn.dataset.ip;
    const name = btn.dataset.name;
    const id = btn.dataset.id;
    const token = btn.dataset.token || null;

    switch (action) {
      case 'terminal': openTerminal(ip, name); break;
      case 'dashboard': openDashboard(ip, name, token); break;
      case 'logs': openLogs(id, name); break;
      case 'stop': stopEndpoint(id, name); break;
      case 'start': startEndpoint(id, name); break;
      case 'delete': deleteEndpoint(id, name); break;
    }
  });

  // Endpoint search input
  const searchInput = document.getElementById('endpoint-search');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      endpointSearch = e.target.value.toLowerCase();
      renderEndpoints();
    });
  }

  // Endpoint filter tabs
  const filterContainer = document.getElementById('endpoint-filters');
  if (filterContainer) {
    filterContainer.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-filter]');
      if (!tab) return;
      endpointFilter = tab.dataset.filter;
      filterContainer.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      renderEndpoints();
    });
  }

  // Model picker items
  document.getElementById('model-picker-list').addEventListener('click', (e) => {
    const item = e.target.closest('[data-model-id]');
    if (!item) return;
    selectTokenFactoryModel(item.dataset.modelId, item);
  });

  // MysteryBox secret items (delegated across all provider secret lists)
  document.addEventListener('click', (e) => {
    const item = e.target.closest('[data-secret-id]');
    if (!item || !item.closest('.mb-secrets-list')) return;
    selectMysteryBoxSecret(item.dataset.secretId, item);
  });

  // Copy button clicks
  document.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('[data-copy]');
    if (copyBtn) {
      copyToClipboard(copyBtn.dataset.copy);
    }
  });
}

// ── Auth-aware fetch (auto re-authenticates on 401) ─────────────────────────
async function authFetch(url, options = {}) {
  let res = await fetch(url, options);
  if (res.status === 401) {
    // Session expired — silently re-authenticate via CLI
    const authRes = await fetch('/api/auth/status');
    const authData = await authRes.json();
    if (authData.authenticated) {
      // Retry the original request with fresh session
      res = await fetch(url, options);
    }
  }
  return res;
}

// ── Auth ─────────────────────────────────────────────────────────────────────
async function checkAuth() {
  try {
    const res = await fetch('/api/auth/status');
    const data = await res.json();

    if (data.authenticated) {
      state.authenticated = true;
      state.demo = !!data.demo;
      show('main-app');
      show('bottom-dock');
      hide('login-screen');
      document.getElementById('user-info').textContent = data.user;
      // Set avatar initials
      const initials = (data.user || '?').split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
      document.getElementById('user-avatar').textContent = initials;

      // Show demo banner if on Vercel
      if (state.demo) {
        showDemoBanner();
      }

      loadImages();
      loadModels();
      loadRegions();
      loadProviders();
      loadEndpoints();
      loadMysteryBoxSecrets();
    } else {
      show('login-screen');
      hide('main-app');
      hide('bottom-dock');
      if (data.error) {
        document.getElementById('login-hint').textContent = data.error;
      }
    }
  } catch (err) {
    show('login-screen');
    document.getElementById('login-hint').textContent = 'Cannot reach server';
  }
}

async function login() {
  const btn = document.getElementById('login-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Checking browser...';

  try {
    await fetch('/api/auth/login', { method: 'POST' });
    document.getElementById('login-hint').textContent =
      'Complete login in your browser, then this page will refresh...';

    // Poll for auth completion
    const poll = setInterval(async () => {
      const res = await fetch('/api/auth/status');
      const data = await res.json();
      if (data.authenticated) {
        clearInterval(poll);
        checkAuth();
      }
    }, 2000);

    // Stop polling after 2 minutes
    setTimeout(() => clearInterval(poll), 120000);
  } catch (err) {
    btn.disabled = false;
    btn.innerHTML = 'Login with Nebius';
    document.getElementById('login-hint').textContent = 'Login failed: ' + err.message;
  }
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  state.authenticated = false;
  show('login-screen');
  hide('main-app');
  hide('bottom-dock');
}

// ── Page Navigation ─────────────────────────────────────────────────────────
function switchPage(page) {
  // Update sidebar nav items
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.page === page);
  });

  // Update bottom dock items
  document.querySelectorAll('.dock-item').forEach(item => {
    item.classList.toggle('active', item.dataset.page === page);
  });

  // Show/hide pages
  document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
  const target = document.getElementById(`page-${page}`);
  if (target) target.classList.remove('hidden');

  // Refresh endpoints when switching to that page
  if (page === 'endpoints') {
    loadEndpoints();
  }
}

// ── Load Images ──────────────────────────────────────────────────────────────
async function loadImages() {
  try {
    const res = await authFetch('/api/images');
    const images = await res.json();
    const grid = document.getElementById('image-cards');
    grid.innerHTML = '';

    const keys = Object.keys(images);
    for (const [key, img] of Object.entries(images)) {
      const card = document.createElement('div');
      card.className = 'select-card';
      card.dataset.key = key;
      card.innerHTML = `
        <div class="card-icon">${esc(img.icon)}</div>
        <div class="card-title">${esc(img.name)}</div>
        <div class="card-desc">${esc(img.description)}</div>
      `;
      card.onclick = () => selectImage(key);
      grid.appendChild(card);
    }

    // Default: select first image (OpenClaw)
    if (keys.length > 0 && !state.selectedImage) {
      selectImage(keys[0]);
    }
  } catch (err) {
    console.error('Failed to load images:', err);
  }
}

function selectImage(key) {
  state.selectedImage = key;

  // Update card selection
  document.querySelectorAll('#image-cards .select-card').forEach(c => {
    c.classList.toggle('selected', c.dataset.key === key);
  });

  // Show/hide custom image input
  const customInput = document.getElementById('custom-image-input');
  if (key === 'custom') {
    customInput.classList.remove('hidden');
  } else {
    customInput.classList.add('hidden');
  }

  updateDeployButton();
}

// ── Load Models ──────────────────────────────────────────────────────────────
const FEATURED_MODELS = {
  'zai-org/GLM-5': {
    name: 'GLM-5',
    icon: '🧠',
    description: 'GLM-5 — latest generation reasoning model from Zhipu AI'
  },
  'MiniMaxAI/MiniMax-M2.5': {
    name: 'MiniMax M2.5',
    icon: '⚡',
    description: 'MiniMax-M2.5 — fast, powerful open-source model'
  }
};

function loadModels() {
  const grid = document.getElementById('model-cards');
  grid.innerHTML = '';

  // Featured model cards
  for (const [modelId, info] of Object.entries(FEATURED_MODELS)) {
    const card = document.createElement('div');
    card.className = 'select-card';
    card.dataset.key = modelId;
    card.innerHTML = `
      <div class="card-icon">${esc(info.icon)}</div>
      <div class="card-title">${esc(info.name)}</div>
      <div class="card-desc">${esc(info.description)}</div>
    `;
    card.onclick = () => selectModel(modelId);
    grid.appendChild(card);
  }

  // "Other" card
  const otherCard = document.createElement('div');
  otherCard.className = 'select-card';
  otherCard.dataset.key = '_other';
  otherCard.innerHTML = `
    <div class="card-icon">📋</div>
    <div class="card-title">Other</div>
    <div class="card-desc">Browse all Token Factory models</div>
  `;
  otherCard.onclick = () => selectModel('_other');
  grid.appendChild(otherCard);

  // Default: select GLM-5
  const defaultModel = Object.keys(FEATURED_MODELS)[0]; // 'zai-org/GLM-5'
  if (defaultModel && !state.selectedModel) {
    selectModel(defaultModel);
  }
}

function selectModel(key) {
  const picker = document.getElementById('model-picker');

  if (key === '_other') {
    // Show model picker, load models from Token Factory
    picker.classList.remove('hidden');
    loadTokenFactoryModels();
    // Don't set state yet — user picks from the list
    state.selectedModel = null;
  } else {
    picker.classList.add('hidden');
    state.selectedModel = key;
  }

  // Update card selection
  document.querySelectorAll('#model-cards .select-card').forEach(c => {
    c.classList.toggle('selected', c.dataset.key === key);
  });

  updateDeployButton();
}

async function loadTokenFactoryModels() {
  const list = document.getElementById('model-picker-list');
  list.innerHTML = '<div class="mb-loading"><span class="spinner"></span> Loading models from Token Factory...</div>';

  try {
    // Send API key via POST body (not query params) for security
    const apiKey = document.getElementById('tf-api-key')?.value || '';
    const res = await authFetch('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey })
    });
    if (!res.ok) throw new Error('Failed to load models');
    const models = await res.json();

    if (models.length === 0) {
      list.innerHTML = '<div class="mb-empty">No models available</div>';
      return;
    }

    list.innerHTML = models.map(m => {
      // Extract org from model ID (e.g., "deepseek-ai/DeepSeek-R1" → "deepseek-ai")
      const org = m.id.includes('/') ? m.id.split('/')[0] : '';
      const shortName = m.id.includes('/') ? m.id.split('/').slice(1).join('/') : m.id;
      // Show owned_by only if it's meaningful (not "system")
      const owner = m.owned_by && m.owned_by !== 'system' ? m.owned_by : org;
      return `
        <div class="model-item ${state.selectedModel === m.id ? 'selected' : ''}" data-model-id="${esc(m.id)}">
          <div class="model-item-info">
            <div class="model-item-name">${esc(shortName)}</div>
            ${owner ? `<div class="model-item-owner">${esc(owner)}</div>` : ''}
          </div>
          <span class="model-item-badge">select</span>
        </div>
      `;
    }).join('');
  } catch (err) {
    list.innerHTML = `<div class="mb-empty">Failed to load models: ${esc(err.message)}</div>`;
  }
}

function selectTokenFactoryModel(modelId, el) {
  state.selectedModel = modelId;

  // Update selection in the list
  document.querySelectorAll('.model-item').forEach(item => {
    item.classList.remove('selected');
  });
  if (el) el.classList.add('selected');

  // Update badge
  const badge = el?.querySelector('.model-item-badge');
  if (badge) {
    badge.textContent = '\u2713 selected';
    badge.classList.add('active');
  }

  updateDeployButton();
}

// ── Load Regions ─────────────────────────────────────────────────────────────
async function loadRegions() {
  try {
    const res = await authFetch('/api/regions');
    const regions = await res.json();
    const grid = document.getElementById('region-cards');
    grid.innerHTML = '';

    const keys = Object.keys(regions);
    for (const [key, region] of Object.entries(regions)) {
      const card = document.createElement('div');
      card.className = 'select-card';
      card.dataset.key = key;
      card.innerHTML = `
        <div class="card-icon">${esc(region.flag)}</div>
        <div class="card-title">${esc(region.name)}</div>
        <div class="card-desc">${esc(key)}</div>
      `;
      card.onclick = () => selectRegion(key);
      grid.appendChild(card);
    }

    // Default: select first region (eu-north1)
    if (keys.length > 0 && !state.selectedRegion) {
      selectRegion(keys[0]);
    }
  } catch (err) {
    console.error('Failed to load regions:', err);
  }
}

function selectRegion(key) {
  state.selectedRegion = key;

  document.querySelectorAll('#region-cards .select-card').forEach(c => {
    c.classList.toggle('selected', c.dataset.key === key);
  });

  updateDeployButton();
}

// ── Provider Selection ──────────────────────────────────────────────────────
const PROVIDERS = {
  'token-factory': {
    name: 'Token Factory',
    icon: '🏭',
    description: 'Nebius native inference API'
  },
  'openrouter': {
    name: 'OpenRouter',
    icon: '🔀',
    description: 'Unified API for AI models'
  },
  'huggingface': {
    name: 'Hugging Face',
    icon: '🤗',
    description: 'HF Inference API — Nebius provider'
  }
};

function loadProviders() {
  const grid = document.getElementById('provider-cards');
  grid.innerHTML = '';

  for (const [key, info] of Object.entries(PROVIDERS)) {
    const card = document.createElement('div');
    card.className = 'select-card';
    card.dataset.key = key;
    card.innerHTML = `
      <div class="card-icon">${esc(info.icon)}</div>
      <div class="card-title">${esc(info.name)}</div>
      <div class="card-desc">${esc(info.description)}</div>
    `;
    card.onclick = () => selectProvider(key);
    grid.appendChild(card);
  }

  // Default: select Token Factory
  selectProvider('token-factory');
}

function selectProvider(provider) {
  state.selectedProvider = provider;

  // Update card selection
  document.querySelectorAll('#provider-cards .select-card').forEach(c => {
    c.classList.toggle('selected', c.dataset.key === provider);
  });

  // Show/hide the correct API key group
  document.getElementById('api-key-group-tf').classList.toggle('hidden', provider !== 'token-factory');
  document.getElementById('api-key-group-openrouter').classList.toggle('hidden', provider !== 'openrouter');
  document.getElementById('api-key-group-huggingface').classList.toggle('hidden', provider !== 'huggingface');

  updateDeployButton();
}

function getActiveApiKey() {
  switch (state.selectedProvider) {
    case 'token-factory':
      return document.getElementById('tf-api-key').value;
    case 'openrouter':
      return document.getElementById('openrouter-api-key').value;
    case 'huggingface':
      return document.getElementById('huggingface-api-key').value;
    default:
      return '';
  }
}

// ── MysteryBox ──────────────────────────────────────────────────────────────
let mysteryBoxSecrets = []; // cached secrets

async function loadMysteryBoxSecrets() {
  // Show loading in all provider secret lists
  const containers = ['mb-secrets-tf', 'mb-secrets-openrouter', 'mb-secrets-huggingface'];
  containers.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '<div class="mb-loading"><span class="spinner"></span> Loading secrets...</div>';
  });

  try {
    const res = await authFetch('/api/secrets');
    mysteryBoxSecrets = await res.json();

    const activeSecrets = mysteryBoxSecrets.filter(s => s.state === 'ACTIVE');

    const html = activeSecrets.length === 0
      ? '<div class="mb-empty">No secrets in MysteryBox · <a href="https://console.nebius.com/mysterybox" target="_blank">Create one</a></div>'
      : activeSecrets.map(s => `
          <div class="mb-secret-item" data-secret-id="${esc(s.id)}">
            <div class="mb-secret-info">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              <span class="mb-secret-name">${esc(s.name)}</span>
              ${s.description ? `<span class="mb-secret-desc">· ${esc(s.description)}</span>` : ''}
            </div>
            <span class="mb-secret-badge">Use</span>
          </div>
        `).join('');

    containers.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = html;
    });
  } catch (err) {
    containers.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '';
    });
  }
}

async function selectMysteryBoxSecret(secretId, el) {
  el.classList.add('loading');
  const badge = el.querySelector('.mb-secret-badge');
  if (badge) badge.textContent = 'loading...';

  try {
    const res = await authFetch(`/api/secrets/${encodeURIComponent(secretId)}/payload`);
    const payload = await res.json();

    if (res.ok) {
      // Determine which API key field to fill based on active provider
      const fieldMap = {
        'token-factory': 'tf-api-key',
        'openrouter': 'openrouter-api-key',
        'huggingface': 'huggingface-api-key'
      };
      const fieldId = fieldMap[state.selectedProvider] || 'tf-api-key';
      const apiKeyField = document.getElementById(fieldId);

      // Try common key names, then fall back to first value
      const value = payload.TOKEN_API_KEY || payload.TOKEN_FACTORY_API_KEY || payload.OPENROUTER_API_KEY
        || payload.HUGGINGFACE_API_KEY || payload.HF_TOKEN || payload.api_key || Object.values(payload)[0] || '';

      if (value) {
        apiKeyField.value = value;
        updateDeployButton();

        if (badge) {
          badge.textContent = '✓ loaded';
          badge.style.background = 'rgba(34, 197, 94, 0.15)';
          badge.style.color = 'var(--green)';
        }
        // Reset badge after a moment
        setTimeout(() => {
          if (badge) {
            badge.textContent = 'Use';
            badge.style.background = '';
            badge.style.color = '';
          }
        }, 2000);
      } else {
        if (badge) badge.textContent = 'empty';
      }
    } else {
      throw new Error(payload.error || 'Failed to retrieve');
    }
  } catch (err) {
    if (badge) {
      badge.textContent = 'error';
      badge.style.background = 'rgba(239, 68, 68, 0.15)';
      badge.style.color = 'var(--red)';
    }
    el.classList.remove('loading');
  }
}

async function saveToMysteryBox(provider) {
  const fieldMap = { 'tf': 'tf-api-key', 'openrouter': 'openrouter-api-key', 'huggingface': 'huggingface-api-key' };
  const keyNameMap = { 'tf': 'TOKEN_FACTORY_API_KEY', 'openrouter': 'OPENROUTER_API_KEY', 'huggingface': 'HF_TOKEN' };
  const defaultNameMap = { 'tf': 'token-factory-key', 'openrouter': 'openrouter-key', 'huggingface': 'huggingface-key' };

  const apiKeyField = document.getElementById(fieldMap[provider]);
  const value = apiKeyField?.value?.trim();

  if (!value) {
    alert('Enter an API key first, then click Save to store it in MysteryBox.');
    return;
  }

  const name = prompt('Secret name:', defaultNameMap[provider]);
  if (!name) return;

  try {
    const res = await authFetch('/api/secrets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, key: keyNameMap[provider], value })
    });

    const data = await res.json();

    if (res.ok) {
      // Refresh the secrets list
      loadMysteryBoxSecrets();
    } else {
      alert('Failed to save: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    alert('Failed to save: ' + err.message);
  }
}

// ── Deploy ───────────────────────────────────────────────────────────────────
function updateDeployButton() {
  const btn = document.getElementById('deploy-btn');
  btn.disabled = !(state.selectedImage && state.selectedModel && state.selectedRegion);
}

// Listen for API key input on any provider key field
document.addEventListener('input', (e) => {
  if (['tf-api-key', 'openrouter-api-key', 'huggingface-api-key'].includes(e.target.id)) {
    updateDeployButton();
  }
});

async function deploy() {
  const btn = document.getElementById('deploy-btn');
  const statusEl = document.getElementById('deploy-status');

  const apiKey = getActiveApiKey();
  const providerLabels = { 'token-factory': 'Token Factory', 'openrouter': 'OpenRouter', 'huggingface': 'HuggingFace' };
  if (!apiKey) {
    statusEl.className = 'deploy-status error';
    statusEl.textContent = `${providerLabels[state.selectedProvider]} API key is required`;
    statusEl.classList.remove('hidden');
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Deploying...';
  statusEl.className = 'deploy-status pending';
  statusEl.textContent = 'Submitting deployment...';
  statusEl.classList.remove('hidden');

  try {
    const body = {
      imageType: state.selectedImage,
      model: state.selectedModel,
      region: state.selectedRegion,
      provider: state.selectedProvider,
      customImage: document.getElementById('custom-image-url')?.value || '',
      endpointName: document.getElementById('endpoint-name').value || '',
      apiKey: apiKey
    };

    const res = await authFetch('/api/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await res.json();

    if (res.ok) {
      statusEl.className = 'deploy-status success';
      statusEl.innerHTML = `
        <strong>${esc(data.message)}</strong><br>
        Endpoint: <code>${esc(data.name)}</code><br>
        Image: <code>${esc(data.image)}</code><br>
        <em>Refresh endpoints list in ~60s to see it running.</em>
      `;

      // Auto-refresh endpoints after delay
      setTimeout(loadEndpoints, 15000);
      setTimeout(loadEndpoints, 45000);
      setTimeout(loadEndpoints, 90000);
    } else {
      statusEl.className = 'deploy-status error';
      statusEl.textContent = data.error || 'Deployment failed';
    }
  } catch (err) {
    statusEl.className = 'deploy-status error';
    statusEl.textContent = 'Network error: ' + err.message;
  }

  btn.disabled = false;
  btn.innerHTML = `
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
    Deploy
  `;
}

// ── Endpoints ────────────────────────────────────────────────────────────────
async function loadEndpoints() {
  const list = document.getElementById('endpoints-list');
  list.innerHTML = '<div class="mb-loading"><span class="spinner"></span> Loading endpoints...</div>';
  try {
    const res = await authFetch('/api/endpoints');
    if (!res.ok) throw new Error('Failed to load');
    const endpoints = await res.json();

    // Store in cache
    endpointsCache = endpoints;

    // Update sidebar badge + dock badge
    const badge = document.getElementById('endpoints-count');
    const dockBadge = document.getElementById('dock-endpoints-count');
    if (endpoints.length > 0) {
      badge.textContent = endpoints.length;
      badge.classList.remove('hidden');
      if (dockBadge) { dockBadge.textContent = endpoints.length; dockBadge.classList.remove('hidden'); }
    } else {
      badge.classList.add('hidden');
      if (dockBadge) dockBadge.classList.add('hidden');
    }

    renderEndpoints();
  } catch (err) {
    const list = document.getElementById('endpoints-list');
    list.innerHTML = `<p class="empty-state">Could not load endpoints: ${esc(err.message)}</p>`;
  }
}

function renderEndpoints() {
  const list = document.getElementById('endpoints-list');

  // Filter by search + filter
  let filtered = endpointsCache;

  if (endpointFilter === 'active') {
    filtered = filtered.filter(ep => ep.state === 'RUNNING' || ep.state === 'STARTING');
  } else if (endpointFilter === 'inactive') {
    filtered = filtered.filter(ep => ep.state !== 'RUNNING' && ep.state !== 'STARTING');
  }

  if (endpointSearch) {
    filtered = filtered.filter(ep =>
      (ep.name || '').toLowerCase().includes(endpointSearch) ||
      (ep.id || '').toLowerCase().includes(endpointSearch) ||
      (ep.state || '').toLowerCase().includes(endpointSearch)
    );
  }

  if (filtered.length === 0) {
    list.innerHTML = '<p class="empty-state">No endpoints found</p>';
    return;
  }

  list.innerHTML = filtered.map(ep => {
    const h = ep.health;
    const presetLabel = ep.preset ? formatPreset(ep.preset) : '';
    const model = h?.model ? (h.model.split('/').pop()) : (ep.model ? ep.model.split('/').pop() : '');

    const startStopBtn = (ep.state === 'RUNNING' || ep.state === 'STARTING')
      ? `<button class="btn-action-icon btn-stop" data-action="stop" data-id="${esc(ep.id)}" data-name="${esc(ep.name)}" title="Stop"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg></button>`
      : `<button class="btn-action-icon btn-start" data-action="start" data-id="${esc(ep.id)}" data-name="${esc(ep.name)}" title="Start"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="8,5 20,12 8,19"/></svg></button>`;

    const actions = [];
    if (ep.publicIp && ep.state === 'RUNNING') {
      actions.push(`<button class="btn-action-pill btn-terminal" data-action="terminal" data-ip="${esc(ep.publicIp)}" data-name="${esc(ep.name)}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg> Terminal</button>`);
      actions.push(`<button class="btn-action-pill btn-dashboard" data-action="dashboard" data-ip="${esc(ep.publicIp)}" data-name="${esc(ep.name)}" ${ep.dashboardToken ? `data-token="${esc(ep.dashboardToken)}"` : ''}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg> Dashboard</button>`);
    }
    const actionButtons = actions.join('');

    return `<div class="endpoint-row" data-state="${esc(ep.state)}" onclick="toggleEndpointExpand(this, event)">
      <div class="endpoint-col col-name">
        ${startStopBtn}
        <div class="endpoint-icon">${ep.image?.includes('nemoclaw') ? '\uD83D\uDD31' : '\uD83E\uDD9E'}</div>
        <div class="endpoint-name-group">
          <span class="endpoint-name">${esc(ep.name)}</span>
          ${model ? `<span class="endpoint-model">${esc(model)}</span>` : ''}
        </div>
      </div>
      <div class="endpoint-col col-status">
        <span class="status-badge status-${esc(ep.state)}">${formatState(ep.state)}</span>
      </div>
      <div class="endpoint-col col-created">${formatDate(ep.createdAt)}</div>
      <div class="endpoint-col col-actions">
        ${actionButtons}
        <div class="kebab-menu">
          <button class="btn-kebab" onclick="toggleKebab(this)">&#8942;</button>
          <div class="kebab-dropdown hidden">
            <button class="kebab-item kebab-delete" data-action="delete" data-id="${esc(ep.id)}" data-name="${esc(ep.name)}">Delete endpoint</button>
          </div>
        </div>
      </div>
      <div class="endpoint-details">
        <div class="endpoint-detail-item">
          <span class="endpoint-detail-label">ID</span>
          <span class="endpoint-detail-value"><span class="endpoint-id">${esc(ep.id)} <button class="btn-copy" data-copy="${esc(ep.id)}" title="Copy ID"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button></span></span>
        </div>
        <div class="endpoint-detail-item">
          <span class="endpoint-detail-label">Platform</span>
          <span class="endpoint-detail-value">${esc(formatPlatform(ep.platform))}</span>
        </div>
        <div class="endpoint-detail-item">
          <span class="endpoint-detail-label">Region</span>
          <span class="endpoint-detail-value">${esc(ep.regionFlag)} ${esc(ep.regionName)}</span>
        </div>
        <div class="endpoint-detail-item">
          <span class="endpoint-detail-label">Resources</span>
          <span class="endpoint-detail-value">${esc(presetLabel || 'pending...')}</span>
        </div>
        ${model ? `<div class="endpoint-detail-item">
          <span class="endpoint-detail-label">Model</span>
          <span class="endpoint-detail-value">${esc(model)}</span>
        </div>` : ''}
        ${h?.inference ? `<div class="endpoint-detail-item">
          <span class="endpoint-detail-label">Inference</span>
          <span class="endpoint-detail-value">${esc(h.inference)}</span>
        </div>` : ''}
        ${ep.publicIp ? `<div class="endpoint-detail-item">
          <span class="endpoint-detail-label">IP Address</span>
          <span class="endpoint-detail-value">${esc(ep.publicIp)}</span>
        </div>` : ''}
        <div class="endpoint-detail-item">
          <span class="endpoint-detail-label">Proxy URL</span>
          <span class="endpoint-detail-value"><a href="/proxy/${esc(ep.name)}/" target="_blank" class="proxy-link">/proxy/${esc(ep.name)}/</a> <button class="btn-copy" data-copy="${location.origin}/proxy/${esc(ep.name)}/" title="Copy URL"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button></span>
        </div>
      </div>
    </div>`;
  }).join('');
}

function toggleEndpointExpand(row, event) {
  // Don't toggle if clicking a button or link
  if (event.target.closest('button, a, .kebab-menu')) return;
  row.classList.toggle('expanded');
}

async function deleteEndpoint(id, name) {
  if (!confirm(`Delete endpoint "${name}"?`)) return;

  try {
    await authFetch(`/api/endpoints/${encodeURIComponent(id)}`, { method: 'DELETE' });
    setTimeout(loadEndpoints, 2000);
  } catch (err) {
    alert('Delete failed: ' + err.message);
  }
}

async function stopEndpoint(id, name) {
  if (!confirm(`Stop endpoint "${name}"?`)) return;
  try {
    const res = await authFetch(`/api/endpoints/${encodeURIComponent(id)}/stop`, { method: 'POST' });
    if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Stop failed'); }
    loadEndpoints();
  } catch (err) {
    alert('Stop failed: ' + err.message);
  }
}

async function startEndpoint(id, name) {
  if (!confirm(`Start endpoint "${name}"?`)) return;
  try {
    const res = await authFetch(`/api/endpoints/${encodeURIComponent(id)}/start`, { method: 'POST' });
    if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Start failed'); }
    loadEndpoints();
  } catch (err) {
    alert('Start failed: ' + err.message);
  }
}

// ── Terminal ─────────────────────────────────────────────────────────────────
function openTerminal(ip, name) {
  currentTerminalIp = ip;
  currentTerminalName = name;

  // Update header
  document.getElementById('terminal-title').textContent = `Terminal — ${name} (${ip})`;
  setTerminalStatus('connecting');

  // Show panel
  const panel = document.getElementById('terminal-panel');
  panel.classList.remove('hidden');
  document.body.classList.add('terminal-open');

  // Initialize or reset xterm
  const container = document.getElementById('terminal-container');
  if (terminal) {
    terminal.dispose();
  }
  container.innerHTML = '';

  terminal = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', 'Menlo', monospace",
    theme: {
      background: '#0c0c14',
      foreground: '#e4e4ef',
      cursor: '#6366f1',
      selectionBackground: 'rgba(99, 102, 241, 0.3)',
      black: '#0a0a0f',
      red: '#ef4444',
      green: '#22c55e',
      yellow: '#f59e0b',
      blue: '#6366f1',
      magenta: '#8b5cf6',
      cyan: '#06b6d4',
      white: '#e4e4ef',
      brightBlack: '#888899',
      brightRed: '#f87171',
      brightGreen: '#4ade80',
      brightYellow: '#fbbf24',
      brightBlue: '#818cf8',
      brightMagenta: '#a78bfa',
      brightCyan: '#22d3ee',
      brightWhite: '#ffffff'
    },
    allowProposedApi: true
  });

  fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);

  try {
    const webLinksAddon = new WebLinksAddon.WebLinksAddon();
    terminal.loadAddon(webLinksAddon);
  } catch (e) {}

  terminal.open(container);

  // Wait a tick for DOM to render, then fit
  setTimeout(() => {
    fitAddon.fit();
  }, 50);

  // Handle window resize
  window._terminalResizeHandler = () => {
    if (fitAddon) fitAddon.fit();
  };
  window.addEventListener('resize', window._terminalResizeHandler);

  // Connect WebSocket
  connectTerminalWs(ip);

  // Forward keyboard input to SSH
  terminal.onData((data) => {
    if (terminalWs && terminalWs.readyState === WebSocket.OPEN) {
      terminalWs.send(JSON.stringify({ type: 'input', data }));
    }
  });
}

function connectTerminalWs(ip) {
  // Close existing connection
  if (terminalWs) {
    terminalWs.close();
    terminalWs = null;
  }

  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${proto}//${window.location.host}/ws/terminal?ip=${encodeURIComponent(ip)}`;

  terminalWs = new WebSocket(wsUrl);

  terminalWs.onopen = () => {
    console.log('[Terminal] WebSocket connected');
  };

  terminalWs.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);

      switch (msg.type) {
        case 'data':
          // Decode base64-encoded SSH terminal data
          if (msg.encoding === 'base64') {
            const bytes = Uint8Array.from(atob(msg.data), c => c.charCodeAt(0));
            terminal.write(bytes);
          } else {
            terminal.write(msg.data);
          }
          setTerminalStatus('connected');
          break;
        case 'status':
          terminal.write(msg.data);
          break;
        case 'error':
          terminal.write(`\r\n\x1b[31mError: ${msg.data}\x1b[0m\r\n`);
          setTerminalStatus('disconnected');
          break;
        case 'exit':
          terminal.write(`\r\n\x1b[33m[Session ended — code ${msg.code}]\x1b[0m\r\n`);
          setTerminalStatus('disconnected');
          break;
      }
    } catch (e) {
      terminal.write(event.data);
    }
  };

  terminalWs.onerror = (err) => {
    console.error('[Terminal] WebSocket error:', err);
    terminal.write('\r\n\x1b[31mWebSocket connection error\x1b[0m\r\n');
    setTerminalStatus('disconnected');
  };

  terminalWs.onclose = () => {
    console.log('[Terminal] WebSocket closed');
    setTerminalStatus('disconnected');
  };
}

function setTerminalStatus(status) {
  const el = document.getElementById('terminal-status');
  el.textContent = status;
  el.className = `terminal-status ${status}`;
}

function closeTerminal() {
  // Close WebSocket
  if (terminalWs) {
    terminalWs.close();
    terminalWs = null;
  }

  // Dispose terminal
  if (terminal) {
    terminal.dispose();
    terminal = null;
  }

  // Remove resize handler
  if (window._terminalResizeHandler) {
    window.removeEventListener('resize', window._terminalResizeHandler);
  }

  // Hide panel
  document.getElementById('terminal-panel').classList.add('hidden');
  document.body.classList.remove('terminal-open');
  currentTerminalIp = null;
  currentTerminalName = null;
}

function reconnectTerminal() {
  if (currentTerminalIp) {
    setTerminalStatus('connecting');
    if (terminal) {
      terminal.write('\r\n\x1b[33m[Reconnecting...]\x1b[0m\r\n');
    }
    connectTerminalWs(currentTerminalIp);
  }
}

// ── Logs Viewer ──────────────────────────────────────────────────────────────
let logsWs = null;
let logsTerminal = null;

function openLogs(endpointId, name) {
  const panel = document.getElementById('logs-panel');
  const title = document.getElementById('logs-title');
  const container = document.getElementById('logs-terminal');

  title.textContent = name || endpointId;
  panel.classList.remove('hidden');
  document.body.classList.add('logs-open');

  // Clean up previous
  if (logsTerminal) { logsTerminal.dispose(); logsTerminal = null; }
  if (logsWs) { logsWs.close(); logsWs = null; }

  container.innerHTML = '';

  // Create xterm for logs (read-only)
  logsTerminal = new Terminal({
    cursorBlink: false,
    disableStdin: true,
    fontSize: 13,
    fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', 'Menlo', monospace",
    theme: {
      background: '#0d0d14',
      foreground: '#e4e4ef',
      cursor: '#0d0d14'
    },
    scrollback: 5000
  });

  const fitAddon = new FitAddon.FitAddon();
  logsTerminal.loadAddon(fitAddon);
  logsTerminal.open(container);
  fitAddon.fit();

  window._logsResizeHandler = () => fitAddon.fit();
  window.addEventListener('resize', window._logsResizeHandler);

  logsTerminal.write('\x1b[36mConnecting to logs...\x1b[0m\r\n');

  // Connect WebSocket
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  logsWs = new WebSocket(`${proto}://${location.host}/ws/logs?id=${encodeURIComponent(endpointId)}`);

  logsWs.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      switch (msg.type) {
        case 'data':
          // Replace newlines with \r\n for xterm
          logsTerminal.write(msg.data.replace(/\n/g, '\r\n'));
          break;
        case 'status':
          logsTerminal.write(`\x1b[36m${msg.data}\x1b[0m`);
          break;
        case 'error':
          logsTerminal.write(`\r\n\x1b[31m${msg.data}\x1b[0m\r\n`);
          break;
        case 'exit':
          logsTerminal.write(`\r\n\x1b[33m[Stream ended — code ${msg.code}]\x1b[0m\r\n`);
          break;
      }
    } catch (e) {
      logsTerminal.write(event.data);
    }
  };

  logsWs.onerror = () => {
    logsTerminal.write('\r\n\x1b[31m[WebSocket error]\x1b[0m\r\n');
  };

  logsWs.onclose = () => {
    logsTerminal.write('\r\n\x1b[33m[Connection closed]\x1b[0m\r\n');
  };
}

function closeLogs() {
  if (logsWs) { logsWs.close(); logsWs = null; }
  if (logsTerminal) { logsTerminal.dispose(); logsTerminal = null; }
  if (window._logsResizeHandler) {
    window.removeEventListener('resize', window._logsResizeHandler);
  }
  document.getElementById('logs-panel').classList.add('hidden');
  document.body.classList.remove('logs-open');
}

// ── Dashboard ────────────────────────────────────────────────────────────────
async function openDashboard(ip, name, token) {
  // Route through our HTTPS proxy for secure context (required by Control UI)
  if (token) {
    const proxyBase = `${location.origin}/proxy/${encodeURIComponent(name)}/dashboard`;
    const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProto}//${location.host}/proxy/${encodeURIComponent(name)}/dashboard`;
    const hashParams = new URLSearchParams();
    hashParams.set('token', token);
    hashParams.set('gatewayUrl', wsUrl);
    const dashUrl = `${proxyBase}/#${hashParams.toString()}`;
    window.open(dashUrl, `dashboard-${name}`);
    // Auto-approve device pairing in background
    autoPairApprove(ip, token);
    return;
  }

  // Fallback: SSH tunnel for older endpoints without port 18789 exposed
  try {
    const res = await authFetch('/api/tunnel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip, endpointName: name })
    });

    const data = await res.json();

    if (res.ok) {
      let dashUrl = data.url;
      // Control UI reads token + gatewayUrl from hash params
      // Both must be provided together so the token is applied immediately
      const wsUrl = dashUrl.replace(/^http/, 'ws');
      const hashParams = new URLSearchParams();
      if (data.token) hashParams.set('token', data.token);
      hashParams.set('gatewayUrl', wsUrl);
      const hash = hashParams.toString();
      if (hash) dashUrl += '#' + hash;
      window.open(dashUrl, `dashboard-${ip}`);
      // Auto-approve device pairing in background
      autoPairApprove(ip, data.token);
    } else {
      throw new Error(data.error || 'Failed to create tunnel');
    }
  } catch (err) {
    alert(`Dashboard error: ${err.message}`);
  }
}

// ── Auto-approve device pairing ──────────────────────────────────────────────
function autoPairApprove(ip, token) {
  // Fire and forget — the server retries for up to 18s in the background
  authFetch('/api/pair-approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ip, token })
  }).catch(() => {}); // ignore errors
}

// ── Demo Banner ──────────────────────────────────────────────────────────────
function showDemoBanner() {
  const banner = document.createElement('div');
  banner.className = 'demo-banner';
  banner.innerHTML = `
    <span>🦞 <strong>Demo Mode</strong> — This is a live preview. To deploy real endpoints, run locally:</span>
    <code>git clone https://github.com/colygon/openclaw-deploy && cd nemoclaw/web && npm install && npm start</code>
    <button onclick="this.parentElement.remove()" class="demo-close">&times;</button>
  `;
  document.body.prepend(banner);
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function show(id) { document.getElementById(id).classList.remove('hidden'); }
function hide(id) { document.getElementById(id).classList.add('hidden'); }
