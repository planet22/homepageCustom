/**
 * Dual-mode Dockhand / Docker Engine userscript
 * ------------------------------------------------
 * Set BACKEND.MODE to 'dockhand' or 'docker'.
 *
 * Docker mode expects the Docker Engine API over HTTP
 * (e.g. tecnativa/docker-socket-proxy, socat, or any reverse-proxy
 * that exposes /var/run/docker.sock on a reachable URL).
 * Browser JS cannot talk to a Unix socket directly.
 */

const DEBUG = false;

/* long press on mobile */
const HOLD_DURATION = 1000; // 0 = disable

/* network check */
const INVALID_NETWORK_CHECK = true;
const INVALID_NETWORK_NOTIFICATION = false;
const CHECK_INTERVAL = 0; // 0 = once only
const CONCURRENCY = 5; // Dockhand / general

/* Docker backend performance */
const DOCKER_STATS_CONCURRENCY = 12;   // parallel /stats calls
const DOCKER_LIST_CACHE_MS = 2500;     // reuse container list briefly
const DOCKER_INSPECT_CACHE_MS = 60000; // cache inspect for netmode checks
/* one-shot is faster but often returns empty/incomplete blkio (esp. cgroup v2),
   which made disk Δ look tiny vs Dockhand. false = let Docker take a proper sample. */
const DOCKER_STATS_ONE_SHOT = false;

/* stats */
const STATS_REFRESH_MS = 12000;

/* card stats */
const CARD_STATS_LAYOUT = 'single-nograph'; // 'single' | 'stacked' | 'single-nograph'
const SHOW_CPU_ON_CARDS = true;
const SHOW_MEMORY_ON_CARDS = true;
const CARD_STATS_DEFAULT_VISIBLE = false;
/* Hide "/ 8GiB" when the limit is the shared host RAM (no explicit mem_limit).
   Applies to cards, stacks, and history. Explicit per-container limits still show. */
const HIDE_HOST_MEM_LIMIT = true;

/* ---------- Feature toggles ---------- */
const FEATURES = {
  CAPABILITY_PROBE: true,          // detect read-only proxy; hide write controls
  SELECTIVE_STATS: true,           // only /stats for homepage cards + expanded stacks
  HEALTH_BADGES: false,             // healthy / unhealthy / restart count on cards
  STACKS_FILTER: true,             // search box in stacks panel
  PIN_FAVORITES: true,             // pin stacks to top (localStorage)
  ALERTS: true,                    // threshold toasts
  EXPORT_HISTORY: true,            // CSV download from history panel
  BACKEND_SWITCH: true,            // menu toggle Dockhand ↔ Docker (reloads)
  COMPOSE_PROJECT_ACTIONS: true,   // explicit "restart project" on compose stacks
  STALE_INDICATOR: true,           // dim FAB when stats are stale
  CONFIRM_ACTIONS: true,          // themed confirm before stack/backend actions
  LOG_TAIL: true,                  // last N log lines from expanded stack rows
  UPTIME: true,                    // show uptime / exit info on nested rows
  PRUNE: false,                     // prune unused containers/images (menu)
  DELTA_COMBO: true,               // history combo charts: absolute ↔ delta mode
  STATE_EVENTS: true,              // toast when a tracked container dies / restarts
  RESTART_LOOP_ALERTS: true,       // toast + persistent card badge when a container crash-loops
  PERSIST_CARD_STATS: true         // remember card-stats toggle in localStorage
};

const LOG_TAIL_LINES = 100;
const CARD_STATS_STORAGE_KEY = 'dh-card-stats-visible';

const ALERTS_CONFIG = {
  CPU_PCT: 90,          // toast when container CPU stays above this
  MEM_PCT: 90,          // toast when container mem % stays above this
  STREAK: 2,            // consecutive polls over threshold before toast
  COOLDOWN_MS: 5 * 60 * 1000
};

const RESTART_LOOP_CONFIG = {
  WINDOW_MS: 5 * 60 * 1000,   // rolling window to count restarts within
  THRESHOLD: 3,               // this many restarts inside WINDOW_MS = "looping"
  COOLDOWN_MS: 10 * 60 * 1000 // minimum gap between repeat toasts for the same container
};

const STALE_AFTER_MS = STATS_REFRESH_MS * 2.5;
const PINS_STORAGE_KEY = 'dh-pinned-stacks';
const BACKEND_MODE_KEY = 'dh-backend-mode';

/* history / detailed view */
const HISTORY_MINUTES = 20;
// STATS_REFRESH_MS === 0 is a valid "polling disabled" sentinel elsewhere (see pullStats setup),
// so guard against a divide-by-zero here that would otherwise make this Infinity and let
// window.__dhStatsHistory grow unbounded (storeStat() would never trim old entries).
const HISTORY_MAX_POINTS = STATS_REFRESH_MS > 0
  ? Math.ceil((HISTORY_MINUTES * 60) / (STATS_REFRESH_MS / 1000)) + 5
  : Math.ceil((HISTORY_MINUTES * 60) / 12) + 5; // fall back to the 12s default cadence
const HISTORY_PANEL_DEFAULT_OPEN = false;

/* ====================== Backend configuration ====================== */
/**
 * MODE:
 *   'dockhand' – use Dockhand REST API (original behaviour)
 *   'docker'   – use Docker Engine API over HTTP (socket proxy / TCP)
 *
 * Runtime override: localStorage 'dh-backend-mode' (set via menu switch).
 *
 * For docker mode you typically run something like:
 *   tecnativa/docker-socket-proxy  (recommended – least privilege)
 *   or  socat TCP-LISTEN:2375,fork UNIX-CONNECT:/var/run/docker.sock
 * and point BASE_URL at that endpoint.
 */
const __savedBackendMode = (() => {
  try {
    const m = localStorage.getItem(BACKEND_MODE_KEY);
    if (m === 'dockhand' || m === 'docker') return m;
  } catch (_) {}
  return null;
})();

const BACKEND = {
  MODE: __savedBackendMode || 'docker', // 'dockhand' | 'docker'

  // ---- Dockhand settings (used when MODE === 'dockhand') ----
  DOCKHAND: {
    EXT_URL: 'http://dockhand.example.com',
    BASE_URL: 'http://dockhand.example.com/api',
    TOKEN: 'YOUR_DOCKHAND_TOKEN_HERE',
    ENV: '1',
    POLL_INTERVAL: 8000,
    HIDE_BUTTONS: ['dockhand'],
    HIDE_STACKS: []
  },

 // ---- Docker Engine settings (used when MODE === 'docker') ----
  DOCKER: {
    // HTTP endpoint that speaks the Docker Engine API
    // e.g. 'http://192.168.1.10:2375'  or  'https://docker.example.com'
    BASE_URL: 'http://docker.example.com',
    // Optional: set if your proxy requires auth
    // TOKEN: null,                     // Bearer token if needed
    // USERNAME / PASSWORD for Basic auth (leave empty if unused)
    USERNAME: '',
    PASSWORD: '',
    // Version path segment (Docker defaults to /v1.41 or latest)
    // Leave empty to use the unversioned paths most proxies accept
    API_VERSION: '', // e.g. 'v1.44'  →  /v1.44/containers/...
    POLL_INTERVAL: 8000,
    HIDE_BUTTONS: [],
    HIDE_STACKS: [],
    // When grouping "stacks" from compose labels
    COMPOSE_PROJECT_LABEL: 'com.docker.compose.project',
    COMPOSE_SERVICE_LABEL: 'com.docker.compose.service'
  }
};

/* Convenience aliases so the rest of the file stays readable */
const DH = BACKEND.MODE === 'dockhand' ? BACKEND.DOCKHAND : BACKEND.DOCKER;
const IS_DOCKER = BACKEND.MODE === 'docker';

const lookups = ['vpn'];
let idLookup;

/* ---------- shared helpers ---------- */
window.__dhStatsCache = window.__dhStatsCache || new Map();
window.__dhStatsCachePrev = window.__dhStatsCachePrev || new Map();
window.__dhStatsHistory = window.__dhStatsHistory || new Map();
window.__dhLiveKeys = window.__dhLiveKeys || new Set(); // histKeys present in the latest stats pull
window.__dhLastStatsOkAt = window.__dhLastStatsOkAt || 0;
window.__dhCapabilities = window.__dhCapabilities || { write: null, probed: false }; // write: true|false|null
window.__dhHealthCache = window.__dhHealthCache || new Map(); // name -> { health, restartCount }
window.__dhExpandedStackIds = window.__dhExpandedStackIds || new Set();
window.__dhStatsInterest = window.__dhStatsInterest || new Set(); // normalized names we care about
window.__dhAlertStreak = window.__dhAlertStreak || new Map();
window.__dhAlertCooldown = window.__dhAlertCooldown || new Map();
window.__dhRestartEvents = window.__dhRestartEvents || new Map();      // name -> [{t, n}] restart deltas within the window
window.__dhRestartCountPrev = window.__dhRestartCountPrev || new Map(); // name -> last-seen RestartCount (to diff against)
window.__dhRestartLoopCooldown = window.__dhRestartLoopCooldown || new Map();
window.__dhRestartLoopSet = window.__dhRestartLoopSet || new Map();    // name -> { count, windowMin } while actively looping

function loadPins() {
  try {
    const raw = localStorage.getItem(PINS_STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch (_) {
    return new Set();
  }
}
function savePins(set) {
  try {
    localStorage.setItem(PINS_STORAGE_KEY, JSON.stringify([...set]));
  } catch (_) {}
}
let __pinnedStacks = loadPins();

/* Cache the DOM-derived card name set; only re-scan the DOM when it actually
   changes (via onDomChange) instead of on every stats poll / render pass. */
let __dhCardNameCache = null;
function invalidateCardNameCache() {
  __dhCardNameCache = null;
}

function rebuildStatsInterest() {
  if (!__dhCardNameCache) {
    const set = new Set();
    document.querySelectorAll('.service-card, li.service, [class="service"]').forEach(el => {
      const id = el.id || el.closest('[id]')?.id;
      const name = extractContainerName(id);
      if (name) set.add(normalize(name));
    });
    __dhCardNameCache = set;
  }
  const combined = new Set(__dhCardNameCache);
  // Expanded stack containers registered by stacks module
  for (const n of window.__dhStatsInterestExtra || []) combined.add(normalize(n));
  window.__dhStatsInterest = combined;
  return combined;
}
window.__dhStatsInterestExtra = window.__dhStatsInterestExtra || new Set();

/* ====================== Unified API layer ====================== */

function apiHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (IS_DOCKER) {
    if (BACKEND.DOCKER.TOKEN) h.Authorization = `Bearer ${BACKEND.DOCKER.TOKEN}`;
    else if (BACKEND.DOCKER.USERNAME) {
      h.Authorization = 'Basic ' + btoa(`${BACKEND.DOCKER.USERNAME}:${BACKEND.DOCKER.PASSWORD || ''}`);
    }
  } else {
    h.Authorization = `Bearer ${BACKEND.DOCKHAND.TOKEN}`;
  }
  return h;
}

function dockerPath(path) {
  const ver = BACKEND.DOCKER.API_VERSION ? `/${BACKEND.DOCKER.API_VERSION}` : '';
  return `${BACKEND.DOCKER.BASE_URL}${ver}${path}`;
}

async function rawFetch(url, method = 'GET', body = null) {
  const opts = {
    method,
    credentials: IS_DOCKER ? 'omit' : 'include',
    headers: apiHeaders()
  };
  if (body != null) opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  if (DEBUG) console.log(method, url);
  try {
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (res.status === 204 || res.headers.get('content-length') === '0') return true;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return await res.json();
    // Docker sometimes returns empty body on success
    const text = await res.text();
    return text ? JSON.parse(text) : true;
  } catch (err) {
    console.error('API Error:', err);
    return null;
  }
}

/** Dockhand-style helper – still used by a few call sites */
async function dhApi(endpoint, method = 'GET', extraQuery = {}) {
  if (IS_DOCKER) {
    // Map a few legacy Dockhand paths onto Docker Engine
    return dockerCompat(endpoint, method, extraQuery);
  }
  const params = new URLSearchParams({ env: BACKEND.DOCKHAND.ENV, ...extraQuery });
  const url = `${BACKEND.DOCKHAND.BASE_URL}${endpoint}?${params}`;
  return rawFetch(url, method);
}

/* ---------- Docker Engine compatibility layer (performance-tuned) ---------- */

/** Shared concurrency pool */
async function mapPool(items, limit, fn) {
  if (!items.length) return [];
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  const n = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

/* Short-lived caches to avoid hammering the socket proxy */
const __dockerListCache = { all: null, running: null }; // { t, data }
const __dockerInspectCache = new Map(); // id -> { t, data }
const __dockerPrevCpu = new Map(); // id -> { total, system, t } for CPU% without waiting
/** Last known good cumulative I/O counters (blkio/net). One-shot samples often omit them. */
const __dockerPrevIO = new Map(); // id -> { netRx, netTx, blockRead, blockWrite }

/**
 * Parse blkio bytes the same way the Docker CLI does (Read/Write only).
 *
 * present:
 *   true  – daemon included blkio (array, even if empty → real zeros)
 *   false – field missing entirely (incomplete sample; carry forward)
 */
function parseBlkioBytes(raw) {
  const ss = raw?.storage_stats;
  if (ss && (ss.read_size_bytes != null || ss.write_size_bytes != null)) {
    return {
      read: Number(ss.read_size_bytes) || 0,
      write: Number(ss.write_size_bytes) || 0,
      present: true
    };
  }

  const blk = raw?.blkio_stats;
  if (!blk || typeof blk !== 'object') {
    return { read: 0, write: 0, present: false };
  }

  const io =
    blk.io_service_bytes_recursive ||
    blk.IoServiceBytesRecursive ||
    null;

  // Key distinction: null/undefined = incomplete sample; [] = genuine zero I/O
  if (io == null) {
    return { read: 0, write: 0, present: false };
  }
  if (!Array.isArray(io)) {
    return { read: 0, write: 0, present: false };
  }

  let read = 0;
  let write = 0;
  for (const e of io) {
    const op = String(e.op || e.Op || '').toLowerCase();
    const val = Number(e.value ?? e.Value ?? 0) || 0;
    // Match docker CLI / moby: only Read + Write (not Total/Sync/Async/Discard)
    if (op === 'read') read += val;
    else if (op === 'write') write += val;
  }
  return { read, write, present: true };
}

function parseNetworkBytes(raw) {
  const nets = raw?.networks;
  // networks: null/omitted → incomplete; {} → zero traffic
  if (nets == null) {
    return { rx: 0, tx: 0, present: false };
  }
  if (typeof nets !== 'object') {
    return { rx: 0, tx: 0, present: false };
  }
  let rx = 0;
  let tx = 0;
  for (const n of Object.values(nets)) {
    if (!n) continue;
    rx += Number(n.rx_bytes) || 0;
    tx += Number(n.tx_bytes) || 0;
  }
  return { rx, tx, present: true };
}

/**
 * Cumulative counters must stay monotonic across polls.
 * Incomplete samples (present=false) → reuse last good value.
 * No prior sample and incomplete → null (omit from history).
 */
function stabilizeCumulative(id, key, nextVal, present) {
  const prev = __dockerPrevIO.get(id);
  const prevVal = prev ? prev[key] : null;

  if (!present || nextVal == null || !isFinite(nextVal)) {
    return prevVal != null ? prevVal : null;
  }
  // Accept counter resets (container recreate) as the new baseline
  return nextVal;
}

function parseDockerStats(raw, containerMeta = {}) {
  if (!raw || typeof raw !== 'object') return null;

  const id = (containerMeta.id || '').toString();
  const total = raw.cpu_stats?.cpu_usage?.total_usage || 0;
  const system = raw.cpu_stats?.system_cpu_usage || 0;
  const onlineCpus = raw.cpu_stats?.online_cpus || raw.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;

  // Prefer precpu deltas from Docker; fall back to our previous sample (avoids ~1s wait on one-shot)
  let cpuPercent = 0;
  const preTotal = raw.precpu_stats?.cpu_usage?.total_usage;
  const preSystem = raw.precpu_stats?.system_cpu_usage;
  if (preTotal != null && preSystem != null && system > preSystem && total > preTotal) {
    cpuPercent = ((total - preTotal) / (system - preSystem)) * onlineCpus * 100;
  } else {
    const prev = __dockerPrevCpu.get(id);
    if (prev && system > prev.system && total > prev.total) {
      cpuPercent = ((total - prev.total) / (system - prev.system)) * onlineCpus * 100;
    }
  }
  if (id) __dockerPrevCpu.set(id, { total, system, t: Date.now() });

  const memUsage = raw.memory_stats?.usage || 0;
  const memLimit = raw.memory_stats?.limit || 0;
  const cache = raw.memory_stats?.stats?.cache || raw.memory_stats?.stats?.inactive_file || 0;
  const memRaw = Math.max(0, memUsage - cache);
  const memoryPercent = memLimit > 0 ? (memRaw / memLimit) * 100 : null;

  const net = parseNetworkBytes(raw);
  const blk = parseBlkioBytes(raw);

  const networkRx = stabilizeCumulative(id, 'netRx', net.rx, net.present);
  const networkTx = stabilizeCumulative(id, 'netTx', net.tx, net.present);
  const blockRead = stabilizeCumulative(id, 'blockRead', blk.read, blk.present);
  const blockWrite = stabilizeCumulative(id, 'blockWrite', blk.write, blk.present);

  if (id) {
    const keep = __dockerPrevIO.get(id) || {};
    __dockerPrevIO.set(id, {
      netRx: networkRx ?? keep.netRx ?? null,
      netTx: networkTx ?? keep.netTx ?? null,
      blockRead: blockRead ?? keep.blockRead ?? null,
      blockWrite: blockWrite ?? keep.blockWrite ?? null
    });
  }

  return {
    id: containerMeta.id || '',
    name: containerMeta.name || '',
    cpuPercent,
    memoryPercent,
    memoryRaw: memRaw,
    memoryLimit: memLimit || null,
    networkRx: networkRx ?? 0,
    networkTx: networkTx ?? 0,
    // null = unknown this sample (history skips nulls → clean deltas)
    blockRead,
    blockWrite,
    pids: raw.pids_stats?.current ?? null
  };
}

function parseHealthFromStatus(status) {
  if (!status) return null;
  const s = String(status).toLowerCase();
  if (s.includes('(healthy)')) return 'healthy';
  if (s.includes('(unhealthy)')) return 'unhealthy';
  if (s.includes('(health: starting)') || s.includes('(starting)')) return 'starting';
  return null;
}

function normalizeDockerContainer(c) {
  const name = (c.Names && c.Names[0] ? c.Names[0] : c.Name || '').replace(/^\//, '');
  // List endpoint often includes HostConfig.NetworkMode — use it to skip inspect
  const networkMode =
    c.HostConfig?.NetworkMode ||
    c.HostConfig?.networkMode ||
    c.NetworkMode ||
    '';
  const status = c.Status || '';
  const health = parseHealthFromStatus(status);
  // RestartCount is not on list payload; filled later from inspect when available
  const restartCount = c.RestartCount ?? c.State?.RestartCount ?? null;
  if (name && (health || restartCount != null)) {
    const prev = window.__dhHealthCache.get(normalize(name)) || {};
    window.__dhHealthCache.set(normalize(name), {
      health: health ?? prev.health ?? null,
      restartCount: restartCount ?? prev.restartCount ?? null
    });
  }
  return {
    id: c.Id,
    name,
    state: (c.State || '').toLowerCase(),
    status,
    health,
    restartCount,
    labels: c.Labels || {},
    service: (c.Labels || {})[BACKEND.DOCKER.COMPOSE_SERVICE_LABEL] || name,
    networkMode,
    updateAvailable: false
  };
}

async function dockerListContainers(all = true, { force = false } = {}) {
  const key = all ? 'all' : 'running';
  const hit = __dockerListCache[key];
  if (!force && hit && Date.now() - hit.t < DOCKER_LIST_CACHE_MS) {
    return hit.data;
  }
  const q = all ? '?all=true' : '';
  const list = await rawFetch(dockerPath(`/containers/json${q}`));
  const data = Array.isArray(list) ? list.map(normalizeDockerContainer) : [];
  __dockerListCache[key] = { t: Date.now(), data };
  // If we fetched all, also refresh running subset cache
  if (all) {
    __dockerListCache.running = {
      t: Date.now(),
      data: data.filter(c => c.state === 'running')
    };
  }
  return data;
}

async function dockerInspect(idOrName, { force = false } = {}) {
  const key = String(idOrName);
  const hit = __dockerInspectCache.get(key);
  if (!force && hit && Date.now() - hit.t < DOCKER_INSPECT_CACHE_MS) {
    return hit.data;
  }
  const data = await rawFetch(dockerPath(`/containers/${encodeURIComponent(idOrName)}/json`));
  if (data) __dockerInspectCache.set(key, { t: Date.now(), data });
  return data;
}

async function dockerStatsOne(idOrName, name = '') {
  // one-shot=1 is fast but often omits/zeros blkio on cgroup v2.
  // Default (DOCKER_STATS_ONE_SHOT=false) matches Docker CLI sampling more closely.
  const q = DOCKER_STATS_ONE_SHOT
    ? 'stream=0&one-shot=1'
    : 'stream=0';
  const raw = await rawFetch(
    dockerPath(`/containers/${encodeURIComponent(idOrName)}/stats?${q}`)
  );
  return parseDockerStats(raw, { id: idOrName, name });
}

async function dockerAction(idOrName, action) {
  const path = `/containers/${encodeURIComponent(idOrName)}/${action}`;
  const res = await rawFetch(dockerPath(path), 'POST');
  // Invalidate list cache so UI reflects new state quickly
  __dockerListCache.all = null;
  __dockerListCache.running = null;
  if (res !== null) {
    window.__dhCapabilities.write = true;
    window.__dhCapabilities.probed = true;
  } else if (window.__dhCapabilities.write == null) {
    // soft signal — probe module may confirm
  }
  return res !== null;
}

/**
 * Build "stacks" from compose project labels.
 */
async function dockerBuildStacks() {
  const containers = await dockerListContainers(true);
  const byProject = new Map();

  for (const c of containers) {
    const project = (c.labels && c.labels[BACKEND.DOCKER.COMPOSE_PROJECT_LABEL]) || null;
    const key = project || `__single__${c.name}`;
    if (!byProject.has(key)) {
      byProject.set(key, {
        name: project || c.name,
        id: project || c.name,
        status: '',
        containerDetails: [],
        isFake: false,
        updateCount: 0,
        updatesAvailable: false
      });
    }
    byProject.get(key).containerDetails.push({
      id: c.id,
      name: c.name,
      state: c.state,
      status: c.status,
      service: c.service,
      labels: c.labels,
      networkMode: c.networkMode,
      updateAvailable: false
    });
  }

  const stacks = [...byProject.values()];
  for (const s of stacks) {
    const states = s.containerDetails.map(c => c.state);
    const running = states.filter(st => st === 'running').length;
    const total = states.length;
    if (running === total && total > 0) s.status = 'running';
    else if (running === 0) s.status = 'stopped';
    else s.status = 'partial';
  }

  stacks.sort((a, b) => a.name.localeCompare(b.name));
  return stacks;
}

/** Bulk stats: one list + parallel stats (optionally only interesting containers) */
async function dockerBulkStats() {
  let list = await dockerListContainers(false); // running only
  if (!list.length) return [];

  if (FEATURES.SELECTIVE_STATS) {
    rebuildStatsInterest();
    const interest = window.__dhStatsInterest;
    const historyOpen = !!window.__dhHistoryPanelOpen;
    // History panel wants a broad picture; otherwise only homepage + expanded stacks
    if (!historyOpen && interest.size > 0) {
      const filtered = list.filter(c => interest.has(normalize(c.name)));
      // Always keep at least something if filter wiped everything (name mismatch)
      if (filtered.length) list = filtered;
    }
  }

  const stats = await mapPool(list, DOCKER_STATS_CONCURRENCY, async c => {
    const s = await dockerStatsOne(c.id, c.name);
    if (!s) return null;
    s.name = c.name;
    s.id = c.id;
    return s;
  });
  return stats.filter(Boolean);
}

/** Map a few Dockhand-style endpoints onto Docker Engine calls */
async function dockerCompat(endpoint, method = 'GET', extraQuery = {}) {
  if (endpoint === '/containers/stats') {
    return dockerBulkStats();
  }

  if (endpoint === '/stacks') {
    return dockerBuildStacks();
  }

  if (endpoint === '/containers') {
    const all = extraQuery.all === 'true' || extraQuery.all === true;
    return dockerListContainers(!!all);
  }

  const inspectMatch = endpoint.match(/^\/containers\/([^/]+)(?:\/inspect)?$/);
  if (inspectMatch && method === 'GET') {
    return dockerInspect(decodeURIComponent(inspectMatch[1]));
  }

  const actionMatch = endpoint.match(/^\/containers\/([^/]+)\/(start|stop|restart)$/);
  if (actionMatch && method === 'POST') {
    return dockerAction(decodeURIComponent(actionMatch[1]), actionMatch[2]);
  }

  console.warn('dockerCompat: unhandled endpoint', endpoint, method);
  return null;
}

/* ---------- shared helpers (unchanged logic) ---------- */

function normalize(n) {
  return (n || '').toString().replace(/^\//, '').toLowerCase().trim();
}

/** Strip common prefixes/suffixes used in homepage card IDs */
function extractContainerName(id) {
  if (!id) return null;
  const name = id.toLowerCase();
  if (/^(app|root|layout|grid|group|section|row|col|panel|window|container|wrapper|main|body)/.test(name)) {
    return null;
  }
  return name
    .replace(/^(srv|container|app|docker|widget|item)-/i, '')
    .replace(/(?:-(?:vpn|vpnuk|ondemand))+$/i, '');
}

function formatBytes(b, useBinary = true) {
  if (b == null || isNaN(b) || !isFinite(b)) return '–';
  const base = useBinary ? 1024 : 1000;
  const u = useBinary
    ? ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB', 'ZiB', 'YiB']
    : ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  let i = 0;
  let v = Math.abs(Number(b));
  const sign = b < 0 ? '-' : '';
  while (v >= base && i < u.length - 1) {
    v /= base;
    i++;
  }
  return sign + v.toFixed(i === 0 ? 0 : 1) + u[i];
}

/**
 * Docker reports host total RAM as memoryLimit when a container has no explicit
 * mem_limit — every unlimited container shares that same ceiling.
 * Returns the highest memoryLimit currently in the stats cache (≈ host RAM),
 * memoized per stats pull so repeated per-row lookups don't rescan the whole
 * cache (this was previously O(n) per call, called once per rendered row —
 * i.e. O(n²) per render pass).
 */
const __dhHostMemLimitCache = { at: -1, value: 0 };
function getHostMemLimit() {
  if (__dhHostMemLimitCache.at === window.__dhLastStatsOkAt) {
    return __dhHostMemLimitCache.value;
  }
  let max = 0;
  for (const st of window.__dhStatsCache.values()) {
    const l = st?.memoryLimit;
    if (l != null && l > max) max = l;
  }
  __dhHostMemLimitCache.at = window.__dhLastStatsOkAt;
  __dhHostMemLimitCache.value = max;
  return max;
}

function isLikelyHostMemLimit(limit) {
  if (limit == null || limit <= 0) return false;
  const max = getHostMemLimit();
  if (max <= 0) return false;
  return Math.abs(limit - max) < 1024 * 1024; // within 1 MiB
}

/** Format limit for display; null when HIDE_HOST_MEM_LIMIT and it's host RAM. */
function formatMemLimitForDisplay(limitBytes) {
  if (limitBytes == null || limitBytes <= 0) return null;
  if (HIDE_HOST_MEM_LIMIT && isLikelyHostMemLimit(limitBytes)) return null;
  return formatBytes(limitBytes);
}

/** Shared mem line: "12.5% (1.0GiB / 2GiB)" or "12.5% (1.0GiB)" when host limit hidden. */
function formatMemPctLine(pct, memRaw, memLimit) {
  if (pct == null) return null;
  const used = memRaw != null ? formatBytes(memRaw) : null;
  const limit = formatMemLimitForDisplay(memLimit);
  const p = Number(pct).toFixed(1) + '%';
  if (used && limit) return `${p} (${used} / ${limit})`;
  if (limit) return `${p} / ${limit}`;
  if (used) return `${p}`;
  return p;
}

function formatMemRawLine(memRaw, memLimit) {
  if (memRaw == null) return null;
  const used = formatBytes(memRaw);
  const limit = formatMemLimitForDisplay(memLimit);
  return limit ? `${used} / ${limit}` : used;
}

function storeStat(s) {
  if (!s) return;
  const id = (s.id || s.containerId || '').toString().toLowerCase();
  const name = normalize(s.name);
  const keys = [id, name].filter(Boolean);
  if (id.length > 12) keys.push(id.slice(0, 12));
  keys.forEach(k => window.__dhStatsCache.set(k, s));

  const histKey = name || id;
  if (!histKey) return;

  const entry = {
    t: Date.now(),
    cpu: s.cpuPercent ?? null,
    mem: s.memoryPercent ?? null,
    memRaw: s.memoryRaw ?? null,
    netRx: s.networkRx ?? null,
    netTx: s.networkTx ?? null,
    // Keep null when Docker sample omitted blkio — avoids 0→huge fake deltas
    blockRead: s.blockRead != null && isFinite(s.blockRead) ? s.blockRead : null,
    blockWrite: s.blockWrite != null && isFinite(s.blockWrite) ? s.blockWrite : null,
    pids: s.pids ?? s.pidsStats?.current ?? null,
    memLimit: s.memoryLimit ?? null
  };

  let arr = window.__dhStatsHistory.get(histKey);
  if (!arr) {
    arr = [];
    window.__dhStatsHistory.set(histKey, arr);
  }
  arr.push(entry);
  if (arr.length > HISTORY_MAX_POINTS) {
    arr.splice(0, arr.length - HISTORY_MAX_POINTS);
  }
}

function lookupStatByKeys(...keys) {
  for (const k of keys) {
    if (!k) continue;
    const n = normalize(k);
    if (window.__dhStatsCache.has(n)) return window.__dhStatsCache.get(n);
  }
  return null;
}

/** True if this history key was present in the most recent stats pull */
function isStatLive(histKey) {
  return window.__dhLiveKeys.has(normalize(histKey));
}

/* ====================== Shared MutationObserver ====================== */
const __dhObservers = [];
let __dhObsTimer = null;
const __dhSharedObs = new MutationObserver(() => {
  clearTimeout(__dhObsTimer);
  __dhObsTimer = setTimeout(() => {
    for (const fn of __dhObservers) {
      try { fn(); } catch (e) { if (DEBUG) console.warn(e); }
    }
  }, 350);
});
__dhSharedObs.observe(document.body, { childList: true, subtree: true });

function onDomChange(fn) {
  __dhObservers.push(fn);
}

// Any DOM mutation can add/remove/rename service cards, so the cached
// card-name set used by rebuildStatsInterest() must be invalidated here.
onDomChange(invalidateCardNameCache);

/* ====================== Toast ====================== */
(function () {
  function ensureContainer() {
    let el = document.getElementById('custom-toast-container');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'custom-toast-container';
    document.body.appendChild(el);
    return el;
  }

  window.showToast = function (message, type = 'info', duration = 2000) {
    const container = ensureContainer();
    const toast = document.createElement('div');
    const icons = { info: 'ℹ️', success: '✅', error: '❌', warning: '⚠️' };
    const icon = icons[type] || icons.info;
    toast.className = `dh-toast dh-toast--${type in icons ? type : 'info'}`;
    toast.innerHTML = `<span class="dh-toast-icon">${icon}</span><span>${message}</span>`;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('is-visible'));
    setTimeout(() => {
      toast.classList.remove('is-visible');
      toast.classList.add('is-hiding');
      setTimeout(() => {
        toast.remove();
        if (!container.children.length) container.remove();
      }, 350);
    }, duration);
  };
})();

/* ====================== Shared themed confirm dialog ====================== */
window.dhConfirm = function (title, bodyHtml, { okLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = {}) {
  return new Promise(resolve => {
    const existing = document.getElementById('dh-confirm-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'dh-confirm-overlay';
    overlay.innerHTML = `
      <div class="dh-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="dh-confirm-title">
        <div class="dh-confirm-header" id="dh-confirm-title">${title}</div>
        <div class="dh-confirm-body">${bodyHtml}</div>
        <div class="dh-confirm-actions">
          <button type="button" class="dh-confirm-btn dh-confirm-btn-cancel" data-act="cancel">${cancelLabel}</button>
          <button type="button" class="dh-confirm-btn ${danger ? 'dh-confirm-btn-danger' : 'dh-confirm-btn-ok'}" data-act="ok">${okLabel}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const finish = ok => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(ok);
    };
    const onKey = e => {
      if (e.key === 'Escape') finish(false);
      if (e.key === 'Enter') finish(true);
    };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', e => {
      if (e.target === overlay) finish(false);
    });
    overlay.querySelector('[data-act="cancel"]').onclick = () => finish(false);
    overlay.querySelector('[data-act="ok"]').onclick = () => finish(true);
    overlay.querySelector('[data-act="ok"]').focus();
  });
};

/** Parse human uptime from Docker Status string, e.g. "Up 3 hours (healthy)" */
function parseUptimeFromStatus(status) {
  if (!status) return null;
  const m = String(status).match(/\bUp\s+([^(\n]+?)(?:\s*\(|$)/i);
  if (m) return m[1].trim();
  if (/restarting/i.test(status)) return 'restarting';
  if (/exited|dead|created/i.test(status)) {
    const em = String(status).match(/Exited\s*\((\d+)\)\s*(.+)?/i);
    if (em) return `exit ${em[1]}${em[2] ? ' · ' + em[2].trim() : ''}`;
  }
  return null;
}

/**
 * Shared batch progress dialog.
 * items: [{ id, name, sub? }]
 * runOne(item, index) => Promise<boolean>
 * onDone({ okCount, total, overlay }) optional; if omitted shows Close that removes overlay
 */
window.dhBatchProgress = async function (title, items, runOne, { meta, onClose } = {}) {
  const list = Array.isArray(items) ? items : [];
  const existing = document.getElementById('dh-popup-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'dh-popup-overlay';
  overlay.className = 'dh-batch-overlay';
  overlay.innerHTML = `
    <div class="dh-batch-dialog" role="dialog" aria-modal="true">
      <div class="dh-batch-header">
        <span>${title}</span>
        <span class="dh-batch-header-meta">${meta || list.length + ' item(s)'}</span>
      </div>
      <div class="dh-batch-body" id="dh-batch-list"></div>
      <div class="dh-batch-footer">
        <button type="button" id="dh-close-popup" class="dh-confirm-btn dh-confirm-btn-ok" disabled>Processing…</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const listEl = document.getElementById('dh-batch-list');
  const frag = document.createDocumentFragment();
  list.forEach((it, i) => {
    const row = document.createElement('div');
    row.className = 'dh-batch-row';
    row.innerHTML = `
      <div class="dh-batch-row-info">
        <span class="dh-batch-row-name">${it.name || it.id || 'item'}</span>
        ${it.sub ? `<span class="dh-batch-row-sub">${it.sub}</span>` : ''}
      </div>
      <div class="dh-batch-row-status" data-batch-status="${i}">
        <span class="dh-status-badge status-pending">Queued</span>
      </div>`;
    frag.appendChild(row);
  });
  listEl.appendChild(frag);

  const verbFor = a => (a === 'stop' ? 'Stopping' : a === 'start' ? 'Starting' : a === 'restart' ? 'Restarting' : 'Working');
  let okCount = 0;
  for (let i = 0; i < list.length; i++) {
    const ctx = overlay.querySelector(`[data-batch-status="${i}"]`);
    if (ctx) ctx.innerHTML = `<span class="dh-batch-working">${verbFor(list[i].action)}…</span><span class="dh-spinner"></span>`;
    let ok = false;
    try {
      ok = !!(await runOne(list[i], i));
    } catch (_) {
      ok = false;
    }
    if (ok) okCount++;
    if (ctx) {
      ctx.innerHTML = ok
        ? '<span class="dh-status-badge status-success">Done</span>'
        : '<span class="dh-status-badge status-error">Failed</span>';
    }
  }

  const closeBtn = document.getElementById('dh-close-popup');
  if (closeBtn) {
    closeBtn.disabled = false;
    closeBtn.textContent = 'Close';
    closeBtn.onclick = () => {
      overlay.remove();
      if (typeof onClose === 'function') onClose({ okCount, total: list.length });
    };
  }
  return { okCount, total: list.length, overlay };
};

window.dhActionVerb = function (action) {
  if (action === 'stop') return 'Stopping';
  if (action === 'start') return 'Starting';
  if (action === 'restart') return 'Restarting';
  return 'Working';
};

/* ====================== Unified action menu FAB ====================== */
/**
 * Single compact FAB bottom-right. Opens a popup menu of toggles / actions.
 * Features register themselves via window.dhMenu.register(...).
 *
 * Entry shape:
 *   { id, icon, label, order?, type: 'toggle'|'action',
 *     getActive?: () => boolean,
 *     onClick: () => void | Promise }
 */
(function () {
  const items = new Map();
  let menuOpen = false;
  let root = null;
  let menuEl = null;
  let fabEl = null;

  function ensureUI() {
    if (root) return;
    root = document.createElement('div');
    root.id = 'dh-menu-root';

    fabEl = document.createElement('button');
    fabEl.id = 'dh-menu-fab';
    fabEl.title = 'Docker tools';
    fabEl.setAttribute('aria-label', 'Docker tools menu');
    fabEl.innerHTML = '☰';
    fabEl.onclick = e => {
      e.preventDefault();
      e.stopPropagation();
      setOpen(!menuOpen);
    };

    menuEl = document.createElement('div');
    menuEl.id = 'dh-menu-panel';

    root.append(fabEl, menuEl);
    document.body.appendChild(root);

    document.addEventListener('click', e => {
      if (!menuOpen) return;
      if (root.contains(e.target)) return;
      setOpen(false);
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && menuOpen) setOpen(false);
    });
  }

  function setOpen(open) {
    ensureUI();
    menuOpen = open;
    menuEl.classList.toggle('is-open', open);
    fabEl.classList.toggle('is-open', open);
    fabEl.innerHTML = open ? '×' : '☰';
    if (open) renderMenu();
  }

  function renderMenu() {
    ensureUI();
    const sorted = [...items.values()].sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
    menuEl.innerHTML = '';

    if (!sorted.length) {
      menuEl.innerHTML = '<div class="dh-menu-empty">No tools registered</div>';
      return;
    }

    const header = document.createElement('div');
    header.className = 'dh-menu-header';
    const write = window.__dhCapabilities?.write;
    const modeLabel = BACKEND.MODE + (write === false ? ' · read-only' : write === true ? ' · rw' : '');
    header.innerHTML = `<span>Docker tools</span><span class="dh-menu-header-mode">${modeLabel}</span>`;
    menuEl.appendChild(header);

    sorted.forEach((item, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dh-menu-item';
      btn.dataset.menuId = item.id;
      const active = item.type === 'toggle' && item.getActive?.();
      if (active) btn.classList.add('is-active');

      btn.innerHTML = `
        <span class="dh-menu-item-icon">${item.icon}</span>
        <span class="dh-menu-item-label">${item.label}</span>
        <span class="dh-menu-item-dot"></span>`;

      btn.onclick = async e => {
        e.preventDefault();
        e.stopPropagation();
        try {
          await item.onClick?.();
        } catch (err) {
          if (DEBUG) console.warn('menu action failed', item.id, err);
        }
        if (item.closeOnClick) setOpen(false);
        else renderMenu();
      };
      menuEl.appendChild(btn);

      if (item.dividerAfter && idx < sorted.length - 1) {
        const hr = document.createElement('div');
        hr.className = 'dh-menu-divider';
        menuEl.appendChild(hr);
      }
    });
  }

  function register(entry) {
    if (!entry?.id) return;
    items.set(entry.id, entry);
    ensureUI();
    if (menuOpen) renderMenu();
  }

  function unregister(id) {
    items.delete(id);
    if (menuOpen) renderMenu();
  }

  function setActive(id, _active) {
    // getActive is the source of truth; this just re-renders if open
    if (menuOpen) renderMenu();
  }

  function pulse() {
    ensureUI();
    fabEl.classList.remove('updated');
    void fabEl.offsetWidth;
    fabEl.classList.add('updated');
    setTimeout(() => fabEl.classList.remove('updated'), 600);
    refreshStaleClass();
  }

  function refreshStaleClass() {
    if (!FEATURES.STALE_INDICATOR || !fabEl) return;
    const last = window.__dhLastStatsOkAt || 0;
    const stale = last > 0 && Date.now() - last > STALE_AFTER_MS;
    fabEl.classList.toggle('is-stale', stale);
    fabEl.title = stale
      ? 'Docker tools — stats stale (check proxy / CORS)'
      : 'Docker tools';
  }

  function close() {
    setOpen(false);
  }

  window.dhMenu = { register, unregister, setActive, pulse, close, render: renderMenu, refreshStaleClass };

  if (FEATURES.STALE_INDICATOR) {
    setInterval(() => window.dhMenu?.refreshStaleClass?.(), 5000);
  }

  // Boot UI early so the FAB is always present
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureUI);
  } else {
    ensureUI();
  }
})();

/* ====================== Long-press Progress Ring (mobile) ====================== */
(function () {
  const isMobile =
    window.innerWidth <= 768 ||
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  if (!isMobile || HOLD_DURATION === 0) return;

  let holdTimer = null;
  let progressInterval = null;
  let currentCard = null;

  function createOverlay(card) {
    let overlay = card.querySelector('.long-press-overlay');
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.className = 'long-press-overlay';
    overlay.innerHTML = `
      <div class="progress-ring-container">
        <svg class="progress-ring" width="56" height="56">
          <circle class="progress-ring-bg" cx="28" cy="28" r="24" fill="none" stroke-width="5"></circle>
          <circle class="progress-ring-circle" cx="28" cy="28" r="24" fill="none" stroke-width="5"
                  stroke-dasharray="150.8" stroke-dashoffset="150.8"></circle>
        </svg>
        <div class="progress-text">0%</div>
      </div>
      <div style="margin-top:12px;font-size:14px;font-weight:500">Hold to open...</div>`;
    card.appendChild(overlay);
    return overlay;
  }

  function startProgress(overlay) {
    const circle = overlay.querySelector('.progress-ring-circle');
    const text = overlay.querySelector('.progress-text');
    const circumference = 150.8;
    let progress = 0;
    clearInterval(progressInterval);
    progressInterval = setInterval(() => {
      progress = Math.min(100, progress + 100 / (HOLD_DURATION / 50));
      circle.style.strokeDashoffset = circumference * (1 - progress / 100);
      text.textContent = Math.round(progress) + '%';
    }, 50);
  }

  function resetHold() {
    clearTimeout(holdTimer);
    clearInterval(progressInterval);
    holdTimer = progressInterval = null;
    if (currentCard) {
      currentCard.classList.remove('long-press-active');
      const overlay = currentCard.querySelector('.long-press-overlay');
      if (overlay) overlay.classList.remove('show');
      currentCard = null;
    }
  }

  function startHold(card) {
    resetHold();
    currentCard = card;
    card.classList.add('long-press-active');
    const overlay = createOverlay(card);
    overlay.classList.add('show');
    startProgress(overlay);
    holdTimer = setTimeout(() => {
      const link = card.querySelector('a[href]');
      if (link?.href) window.location.href = link.href;
      resetHold();
    }, HOLD_DURATION);
  }

  function blockAllLinks(card) {
    card.querySelectorAll('a[href]').forEach(link => {
      if (link.dataset.longPressBlocked) return;
      link.dataset.longPressBlocked = 'true';
      link.style.pointerEvents = 'none';
      const block = e => {
        if (holdTimer) {
          e.preventDefault();
          e.stopImmediatePropagation();
          return false;
        }
      };
      link.addEventListener('click', block, { capture: true, passive: false });
      link.addEventListener('touchstart', block, { capture: true, passive: false });
    });
  }

  function attachListeners() {
    document.querySelectorAll('.service-card').forEach(card => {
      if (card.dataset.longPressV9) return;
      if (!card.hasAttribute('href') && !card.querySelector('a[href]')) return;
      card.dataset.longPressV9 = 'true';
      blockAllLinks(card);
      const targets = [card, card.querySelector('.service-title')].filter(Boolean);
      targets.forEach(t => {
        t.addEventListener('touchstart', e => {
          if (e.target.closest('button, input, .widget, .service-tag')) return;
          startHold(card);
        }, { passive: true });
      });
      card.addEventListener('touchend', resetHold, { passive: true });
      card.addEventListener('touchcancel', resetHold, { passive: true });
    });
  }

  attachListeners();
  onDomChange(attachListeners);
})();

/* ====================== Per-card Start/Stop/Restart controls ====================== */
(function () {
  let controlsVisible = false;
  const managed = [];

  function autoDiscover() {
    document.querySelectorAll('li.service, [class="service"]').forEach(card => {
      const id = card.id;
      if (!id || card.querySelector('.custom-docker-controls')) return;
      const containerName = extractContainerName(id);
      if (!containerName) return;
      if (managed.some(m => m.elementId === id)) return;
      managed.push({ elementId: id, containerName });
    });
  }

  async function sendCommand(name, action) {
    const ok = await dhApi(`/containers/${name}/${action}`, 'POST');
    if (ok) {
      showToast(`${IS_DOCKER ? 'Docker' : 'Dockhand'} confirmed: ${action} on ${name}.`, 'success');
      return true;
    }
    showToast(`${IS_DOCKER ? 'Docker' : 'Dockhand'} API Error executing ${action} on ${name}.`, 'error');
    return false;
  }

  function injectButtons() {
    for (const item of managed) {
      const card = document.getElementById(item.elementId);
      if (!card) continue;
      let wrapper = card.querySelector('.custom-docker-controls');
      if (!wrapper) {
        wrapper = document.createElement('div');
        wrapper.className = 'custom-docker-controls';
        const setLoading = loading => {
          wrapper.querySelectorAll('button').forEach(b => {
            b.disabled = loading;
          });
        };
        const makeBtn = (label, title, cls, action) => {
          const btn = document.createElement('button');
          btn.innerHTML = label;
          btn.title = title;
          btn.className = cls;
          btn.onclick = async e => {
            e.preventDefault();
            e.stopPropagation();
            setLoading(true);
            await sendCommand(item.containerName, action);
            setLoading(false);
          };
          return btn;
        };
        wrapper.append(
          makeBtn('▶ Start', 'Start Container', 'dh-ctrl-start', 'start'),
          makeBtn('↻ Restart', 'Restart Container', 'dh-ctrl-restart', 'restart'),
          makeBtn('■ Stop', 'Stop Container', 'dh-ctrl-stop', 'stop')
        );
        card.appendChild(wrapper);
      }
      wrapper.classList.toggle('is-visible', controlsVisible);
    }
  }

  function toggleControls() {
    if (FEATURES.CAPABILITY_PROBE && window.__dhCapabilities.write === false) {
      showToast('Backend is read-only — start/stop/restart disabled', 'warning', 2500);
      return;
    }
    controlsVisible = !controlsVisible;
    if (!managed.length) autoDiscover();
    injectButtons();
    window.dhMenu?.setActive('controls', controlsVisible);
    showToast(controlsVisible ? 'Container controls shown' : 'Container controls hidden', 'info', 1200);
  }

  window.dhMenu?.register({
    id: 'controls',
    icon: '⚙️',
    label: 'Container controls',
    order: 40,
    type: 'toggle',
    getActive: () => controlsVisible,
    onClick: toggleControls
  });

  window.addEventListener('dh-capabilities', () => {
    if (window.__dhCapabilities.write === false && controlsVisible) {
      controlsVisible = false;
      injectButtons();
      window.dhMenu?.setActive('controls', false);
    }
    window.dhMenu?.render?.();
  });
})();

/* ====================== Shared stats poller ====================== */
(function () {
  let timer = null;
  let inFlight = false;

  function isStatsNeeded() {
    if (window.__dhCardStatsVisible) return true;
    if (window.__dhHistoryPanelOpen) return true;
    const panel = document.getElementById('dockhand-fab-panel');
    return !!(panel && panel.classList.contains('is-open'));
  }

  async function pullStats(force = false) {
    if (!force && !isStatsNeeded()) return;
    if (inFlight) return;
    inFlight = true;
    try {
      const data = await dhApi('/containers/stats');
      const list = Array.isArray(data) ? data : (data?.containers || []);

      window.__dhStatsCachePrev.clear();
      for (const [key, val] of window.__dhStatsCache) {
        window.__dhStatsCachePrev.set(key, val);
      }
      window.__dhStatsCache.clear();

      // Rebuild live set from this pull (exited containers drop out of realtime)
      const live = new Set();
      for (const s of list) {
        if (!s) continue;
        const id = (s.id || s.containerId || '').toString().toLowerCase();
        const name = normalize(s.name);
        if (name) live.add(name);
        if (id) live.add(id);
        if (id.length > 12) live.add(id.slice(0, 12));
      }
      window.__dhLiveKeys = live;

      if (list.length) {
        list.forEach(storeStat);
        window.__dhLastStatsOkAt = Date.now();
        if (FEATURES.ALERTS) window.__dhCheckAlerts?.(list);
      }
      // Always fire so UI can clear realtime for exited containers
      window.dispatchEvent(new CustomEvent('dh-stats-updated'));

      if (DEBUG) console.log('Stats grab', live.size, 'live');
      indicateStatsUpdate();
    } catch (err) {
      if (DEBUG) console.warn('stats pull failed', err);
    } finally {
      inFlight = false;
    }
  }

  function startPolling() {
    if (timer) return;
    pullStats();
    if (STATS_REFRESH_MS > 0) timer = setInterval(pullStats, STATS_REFRESH_MS);
  }

  function stopPolling() {
    clearInterval(timer);
    timer = null;
  }

  function indicateStatsUpdate() {
    window.dhMenu?.pulse();
  }

  window.dhEnsureStatsPolling = function () {
    isStatsNeeded() ? startPolling() : stopPolling();
  };

  window.dhRefreshStats = pullStats;

  const init = () => setTimeout(() => window.dhEnsureStatsPolling(), 1800);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

/* ====================== Dockhand / Docker Stacks FAB ====================== */
(function () {
  let cachedStacks = [];
  let pollId = null;
  const expanded = new Set();
  let keepAlive = false;
  let fakeStacksList = [];
  const fakeStacks = [];
  let lastStructureHash = '';

  // Panel only — trigger lives in the unified menu FAB
  const container = document.createElement('div');
  container.id = 'dockhand-fab-container';

  const panel = document.createElement('div');
  panel.id = 'dockhand-fab-panel';
  panel.innerHTML = `
    <div class="dh-header">
      <span>${IS_DOCKER ? 'Docker Stacks' : 'Dockhand Stacks'} <small style="opacity:.6">(${BACKEND.MODE})</small></span>
      <div class="dh-header-actions">
        <button id="dh-refresh" title="Refresh">🔄</button>
        <button id="dh-stacks-close" title="Close">×</button>
      </div>
    </div>
    ${FEATURES.STACKS_FILTER ? `<div class="dh-stacks-filter-wrap"><input id="dh-stacks-filter" type="search" placeholder="Filter stacks / containers / status…" autocomplete="off" /></div>` : ''}
    <div id="dh-stack-list" style="padding:4px">Loading...</div>`;

  container.append(panel);
  document.body.appendChild(container);

  let stacksFilter = '';
  if (FEATURES.STACKS_FILTER) {
    const filterInput = document.getElementById('dh-stacks-filter');
    filterInput?.addEventListener('input', () => {
      stacksFilter = (filterInput.value || '').trim().toLowerCase();
      renderStackList();
    });
  }

  function isStacksOpen() {
    return panel.classList.contains('is-open');
  }

  function setStacksOpen(open) {
    panel.classList.toggle('is-open', open);
    if (open) {
      fetchStacks(true);
      startPolling();
    } else {
      stopPolling();
    }
    window.dhEnsureStatsPolling();
    window.dhMenu?.setActive('stacks', open);
  }

  function toggleStacks() {
    setStacksOpen(!isStacksOpen());
  }

  function getStateClass(state) {
    if (!state) return 'state-unknown';
    const s = state.toLowerCase();
    if (s.includes('running') || s.includes('up')) return 'state-running';
    if (s.includes('exit') || s.includes('stop')) return 'state-exited';
    if (s.includes('pause')) return 'state-paused';
    return 'state-unknown';
  }

  function statusIcon(status) {
    if (status === 'running') return '🟩';
    if (status === 'stopped') return '🟥';
    if (status === 'partial') return '🟨';
    if (status === 'created') return '🟦';
    return '';
  }

  function formatMemDisplay(s) {
    if (!s) return '–';
    const used = s.memoryRaw != null ? formatBytes(s.memoryRaw) : null;
    const limit = formatMemLimitForDisplay(s.memoryLimit);
    const pct = s.memoryPercent != null ? `${Number(s.memoryPercent).toFixed(1)}%` : null;
    // e.g. "12.5% (1.0GiB / 2.0GiB)" for explicit limits; "12.5% (1.0GiB)" for host RAM
    if (pct && used && limit) return `${pct} (${used} / ${limit})`;
    if (pct && limit) return `${pct} / ${limit}`;
    if (pct && used) return `${pct} (${used})`;
    if (used && limit) return `${used} / ${limit}`;
    return pct || used || '–';
  }

  /**
   * Aggregate container stats for a stack.
   *
   * All container memory comes from the *same* host RAM pool — explicit
   * mem_limits are reservations inside that pool, not extra capacity on top.
   * Stack ceiling is always one shared limit:
   *   1) global host RAM (highest limit seen on any container), else
   *   2) max(limit) among members of this stack
   * Never sum limits.
   */
  function aggregateStackMem(statsList) {
    const out = { cpuPercent: 0, memoryPercent: 0, memoryRaw: 0, memoryLimit: 0 };
    if (!statsList?.length) return out;

    let stackMaxLimit = 0;
    for (const st of statsList) {
      out.cpuPercent += st.cpuPercent || 0;
      out.memoryRaw += st.memoryRaw || 0;
      if (st.memoryLimit != null && st.memoryLimit > stackMaxLimit) {
        stackMaxLimit = st.memoryLimit;
      }
    }

    // Prefer true host ceiling when known (any unlimited container on the host).
    // getHostMemLimit() is memoized per stats pull instead of rescanning the
    // whole stats cache for every stack.
    const hostLimit = getHostMemLimit();

    out.memoryLimit = hostLimit > 0 ? hostLimit : stackMaxLimit;
    if (out.memoryLimit > 0) {
      out.memoryPercent = (out.memoryRaw / out.memoryLimit) * 100;
    }
    return out;
  }

  function formatStats(s) {
    if (!s) return '';
    const cpu = s.cpuPercent != null ? `${Number(s.cpuPercent).toFixed(1)}%` : '–';
    const mem = formatMemDisplay(s);
    return `<span class="dh-stats">CPU ${cpu} · MEM ${mem}</span>`;
  }

  function lookupStats(c) {
    return c ? lookupStatByKeys(c.name, c.id) : null;
  }

  document.getElementById('dh-refresh').addEventListener('click', e => {
    e.stopPropagation();
    fetchStacks(true);
    window.dhRefreshStats?.();
  });

  document.getElementById('dh-stacks-close').addEventListener('click', e => {
    e.stopPropagation();
    setStacksOpen(false);
  });

  window.dhMenu?.register({
    id: 'stacks',
    icon: IS_DOCKER ? '🐋' : '🐳',
    label: IS_DOCKER ? 'Compose stacks' : 'Dockhand stacks',
    order: 10,
    type: 'toggle',
    closeOnClick: true, // panel opens — close the menu
    getActive: isStacksOpen,
    onClick: toggleStacks
  });

  function startPolling() {
    if (!pollId) pollId = setInterval(() => fetchStacks(false), DH.POLL_INTERVAL);
  }
  function stopPolling() {
    clearInterval(pollId);
    pollId = null;
  }

  function structureHash(stacks) {
    return stacks.map(s => {
      const names = (s.containerDetails || []).map(c => c.name || '').join(',');
      return `${s.name}|${s.status}|${names}`;
    }).join(';');
  }

  async function fetchStacks(force = false) {
    let stacks = await dhApi('/stacks');
    keepAlive = !keepAlive;
    if (!stacks) stacks = [];
    // Fake stacks work in both modes — they are built from container labels
    // (fakeStack.<name>). Docker mode exposes labels via compose-project grouping.
    updateFakeStacks(stacks);
    if (fakeStacks.length) stacks = stacks.concat(fakeStacks);

    if (!stacks.length) {
      if (!cachedStacks.length) {
        const list = document.getElementById('dh-stack-list');
        if (list) list.innerHTML = "<div style='padding:12px'>No stacks found or API unreachable.</div>";
      }
      return;
    }

    stacks.sort((a, b) => a.name.localeCompare(b.name));
    stacks.forEach(s => {
      s.id = s.name;
      if (Array.isArray(s.containerDetails)) {
        s.containerDetails.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      }
    });

    const hash = structureHash(stacks);
    const structureChanged = hash !== lastStructureHash;
    lastStructureHash = hash;
    cachedStacks = stacks;

    if (force || structureChanged) {
      renderStackList();
    } else {
      patchStackStats();
    }
  }

  function patchStackStats() {
    for (const stack of cachedStacks) {
      if (!stack.containerDetails?.length) continue;
      const details = document.getElementById(`dh-details-${stack.id}`);
      if (!details || !details.classList.contains('is-open')) continue;

      const rows = details.querySelectorAll('.dh-nested-c-row');
      stack.containerDetails.forEach((c, i) => {
        const row = rows[i];
        if (!row) return;
        // Only update the stat text node — never wipe the log button sibling
        const target =
          row.querySelector('.dh-nested-c-stat-text') ||
          row.querySelector('.dh-nested-c-stats');
        if (!target) return;
        const st = lookupStats(c);
        const html = formatStats(st) || (keepAlive ? '🔶' : '🔸');
        if (target.dataset.last !== html) {
          target.dataset.last = html;
          target.innerHTML = html;
        }

        // Ensure log button still exists after any prior bad patches
        if (FEATURES.LOG_TAIL) {
          let logBtn = row.querySelector('.dh-log-btn');
          const statsWrap = row.querySelector('.dh-nested-c-stats');
          if (statsWrap && !logBtn) {
            const cid = (c.id || c.name || '').replace(/"/g, '');
            const cname = (c.name || '').replace(/"/g, '');
            logBtn = document.createElement('button');
            logBtn.type = 'button';
            logBtn.className = 'dh-log-btn';
            logBtn.dataset.cid = cid;
            logBtn.dataset.cname = cname;
            logBtn.title = 'Tail logs';
            logBtn.textContent = '📜';
            logBtn.addEventListener('click', e => {
              e.preventDefault();
              e.stopPropagation();
              window.dhShowLogs?.(cid || cname, cname || cid);
            });
            statsWrap.appendChild(logBtn);
          }
        }
      });

      const usageEl = document.querySelector(`.dh-stack-item[data-stack="${stack.id}"] .dh-stack-usage`);
      if (usageEl) {
        const stackUsage = aggregateStackMem(
          stack.containerDetails.map(c => lookupStats(c)).filter(Boolean)
        );
        const html = stackUsage.memoryRaw ? formatStats(stackUsage) : '';
        if (usageEl.dataset.last !== html) {
          usageEl.dataset.last = html;
          usageEl.innerHTML = html;
        }
      }
    }
  }

  function stackMatchesFilter(stack, q) {
    if (!q) return true;
    if ((stack.name || '').toLowerCase().includes(q)) return true;
    if ((stack.status || '').toLowerCase().includes(q)) return true;
    if (stack.containerDetails?.some(c =>
      (c.name || '').toLowerCase().includes(q) ||
      (c.status || '').toLowerCase().includes(q) ||
      (c.state || '').toLowerCase().includes(q)
    )) return true;
    return false;
  }

  function renderStackList() {
    const list = document.getElementById('dh-stack-list');
    if (!list) return;
    list.innerHTML = '';

    // Pin favorites first
    const ordered = [...cachedStacks].sort((a, b) => {
      const pa = __pinnedStacks.has(String(a.id)) || __pinnedStacks.has(String(a.name)) ? 0 : 1;
      const pb = __pinnedStacks.has(String(b.id)) || __pinnedStacks.has(String(b.name)) ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return (a.name || '').localeCompare(b.name || '');
    });

    for (const stack of ordered) {
      if (DH.HIDE_STACKS.includes(stack.name)) continue;
      if (FEATURES.STACKS_FILTER && !stackMatchesFilter(stack, stacksFilter)) continue;

      const item = document.createElement('div');
      item.className = 'dh-stack-item';
      item.dataset.stack = stack.id;
      const pinned = __pinnedStacks.has(String(stack.id)) || __pinnedStacks.has(String(stack.name));
      if (pinned) item.classList.add('is-pinned');

      let detailsHtml = '';
      const statsForStack = [];

      if (stack.containerDetails?.length) {
        const badNames = window.__dhInvalidNetMode?.byName || new Set();
        detailsHtml = stack.containerDetails.map(c => {
          const cName = normalize(c.name);
          const isBad = badNames.has(cName);
          const badInfo = isBad
            ? (window.__dhInvalidNetMode.details || []).find(d => normalize(d.name) === cName)
            : null;
          if (badInfo) stack.badNetwork = true;

          const warnAttr = isBad
            ? ` class="dh-nested-c-row dh-invalid-netmode" data-netmode-warn="⚠ missing: ${badInfo?.target || '?'}"`
            : ' class="dh-nested-c-row"';

          const st = lookupStats(c);
          if (st) statsForStack.push(st);
          const statsHtml = formatStats(st);

          const uptime = FEATURES.UPTIME ? parseUptimeFromStatus(c.status) : null;
          const cid = (c.id || c.name || '').replace(/"/g, '');
          const cname = (c.name || '').replace(/"/g, '');
          const logBtn = FEATURES.LOG_TAIL
            ? `<button type="button" class="dh-log-btn" data-cid="${cid}" data-cname="${cname}" title="Tail logs">📜</button>`
            : '';
          return `
          <div${warnAttr} data-cname="${cname}" data-cid="${cid}">
            <div class="dh-nested-c-top">
              <span class="dh-nested-c-name">🔹${c.name || 'container'} ${c.updateAvailable ? '⬆️' : ''}${isBad ? ' ⚠' : ''}</span>
              <span class="dh-nested-c-stats">
                <span class="dh-nested-c-stat-text">${statsHtml || (keepAlive ? '🔶' : '🔸')}</span>
                ${logBtn}
              </span>
            </div>
            <div class="dh-nested-c-meta">
              <span><span class="dh-meta-label">State:</span>
                <span class="state-pill ${getStateClass(c.state)}">${c.state || 'unknown'}</span></span>
              <span><span class="dh-meta-label">Status:</span> ${c.status || 'unknown'}</span>
              ${uptime ? `<span><span class="dh-meta-label">Up:</span> ${uptime}</span>` : ''}
            </div>
          </div>`;
        }).join('');
      } else {
        detailsHtml = '<div class="dh-nested-c-row" style="color:#9ca3af;text-align:center">No containers mapped.</div>';
      }

      const stackUsage = aggregateStackMem(statsForStack);

      const stackUsageHtml = stackUsage.memoryRaw
        ? `<div class="dh-stack-usage">${formatStats(stackUsage)}</div>`
        : '<div class="dh-stack-usage"></div>';

      const isExpanded = expanded.has(String(stack.id));
      const disabled = DH.HIDE_BUTTONS.includes(stack.name) ? 'disabled' : '';

      // Link only for Dockhand (has a UI). Docker mode shows plain name.
      const nameHtml = stack.isFake
        ? (stack.name || stack.id)
        : IS_DOCKER
          ? (stack.name || stack.id)
          : `<a href="${BACKEND.DOCKHAND.EXT_URL}/stacks?search=${stack.name || stack.id}">${stack.name || stack.id}</a>`;

      const ro = FEATURES.CAPABILITY_PROBE && window.__dhCapabilities.write === false;
      const writeDisabled = disabled || (ro ? 'disabled' : '');
      const isCompose = !stack.isFake && stack.containerDetails?.some(c =>
        c.labels?.[BACKEND.DOCKER?.COMPOSE_PROJECT_LABEL || 'com.docker.compose.project'] ||
        (stack.name && !String(stack.id).startsWith('__single__'))
      );
      const pinBtn = FEATURES.PIN_FAVORITES
        ? `<button type="button" class="dh-pin-btn" data-pin-id="${stack.id}" data-pin-name="${stack.name || ''}" title="${pinned ? 'Unpin' : 'Pin'}">${pinned ? '📌' : '📍'}</button>`
        : '';
      const projectBtn = (FEATURES.COMPOSE_PROJECT_ACTIONS && IS_DOCKER && isCompose && !ro)
        ? `<button class="dh-btn btn-reset" data-id="${stack.id}" data-project-restart="1" title="Restart all containers in project">↻ Project</button>`
        : '';

      item.innerHTML = `
        <div class="dh-stack-name" style="display:flex;justify-content:space-between;gap:6px;align-items:center">
          <span style="min-width:0;overflow:hidden;text-overflow:ellipsis">
            ${stack.isFake ? '👻' : statusIcon(stack.status)}
            ${nameHtml}
          </span>
          <span style="flex-shrink:0;display:flex;align-items:center;gap:4px">
            ${pinBtn}
            ${stack.updateCount > 0 ? stack.updateCount : ''}${stack.updatesAvailable ? '⬆️' : ''} ${stack.badNetwork ? '⚠️' : ''}
          </span>
        </div>
        ${stackUsageHtml}
        <div class="dh-actions">
          <button class="dh-btn btn-start" ${writeDisabled} data-id="${stack.id}">▶ Start</button>
          <button class="dh-btn btn-reset" ${writeDisabled} data-id="${stack.id}">↻ Restart</button>
          <button class="dh-btn btn-stop" ${writeDisabled} data-id="${stack.id}">■ Stop</button>
          ${projectBtn}
        </div>
        <button class="dh-expand-toggle" data-id="${stack.id}">
          <span>View Containers</span> <span>${isExpanded ? '▲' : '▼'}</span>
        </button>
        <div class="dh-container-details-list${isExpanded ? ' is-open' : ''}" id="dh-details-${stack.id}">
          ${detailsHtml}
        </div>`;

      list.appendChild(item);
    }

    list.querySelectorAll('.dh-pin-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const id = String(btn.dataset.pinId || '');
        const name = String(btn.dataset.pinName || '');
        const key = id || name;
        if (!key) return;
        if (__pinnedStacks.has(key) || __pinnedStacks.has(name)) {
          __pinnedStacks.delete(key);
          __pinnedStacks.delete(name);
          __pinnedStacks.delete(id);
        } else {
          __pinnedStacks.add(key);
        }
        savePins(__pinnedStacks);
        renderStackList();
      });
    });

    list.querySelectorAll('.dh-expand-toggle').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const id = String(btn.dataset.id);
        const details = document.getElementById(`dh-details-${id}`);
        const arrow = btn.querySelector('span:last-child');
        if (details.classList.contains('is-open')) {
          details.classList.remove('is-open');
          arrow.textContent = '▼';
          expanded.delete(id);
        } else {
          details.classList.add('is-open');
          arrow.textContent = '▲';
          expanded.add(id);
          patchStackStats();
        }
        // Selective stats: include containers from expanded stacks
        window.__dhStatsInterestExtra = new Set();
        for (const sid of expanded) {
          const st = cachedStacks.find(s => String(s.id) === String(sid));
          st?.containerDetails?.forEach(c => {
            if (c.name) window.__dhStatsInterestExtra.add(normalize(c.name));
          });
        }
        rebuildStatsInterest();
        window.dhEnsureStatsPolling?.();
        window.dhRefreshStats?.(true);
      });
    });

    list.querySelectorAll('.dh-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        if (btn.disabled) {
          showToast('Write actions disabled (read-only backend)', 'warning', 2000);
          return;
        }
        const action = btn.classList.contains('btn-start')
          ? 'start'
          : btn.classList.contains('btn-stop')
            ? 'stop'
            : 'restart';
        const stack = cachedStacks.find(s => String(s.id) === String(btn.dataset.id));
        if (stack?.containerDetails?.length) openBatchPopup(stack, action);
        else showToast('No container structures found inside this stack.', 'error');
      });
    });

    if (FEATURES.LOG_TAIL) {
      list.querySelectorAll('.dh-log-btn').forEach(btn => {
        btn.addEventListener('click', e => {
          e.preventDefault();
          e.stopPropagation();
          const id = btn.dataset.cid || btn.dataset.cname;
          const name = btn.dataset.cname || id;
          if (id) window.dhShowLogs?.(id, name);
        });
      });
    }
  }

  window.addEventListener('dh-stats-updated', () => {
    if (panel.classList.contains('is-open')) patchStackStats();
  });

  async function openBatchPopup(stack, action) {
    const containers = stack.containerDetails || [];
    if (!containers.length) {
      showToast('No containers in this stack.', 'error');
      return;
    }

    if (FEATURES.CONFIRM_ACTIONS) {
      const ok = await window.dhConfirm(
        `${action.toUpperCase()} stack?`,
        `Are you sure you want to <strong>${action}</strong> stack <strong>${stack.name}</strong>?
         <div class="dh-confirm-meta">${containers.length} container(s) will be affected.</div>`,
        { okLabel: action.charAt(0).toUpperCase() + action.slice(1), danger: action === 'stop' }
      );
      if (!ok) return;
    } else if (!confirm(`Are you sure you want to ${action} stack ${stack.name}?`)) {
      return;
    }

    const items = containers.map(c => ({
      id: c.id || c.name,
      name: c.name || 'Unnamed',
      action,
      sub: `<span class="state-pill ${getStateClass(c.state)}">${c.state || 'unknown'}</span>${c.status ? ' · ' + c.status : ''}`
    }));

    const { okCount, total } = await window.dhBatchProgress(
      `${action.toUpperCase()} · ${stack.name}`,
      items,
      async it => dhApi(`/containers/${encodeURIComponent(it.id)}/${action}`, 'POST'),
      {
        meta: `${containers.length} container(s)`,
        onClose: () => fetchStacks(true)
      }
    );
    showToast(`${action}: ${okCount}/${total} ok`, okCount === total ? 'success' : 'warning', 2500);
  }

  function updateFakeStacks(realStacks) {
    const usable = realStacks.filter(s => !s.isFake && s.containerDetails?.length);
    if (!usable.length) return;
    fakeStacks.length = 0;
    for (const fs of fakeStacksList) {
      const selected = [];
      for (const { stackName, service, name } of fs.containers) {
        const stack = usable.find(s => s.name === stackName);
        if (!stack) continue;
        // Prefer service match (compose), fall back to container name
        const c =
          stack.containerDetails.find(x => x.service === service) ||
          stack.containerDetails.find(x => normalize(x.name) === normalize(name));
        if (c) selected.push(c);
      }
      if (!selected.length) continue;

      // Derive status from selected containers
      const states = selected.map(c => (c.state || '').toLowerCase());
      const running = states.filter(st => st === 'running' || st.includes('up')).length;
      let status = 'stopped';
      if (running === selected.length && selected.length > 0) status = 'running';
      else if (running > 0) status = 'partial';

      fakeStacks.push({
        name: fs.name,
        id: `fake-${fs.name}`,
        status,
        containerDetails: selected,
        isFake: true,
        source: 'labels',
        lastUpdated: new Date().toISOString()
      });
    }
  }

  async function buildFakeStacksFromLabels() {
    try {
      const stacks = await dhApi('/stacks');
      if (!stacks?.length) return;
      const map = new Map();
      for (const stack of stacks) {
        if (!stack.containerDetails) continue;
        for (const c of stack.containerDetails) {
          if (!c.labels) continue;
          for (const key of Object.keys(c.labels)) {
            if (!key.startsWith('fakeStack.')) continue;
            const name = key.slice(10).trim();
            if (!name) continue;
            if (!map.has(name)) map.set(name, []);
            map.get(name).push({
              stackName: stack.name,
              name: c.name || c.service || 'unknown',
              service: c.service || c.name || 'unknown'
            });
          }
        }
      }
      const result = [];
      for (const [name, containers] of map) {
        const seen = new Set();
        const unique = containers.filter(c => {
          const k = `${c.stackName}-${c.name}-${c.service}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        result.push({ name, containers: unique });
      }
      result.sort((a, b) => a.name.localeCompare(b.name));
      fakeStacksList = result;
      if (DEBUG && result.length) console.log('Fake stacks from labels:', result.map(r => r.name));
    } catch (err) {
      console.error('Failed to build fakeStacks from labels', err);
    }
  }

  setTimeout(buildFakeStacksFromLabels, 1200);
})();

/* ====================== Invalid network_mode detector ====================== */
(function () {
  const HIGHLIGHT_CLASS = 'dh-invalid-netmode';

  window.__dhInvalidNetMode = window.__dhInvalidNetMode || {
    byName: new Set(),
    byId: new Set(),
    details: []
  };

  let checkInFlight = false;

  function getNetworkMode(inspect) {
    if (!inspect || typeof inspect !== 'object') return '';
    // Docker inspect shape
    if (inspect.HostConfig?.NetworkMode) return inspect.HostConfig.NetworkMode;
    // Fallbacks used by Dockhand responses
    const candidates = [
      inspect.hostConfig?.NetworkMode,
      inspect.HostConfig?.networkMode,
      inspect.networkMode,
      inspect.NetworkMode
    ];
    for (const v of candidates) if (typeof v === 'string' && v.length) return v;
    return '';
  }

  function listIdentity(c) {
    const id = (c.id || c.Id || c.ID || '').toString();
    let name = c.name || c.Name || '';
    if (!name && Array.isArray(c.Names) && c.Names[0]) name = c.Names[0];
    name = normalize(name);
    const shortId = id.length > 12 ? id.slice(0, 12) : id;
    return { id, shortId, name };
  }

  // Reuses the shared top-level mapPool() instead of keeping a duplicate
  // local copy of the exact same implementation.

  async function findInvalidViaInspect() {
    let list = await dhApi('/containers', 'GET', { all: 'true' });
    if (!list) list = await dhApi('/containers');
    if (list && !Array.isArray(list) && Array.isArray(list.containers)) list = list.containers;
    if (!Array.isArray(list) || !list.length) return [];

    const ids = new Set();
    const names = new Set();
    const resolved = []; // { id, name, networkMode }
    const needInspect = [];

    for (const c of list) {
      const { id, shortId, name } = listIdentity(c);
      if (id) {
        ids.add(id.toLowerCase());
        if (shortId) ids.add(shortId.toLowerCase());
      }
      if (name) names.add(name);
      if (Array.isArray(c.Names)) c.Names.forEach(n => names.add(normalize(n)));

      // Prefer NetworkMode from list payload (Docker mode fills this; avoids N inspects)
      const fromList = c.networkMode || getNetworkMode(c);
      if (fromList) {
        resolved.push({ id, name, networkMode: fromList });
      } else {
        const key = id || name;
        if (key) needInspect.push({ id, name, key });
      }
    }

    idLookup = Object.fromEntries(
      lookups.map(n => [n, list.find(c => listIdentity(c).name === n)?.id ||
        needInspect.find(item => item.name === n)?.id])
    );

    // Only inspect containers whose network mode wasn't on the list response
    if (needInspect.length) {
      const inspected = await mapPool(needInspect, IS_DOCKER ? DOCKER_STATS_CONCURRENCY : CONCURRENCY, async ({ id, name, key }) => {
        let detail = await dhApi(`/containers/${encodeURIComponent(key)}/inspect`);
        if (!detail) detail = await dhApi(`/containers/${encodeURIComponent(key)}`);
        if (!detail) return null;
        return {
          id: (detail.Id || detail.id || id || '').toString(),
          name: normalize(detail.Name || detail.name || name) || name || 'unknown',
          networkMode: getNetworkMode(detail)
        };
      });
      for (const row of inspected) if (row) resolved.push(row);
    }

    const invalid = [];
    for (const row of resolved) {
      if (!row?.networkMode) continue;
      const m = row.networkMode.match(/^container:(.+)$/i);
      if (!m) continue;
      const target = m[1].trim();
      const targetNorm = normalize(target);
      const targetLower = target.toLowerCase();
      const exists =
        names.has(targetNorm) ||
        ids.has(targetLower) ||
        ids.has(targetLower.slice(0, 12));
      if (!exists) {
        invalid.push({ name: row.name, id: row.id, networkMode: row.networkMode, target });
      }
    }
    return invalid;
  }

  function clearHighlights() {
    document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach(el => {
      el.classList.remove(HIGHLIGHT_CLASS);
      el.removeAttribute('data-netmode-warn');
    });
  }

  function highlightHomepageCards(invalid) {
    if (!invalid.length) return;
    const nameSet = new Set(invalid.map(x => normalize(x.name)));
    const idSet = new Set(invalid.map(x => (x.id || '').toLowerCase()).filter(Boolean));

    document.querySelectorAll('.service-card').forEach(card => {
      const root = card.closest('li.service') || card;
      const id = (root.id || '').toLowerCase();
      const extracted = extractContainerName(id) || '';
      const titleEl = card.querySelector('.service-name, .service-title, [class*="title"]') || card;
      const titleText = normalize(titleEl.textContent || '');

      const match =
        nameSet.has(extracted) ||
        nameSet.has(normalize(id)) ||
        [...nameSet].some(n => n && (id.includes(n) || titleText.includes(n))) ||
        [...idSet].some(cid => cid && id.includes(cid.slice(0, 12)));

      if (!match) return;

      const info = invalid.find(x =>
        normalize(x.name) === extracted ||
        normalize(x.name) === titleText ||
        (x.id && id.includes((x.id || '').toLowerCase().slice(0, 12)))
      );

      card.classList.add(HIGHLIGHT_CLASS);
      card.setAttribute(
        'data-netmode-warn',
        info ? `⚠ net → missing: ${info.target}` : '⚠ invalid network_mode:container'
      );
    });
  }

  function highlightStackRows(invalid) {
    if (!invalid.length) return;
    const nameSet = new Set(invalid.map(x => normalize(x.name)));
    document.querySelectorAll('.dh-nested-c-row, .dh-c-row').forEach(row => {
      const text = normalize(row.textContent || '');
      const hit = [...nameSet].find(n => n && text.includes(n));
      if (!hit) return;
      const info = invalid.find(x => normalize(x.name) === hit);
      row.classList.add(HIGHLIGHT_CLASS);
      row.setAttribute('data-netmode-warn', info ? `⚠ missing: ${info.target}` : '⚠ bad netmode');
    });
  }

  async function runCheck(showToastOnFind = false) {
    if (checkInFlight) return;
    checkInFlight = true;
    try {
      const invalid = await findInvalidViaInspect();
      window.__dhInvalidNetMode.byName = new Set(invalid.map(x => normalize(x.name)));
      window.__dhInvalidNetMode.byId = new Set(invalid.map(x => (x.id || '').toLowerCase()).filter(Boolean));
      window.__dhInvalidNetMode.details = invalid;
      clearHighlights();
      highlightHomepageCards(invalid);
      highlightStackRows(invalid);
      if (showToastOnFind && invalid.length) {
        const names = invalid.map(x => x.name).slice(0, 5).join(', ');
        const more = invalid.length > 5 ? ` (+${invalid.length - 5} more)` : '';
        showToast(`${invalid.length} container(s) use network_mode:container with missing target: ${names}${more}`, 'warning', 5000);
      }
    } catch (err) {
      console.error('Invalid-netmode check failed:', err);
    } finally {
      checkInFlight = false;
    }
  }

  onDomChange(() => {
    const invalid = window.__dhInvalidNetMode?.details;
    if (invalid?.length) {
      highlightHomepageCards(invalid);
      highlightStackRows(invalid);
    }
  });

  const start = () => {
    if (INVALID_NETWORK_CHECK) runCheck(INVALID_NETWORK_NOTIFICATION);
    if (CHECK_INTERVAL) setInterval(() => runCheck(false), CHECK_INTERVAL);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(start, 2000));
  } else {
    setTimeout(start, 2000);
  }

  window.dhCheckInvalidNetMode = () => runCheck(true);
})();

/* ====================== Service-card Memory / CPU status ====================== */
(function () {
  function loadCardStatsVisible() {
    if (!FEATURES.PERSIST_CARD_STATS) return CARD_STATS_DEFAULT_VISIBLE;
    try {
      const v = localStorage.getItem(CARD_STATS_STORAGE_KEY);
      if (v === '1') return true;
      if (v === '0') return false;
    } catch (_) {}
    return CARD_STATS_DEFAULT_VISIBLE;
  }
  let statsVisible = loadCardStatsVisible();

  Object.defineProperty(window, '__dhCardStatsVisible', {
    get: () => statsVisible
  });

  let updating = false;
  let lastCardCount = 0;

  function level(pct) {
    if (pct == null) return 'low';
    if (pct >= 85) return 'high';
    if (pct >= 60) return 'medium';
    return 'low';
  }

  function getServiceRoot(card) {
    return card.closest('li.service') || card.closest('[id]') || card;
  }

  function cardKeys(card) {
    const root = getServiceRoot(card);
    const id = (root.id || '').toLowerCase();
    const dataName = normalize(root.dataset?.name || root.getAttribute('data-name') || '');
    const extracted = extractContainerName(id) || '';
    const titleEl =
      card.querySelector('.service-name, .service-title-text, .service-title, [class*="title"]') || card;
    const titleText = normalize(titleEl.textContent || '');
    return [...new Set([extracted, normalize(id), dataName, titleText].filter(Boolean))];
  }

  function lookupStats(card) {
    return lookupStatByKeys(...cardKeys(card));
  }

  function ensureBadge(card) {
    let wrap = card.querySelector(':scope > .dh-card-stats-wrap');
    if (wrap) return wrap.querySelector('.dh-card-stats');

    wrap = document.createElement('div');
    wrap.className = 'dh-card-stats-wrap';
    const el = document.createElement('div');
    el.className = 'dh-card-stats layout-' + CARD_STATS_LAYOUT;
    wrap.appendChild(el);
    card.appendChild(wrap);
    return el;
  }

  function buildHtml(s, prev) {
    if (!s) return '';

    const parts = [];
    const cpuLabel = CARD_STATS_LAYOUT === 'single-nograph' ? 'C' : 'CPU';
    const memLabel = CARD_STATS_LAYOUT === 'single-nograph' ? '&nbsp;M' : 'MEM';
    const netLabel = '&nbsp;N';
    const diskLabel = '&nbsp;D';

    const changed = (key, threshold = 0.05) => {
      if (!prev) return false;
      const cur = s[key];
      const old = prev[key];
      if (cur == null || old == null) return false;
      return Math.abs(Number(cur) - Number(old)) >= threshold;
    };

    if (SHOW_CPU_ON_CARDS && s.cpuPercent != null) {
      const pct = Number(s.cpuPercent);
      parts.push({
        key: 'cpu',
        label: cpuLabel,
        pct,
        value: pct.toFixed(1) + '%',
        flash: changed('cpuPercent', 0.3)
      });
    }

    if (SHOW_MEMORY_ON_CARDS && (s.memoryPercent != null || s.memoryRaw != null)) {
      const pct = s.memoryPercent != null ? Number(s.memoryPercent) : null;
      const used = s.memoryRaw != null ? formatBytes(s.memoryRaw) : null;
      // Omit shared host RAM ceiling when configured (same RAM for all unlimited containers)
      const limit = formatMemLimitForDisplay(s.memoryLimit);

      // Prefer "12.5% (1.0GiB / 8.0GiB)" when limit shown; else "12.5% (1.0GiB)"
      let value;
      let value2;
      if (pct != null && used && limit) {
        value = pct.toFixed(1) + '%';
        value2 = `&nbsp;(${used} / ${limit})`;
      } else if (pct != null && limit) {
        value = pct.toFixed(1) + '%';
        value2 = `&nbsp;/ ${limit}`;
      } else if (pct != null && used) {
        value = pct.toFixed(1) + '%';
        value2 = `&nbsp;(${used})`;
      } else if (used && limit) {
        value = used;
        value2 = `&nbsp;/ ${limit}`;
      } else {
        value = pct != null ? pct.toFixed(1) + '%' : used || '–';
      }

      parts.push({
        key: 'mem',
        label: memLabel,
        pct,
        value,
        value2,
        flash: changed('memoryPercent', 0.1) || changed('memoryRaw', 1024 * 50) || changed('memoryLimit', 1024 * 1024)
      });
    }

    if (CARD_STATS_LAYOUT === 'single-nograph') {
      parts.push({
        key: 'net',
        label: netLabel,
        value: `<span class="dh-icon dh-rx">↓ </span>${formatBytes(s.networkRx ?? 0)}`,
        value2: `<span class="dh-icon dh-tx"> ↑ </span>${formatBytes(s.networkTx ?? 0)}`,
        flash: changed('networkRx', 1024) || changed('networkTx', 1024)
      });
      parts.push({
        key: 'disk',
        label: diskLabel,
        value: `<span class="dh-icon dh-read">r </span>${formatBytes(s.blockRead ?? 0)}`,
        value2: `<span class="dh-icon dh-write"> w </span>${formatBytes(s.blockWrite ?? 0)}`,
        flash: changed('blockRead', 1024) || changed('blockWrite', 1024)
      });
    }

    if (!parts.length) return '';

    if (CARD_STATS_LAYOUT === 'single-nograph') {
      return parts.map(p => `
        <span class="dh-card-stat-item${p.flash ? ' dh-stat-changed' : ''}" data-stat="${p.key}">
          <span class="dh-card-stats-label-single-nograph">${p.label}</span>
          <span class="dh-card-stats-value-single-nograph">${p.value}${p.value2 || ''}</span>
        </span>
      `).join('');
    }
    if (CARD_STATS_LAYOUT === 'single') {
      return parts.map(p => {
        const barW = p.pct != null ? Math.min(100, p.pct) : 0;
        return `
          <span class="dh-card-stat-item${p.flash ? ' dh-stat-changed' : ''}" data-stat="${p.key}">
            <span class="dh-card-stats-label">${p.label}</span>
            <span class="dh-card-bar">
              <span class="dh-card-bar-fill ${level(p.pct)}" style="width:${barW}%"></span>
            </span>
            <span class="dh-card-stats-value">${p.value}</span>
          </span>`;
      }).join('<span class="dh-card-sep">·</span>');
    }

    return parts.map(p => {
      const barW = p.pct != null ? Math.min(100, p.pct) : 0;
      return `
        <div class="dh-card-stats-row">
          <span class="dh-card-stats-label">${p.label}</span>
          <div class="dh-card-bar">
            <div class="dh-card-bar-fill ${level(p.pct)}" style="width:${barW}%"></div>
          </div>
          <span class="dh-card-stats-value">${p.value}</span>
        </div>`;
    }).join('');
  }

  function applyVisibility() {
    document.body.classList.toggle('dh-card-stats-on', statsVisible);
    if (!statsVisible) {
      // Turning off: clear immediately on every card. Turning on is left to
      // renderCard(), which only sets dh-has-stats when a card actually has
      // stat content — avoids a flash of empty boxes on stopped containers.
      document.querySelectorAll('.service-card.dh-has-stats').forEach(c => {
        c.classList.remove('dh-has-stats');
      });
    }
  }

  function getPrevStat(card) {
    const keys = cardKeys(card);
    for (const k of keys) {
      const n = normalize(k);
      if (window.__dhStatsCachePrev.has(n)) {
        return window.__dhStatsCachePrev.get(n);
      }
    }
    return null;
  }

  function ensureHealthBadge(card) {
    if (!FEATURES.HEALTH_BADGES) return null;
    let el = card.querySelector(':scope > .dh-health-badge');
    if (el) return el;
    el = document.createElement('div');
    el.className = 'dh-health-badge';
    card.appendChild(el);
    return el;
  }

  function renderHealthBadge(card) {
    if (!FEATURES.HEALTH_BADGES) return;
    const el = ensureHealthBadge(card);
    const keys = cardKeys(card);
    let info = null;
    for (const k of keys) {
      info = window.__dhHealthCache.get(normalize(k));
      if (info) break;
    }
    if (!info || (!info.health && info.restartCount == null)) {
      el.className = 'dh-health-badge is-empty';
      el.textContent = '';
      return;
    }
    const parts = [];
    if (info.health) {
      parts.push(info.health);
      el.dataset.health = info.health;
    } else {
      delete el.dataset.health;
    }
    if (info.restartCount != null && info.restartCount > 0) {
      parts.push(`↻${info.restartCount}`);
    }
    el.className = `dh-health-badge${info.health ? ` health-${info.health}` : ''}`;
    el.textContent = parts.join(' · ');
    el.title = parts.join(' · ');
  }

  function ensureRestartLoopBadge(card) {
    if (!FEATURES.RESTART_LOOP_ALERTS) return null;
    let el = card.querySelector(':scope > .dh-restart-loop-badge');
    if (el) return el;
    el = document.createElement('div');
    el.className = 'dh-restart-loop-badge';
    card.appendChild(el);
    return el;
  }

  function renderRestartLoopBadge(card) {
    if (!FEATURES.RESTART_LOOP_ALERTS) return;
    const el = ensureRestartLoopBadge(card);
    const keys = cardKeys(card);
    let info = null;
    for (const k of keys) {
      info = window.__dhRestartLoopSet.get(normalize(k));
      if (info) break;
    }
    card.classList.toggle('dh-restart-loop', !!info);
    if (!info) {
      el.className = 'dh-restart-loop-badge is-empty';
      el.textContent = '';
      return;
    }
    el.className = 'dh-restart-loop-badge';
    el.textContent = `🔁 ${info.count}×`;
    el.title = `${info.count} restarts in the last ~${info.windowMin} min`;
  }

  function renderCard(card) {
    const badge = ensureBadge(card);
    renderHealthBadge(card);
    renderRestartLoopBadge(card);

    if (!statsVisible) {
      card.classList.remove('dh-has-stats');
      if (badge.dataset.lastHtml !== '') {
        badge.dataset.lastHtml = '';
        badge.innerHTML = '';
      }
      return;
    }

    const s = lookupStats(card);
    const prevStat = getPrevStat(card);
    const next = buildHtml(s, prevStat);

    // Only expand the stats box when there's actual content (e.g. not for a
    // stopped/non-running container with no /stats data) — otherwise the
    // wrapper still animates open into an empty padded box.
    card.classList.toggle('dh-has-stats', !!next);

    if (badge.dataset.lastHtml === next && !next.includes('dh-stat-changed')) return;

    badge.dataset.lastHtml = next;
    badge.innerHTML = next;

    badge.querySelectorAll('.dh-stat-changed').forEach(el => {
      el.addEventListener('animationend', () => {
        el.classList.remove('dh-stat-changed');
      }, { once: true });
    });
  }

  function updateAllCards() {
    if (updating) return;
    updating = true;
    try {
      const cards = document.querySelectorAll('.service-card');
      cards.forEach(renderCard);
      lastCardCount = cards.length;
      rebuildStatsInterest();
    } finally {
      updating = false;
    }
  }

  function toggleCardStats() {
    statsVisible = !statsVisible;
    if (FEATURES.PERSIST_CARD_STATS) {
      try { localStorage.setItem(CARD_STATS_STORAGE_KEY, statsVisible ? '1' : '0'); } catch (_) {}
    }
    applyVisibility();
    updateAllCards();
    window.dhEnsureStatsPolling();
    window.dhMenu?.setActive('card-stats', statsVisible);
    showToast(statsVisible ? 'Card stats enabled' : 'Card stats hidden', 'info', 1500);
  }

  // Always re-render on a stats tick, not just when the CPU/mem overlay is toggled on:
  // health and restart-loop badges need to refresh live regardless of that toggle.
  // renderCard() itself still gates the CPU/mem bars behind `statsVisible`.
  window.addEventListener('dh-stats-updated', () => {
    updateAllCards();
  });

  onDomChange(() => {
    const count = document.querySelectorAll('.service-card').length;
    if (count !== lastCardCount) updateAllCards();
  });

  applyVisibility();
  setTimeout(() => window.dhRefreshStats?.(true), 2500);

  window.dhToggleCardStats = toggleCardStats;

  window.dhMenu?.register({
    id: 'card-stats',
    icon: '📊',
    label: 'Card stats',
    order: 20,
    type: 'toggle',
    getActive: () => statsVisible,
    onClick: toggleCardStats
  });
})();

/* ====================== History / Detailed Charts Panel (Chart.js) ====================== */
(function () {
  let panelOpen = HISTORY_PANEL_DEFAULT_OPEN;
  let comboGraph = true;
  let comboDeltaMode = false; // absolute vs per-interval delta
  let sortKey = 'name';
  let sortDir = 1;
  let expanded = new Set();
  let selectedNames = new Set(); // bulk selection
  let chartJsLoaded = false;

  let combinedCharts = {};
  let miniCharts = new Map();
  let tableBuilt = false;

  const VISIBLE_WINDOW_MS = 5 * 60 * 1000;
  const COMBO_TOP_N = 6; // max individual series on combined charts (plus Total)
  const METRICS_LIST = ['cpu', 'mem', 'memRaw', 'netRx', 'netTx', 'blockRead', 'blockWrite'];
  const METRIC_LABELS = {
    cpu: 'CPU %', mem: 'Memory %', memRaw: 'MEM',
    netRx: 'Net Rx', netTx: 'Net Tx', blockRead: 'Disk Read', blockWrite: 'Disk Write'
  };

  let highlightName = null; // table-row hover → emphasize on combined charts

  Object.defineProperty(window, '__dhHistoryPanelOpen', {
    get: () => panelOpen,
    configurable: true
  });

  function loadChartJs() {
    return new Promise((resolve, reject) => {
      if (window.Chart) { chartJsLoaded = true; return resolve(); }
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js';
      script.onload = () => { chartJsLoaded = true; resolve(); };
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  const panel = document.createElement('div');
  panel.id = 'dh-history-panel';
    panel.innerHTML = `
    <div class="dh-hist-toolbar">
      <div class="dh-hist-toolbar-title">📊 Container History · last ${HISTORY_MINUTES} min <small style="opacity:.5">(${BACKEND.MODE})</small></div>
      <div class="dh-hist-toolbar-actions">
        <button id="dh-hist-combotoggle" class="dh-hist-btn" title="Toggle Graphs">📈</button>
        <button id="dh-hist-totaltoggle" class="dh-hist-btn" title="Toggle Total (separate axis)">∑</button>
        ${FEATURES.DELTA_COMBO ? '<button id="dh-hist-deltatoggle" class="dh-hist-btn" title="Toggle Absolute / Delta charts">Δ</button>' : ''}
        ${FEATURES.EXPORT_HISTORY ? '<button id="dh-hist-export" class="dh-hist-btn" title="Export CSV">⬇</button>' : ''}
        <button id="dh-hist-refresh" class="dh-hist-btn" title="Refresh">↻</button>
        <button id="dh-hist-close" class="dh-hist-btn-close" title="Close">×</button>
      </div>
    </div>
    <div id="dh-hist-charts"></div>
    <div class="dh-hist-hint">
      Click headers to sort · expand row for per-container charts · select rows for bulk actions
    </div>
    <div id="dh-hist-bulk" class="dh-hist-bulk is-empty">
      <div class="dh-hist-bulk-left">
        <label class="dh-hist-bulk-selectall">
          <input type="checkbox" id="dh-hist-select-all" />
          <span>Select all</span>
        </label>
        <span id="dh-hist-bulk-count" class="dh-hist-bulk-count">0 selected</span>
        <button type="button" id="dh-hist-bulk-clear" class="dh-hist-btn dh-hist-bulk-clear" title="Clear selection">Clear</button>
      </div>
      <div class="dh-hist-bulk-actions">
        <button type="button" class="dh-hist-bulk-btn dh-hist-bulk-start" data-bulk="start" title="Start selected">▶ Start</button>
        <button type="button" class="dh-hist-bulk-btn dh-hist-bulk-restart" data-bulk="restart" title="Restart selected">↻ Restart</button>
        <button type="button" class="dh-hist-bulk-btn dh-hist-bulk-stop" data-bulk="stop" title="Stop selected">■ Stop</button>
      </div>
    </div>
    <div id="dh-hist-table-wrap"></div>
  `;
  document.body.appendChild(panel);

  function getAllKeys() {
    return [...window.__dhStatsHistory.keys()].sort((a, b) => a.localeCompare(b));
  }

  function getLatest(key) {
    const arr = window.__dhStatsHistory.get(key);
    return arr?.length ? arr[arr.length - 1] : null;
  }

  function destroyChart(chart) {
    if (chart && typeof chart.destroy === 'function') {
      try { chart.destroy(); } catch (_) {}
    }
  }

  function getPoints(name, metric) {
    return (window.__dhStatsHistory.get(name) || [])
      .filter(e => e[metric] != null && !isNaN(e[metric]))
      .map(e => ({ x: e.t, y: Number(e[metric]) }));
  }

  function isByteMetric(m) {
    return m.startsWith('net') || m.startsWith('block') || m === 'memRaw';
  }

  /** Cumulative I/O counters (Docker blkio/net) — a large drop means reset, not negative traffic */
  function isCumulativeByteMetric(m) {
    return m.startsWith('net') || m.startsWith('block');
  }

  /** Convert absolute time series → per-sample delta (rate). Counter resets → 0. */
  function toDeltaPoints(points, metric) {
    if (!points || points.length < 2) return [];
    const out = [];
    for (let i = 1; i < points.length; i++) {
      let d = points[i].y - points[i - 1].y;
      if (isCumulativeByteMetric(metric) && d < 0 && points[i - 1].y - points[i].y > 1024) {
        d = 0;
      }
      out.push({ x: points[i].x, y: d });
    }
    return out;
  }

  function getDeltaPoints(name, metric) {
    return toDeltaPoints(getPoints(name, metric), metric);
  }

  /** Sum of per-interval deltas over the retained history (handles counter resets). */
  function totalDeltaFromPoints(points, metric) {
    if (!points || points.length < 2) return 0;
    let sum = 0;
    for (let i = 1; i < points.length; i++) {
      let d = points[i].y - points[i - 1].y;
      if (isCumulativeByteMetric(metric) && d < 0 && points[i - 1].y - points[i].y > 1024) {
        d = 0;
      }
      sum += d;
    }
    return sum;
  }

  function totalDeltaValue(name, metric) {
    return totalDeltaFromPoints(getPoints(name, metric), metric);
  }

  function totalDeltaHtml(value, metric) {
    // Match interval Δ styling exactly (inline colors / size / weight)
    if (value == null || !isFinite(value)) {
      return ' <span style="color:#64748b;font-size:10.5px">–</span>';
    }
    if (value === 0) {
      return ' <span style="color:#64748b;font-size:10.5px">±0</span>';
    }
    const abs = Math.abs(value);
    const formatted = isByteMetric(metric) ? formatBytes(abs) : abs.toFixed(1);
    if (value > 0) {
      return ` <span style="color:#22c55e;font-size:10.5px;font-weight:600">▲${formatted}</span>`;
    }
    return ` <span style="color:#ef4444;font-size:10.5px;font-weight:600">▼${formatted}</span>`;
  }

  /** Last-interval delta for one metric (0 on counter reset). */
  function lastIntervalDelta(name, metric) {
    const points = getPoints(name, metric) || [];
    if (points.length < 2) return 0;
    let d = points[points.length - 1].y - points[points.length - 2].y;
    if (isCumulativeByteMetric(metric) && d < 0 &&
        points[points.length - 2].y - points[points.length - 1].y > 1024) {
      d = 0;
    }
    return d;
  }

  /** Combined last-interval Δ: net = Rx+Tx, disk = Read+Write (this update). */
  function combinedLastDelta(name, kind) {
    if (kind === 'net') {
      return lastIntervalDelta(name, 'netRx') + lastIntervalDelta(name, 'netTx');
    }
    if (kind === 'disk') {
      return lastIntervalDelta(name, 'blockRead') + lastIntervalDelta(name, 'blockWrite');
    }
    return 0;
  }

  /** Combined window totals: net = Rx+Tx, disk = Read+Write */
  function combinedTotalDelta(name, kind) {
    if (kind === 'net') {
      return totalDeltaValue(name, 'netRx') + totalDeltaValue(name, 'netTx');
    }
    if (kind === 'disk') {
      return totalDeltaValue(name, 'blockRead') + totalDeltaValue(name, 'blockWrite');
    }
    return 0;
  }

  function deltaHtml(points, m) {
    if (points.length < 2) {
      return points.length === 1
        ? ' <span style="color:#64748b;font-size:10.5px">±0</span>'
        : ' <span style="color:#64748b;font-size:10.5px">–</span>';
    }
    const cur = points[points.length - 1].y;
    const prev = points[points.length - 2].y;
    let numericalDelta = cur - prev;

    // Docker blkio/net are lifetime counters. A big drop = container recreate / cgroup reset.
    if (isCumulativeByteMetric(m) && numericalDelta < 0 && prev - cur > 1024) {
      return ' <span style="color:#64748b;font-size:10.5px" title="counter reset">↺</span>';
    }

    const formattedDiff = isByteMetric(m)
      ? formatBytes(Math.abs(numericalDelta))
      : Math.abs(numericalDelta).toFixed(1);
    if (numericalDelta > 0) {
      return ` <span style="color:#22c55e;font-size:10.5px;font-weight:600">▲${formattedDiff}</span>`;
    }
    if (numericalDelta < 0) {
      return ` <span style="color:#ef4444;font-size:10.5px;font-weight:600">▼${formattedDiff}</span>`;
    }
    return ' <span style="color:#64748b;font-size:10.5px">±0</span>';
  }

  /** Stable HSL color from container name (same color across all charts) */
  function colorForName(name) {
    let h = 0;
    const s = String(name || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return `hsl(${h % 360} 72% 58%)`;
  }

  /**
   * Pick series for a combined chart:
   * - live containers only
   * - ranked by max value inside the visible window (fallback: latest)
   * - top COMBO_TOP_N
   * - always include highlightName if live (even if outside top-N)
   */
  function selectComboSeries(metricKey, { delta = false } = {}) {
    const now = Date.now();
    const windowStart = now - VISIBLE_WINDOW_MS;
    const scored = [];

    for (const name of getAllKeys()) {
      if (!isStatLive(name)) continue;
      const raw = getPoints(name, metricKey);
      const pts = (delta ? toDeltaPoints(raw, metricKey) : raw).filter(p => p.x >= windowStart);
      if (pts.length < 2) continue;
      let maxY = -Infinity;
      let lastY = pts[pts.length - 1].y;
      for (const p of pts) {
        const v = delta ? Math.abs(p.y) : p.y;
        if (v > maxY) maxY = v;
      }
      scored.push({
        name,
        maxY,
        lastY,
        points: delta ? toDeltaPoints(raw, metricKey) : raw
      });
    }

    scored.sort((a, b) => b.maxY - a.maxY || b.lastY - a.lastY);
    const top = scored.slice(0, COMBO_TOP_N);

    if (highlightName && isStatLive(highlightName)) {
      const already = top.some(s => s.name === highlightName);
      if (!already) {
        const raw = getPoints(highlightName, metricKey);
        const pts = delta ? toDeltaPoints(raw, metricKey) : raw;
        if (pts.length >= 2) {
          top.push({
            name: highlightName,
            maxY: 0,
            lastY: pts[pts.length - 1].y,
            points: pts
          });
        }
      }
    }

    return top;
  }

  /** Sum of all live series at aligned timestamps (approximate via latest-per-bucket) */
  function buildTotalSeries(metricKey, seriesList) {
    if (!seriesList.length) return [];
    // Collect all timestamps from selected series
    const tsSet = new Set();
    for (const s of seriesList) s.points.forEach(p => tsSet.add(p.x));
    const timestamps = [...tsSet].sort((a, b) => a - b);
    if (timestamps.length < 2) return [];

    // For each ts, sum last-known value of each series at or before ts
    const cursors = seriesList.map(() => 0);
    const lastVals = seriesList.map(() => 0);
    const out = [];

    for (const t of timestamps) {
      let sum = 0;
      for (let i = 0; i < seriesList.length; i++) {
        const pts = seriesList[i].points;
        while (cursors[i] < pts.length && pts[cursors[i]].x <= t) {
          lastVals[i] = pts[cursors[i]].y;
          cursors[i]++;
        }
        sum += lastVals[i] || 0;
      }
      out.push({ x: t, y: sum });
    }
    return out;
  }

  // Total on a separate Y-axis so large sums don't crush individual lines
  let showComboTotal = true;

  const COMBINED_METRICS = [
    { key: 'cpu', label: 'CPU %', unit: '%', showTotal: true },
    // Share of combined CPU (always ~sums to 100%) — readable next to absolute CPU %
    { key: 'cpuShare', label: 'CPU share %', unit: '%', showTotal: false, derived: true },
    { key: 'mem', label: 'Memory %', unit: '%', showTotal: true },
    { key: 'memRaw', label: 'Memory', unit: 'B', showTotal: true },
    { key: 'netRx', label: 'Network Rx', unit: 'B', showTotal: true },
    { key: 'netTx', label: 'Network Tx', unit: 'B', showTotal: true },
    { key: 'blockRead', label: 'Disk Read', unit: 'B', showTotal: true },
    { key: 'blockWrite', label: 'Disk Write', unit: 'B', showTotal: true }
  ];

  /** Build CPU-share series: each container's CPU as % of sum of live CPUs at each timestamp */
  function buildCpuShareSeries(seriesList) {
    if (!seriesList.length) return [];
    const tsSet = new Set();
    for (const s of seriesList) s.points.forEach(p => tsSet.add(p.x));
    const timestamps = [...tsSet].sort((a, b) => a - b);
    if (timestamps.length < 2) return seriesList.map(s => ({ ...s, points: [] }));

    const cursors = seriesList.map(() => 0);
    const lastVals = seriesList.map(() => 0);
    const outPoints = seriesList.map(() => []);

    for (const t of timestamps) {
      let sum = 0;
      for (let i = 0; i < seriesList.length; i++) {
        const pts = seriesList[i].points;
        while (cursors[i] < pts.length && pts[cursors[i]].x <= t) {
          lastVals[i] = pts[cursors[i]].y;
          cursors[i]++;
        }
        sum += lastVals[i] || 0;
      }
      for (let i = 0; i < seriesList.length; i++) {
        const share = sum > 0 ? ((lastVals[i] || 0) / sum) * 100 : 0;
        outPoints[i].push({ x: t, y: share });
      }
    }
    return seriesList.map((s, i) => ({
      name: s.name,
      maxY: Math.max(...outPoints[i].map(p => p.y), 0),
      lastY: outPoints[i].length ? outPoints[i][outPoints[i].length - 1].y : 0,
      points: outPoints[i]
    }));
  }

  function destroyCombinedCharts() {
    Object.values(combinedCharts).forEach(destroyChart);
    combinedCharts = {};
    const comboContainer = document.getElementById('dh-hist-charts');
    if (comboContainer) comboContainer.innerHTML = '';
  }

  function ensureCombinedCharts() {
    const comboContainer = document.getElementById('dh-hist-charts');
    if (!comboContainer || !window.Chart) return;
    if (Object.keys(combinedCharts).length === COMBINED_METRICS.length) return;

    comboContainer.innerHTML = '';
    comboContainer.classList.add('dh-combo-charts-grid');

    COMBINED_METRICS.forEach(m => {
      const wrap = document.createElement('div');
      wrap.className = 'dh-combo-chart-wrap';
      wrap.dataset.metric = m.key;
      wrap.innerHTML = `
        <div class="dh-combo-chart-head">
          <div class="dh-combo-chart-title">${m.label}${m.derived ? ' <span class="dh-combo-derived">(of live)</span>' : ''}</div>
          <div class="dh-combo-legend" data-metric="${m.key}"></div>
        </div>
        <div class="dh-combo-chart-canvas-wrap">
          <canvas></canvas>
        </div>`;
      comboContainer.appendChild(wrap);

      const canvas = wrap.querySelector('canvas');
      const yTick = (v) => (m.unit === 'B' ? formatBytes(v) : Number(v).toFixed(m.unit === '%' ? 0 : 1));

      combinedCharts[m.key] = new Chart(canvas, {
        type: 'line',
        data: { datasets: [] },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          interaction: { mode: 'nearest', intersect: false, axis: 'x' },
          plugins: {
            legend: { display: false },
            tooltip: {
              filter: (item) => item.dataset.dhDimmed !== true,
              // Solid color swatch (not transparent fill + colored outline)
              displayColors: true,
              boxWidth: 12,
              boxHeight: 12,
              boxPadding: 4,
              usePointStyle: false,
              callbacks: {
                title: (items) => items.length
                  ? new Date(items[0].parsed.x).toLocaleTimeString([], {
                      hour: '2-digit', minute: '2-digit', second: '2-digit'
                    })
                  : '',
                label: (ctx) => {
                  const v = ctx.parsed.y;
                  const formatted = m.unit === 'B' ? formatBytes(v) : v.toFixed(1) + m.unit;
                  return `${ctx.dataset.label}: ${formatted}`;
                },
                // Line datasets use transparent backgroundColor — force solid box
                labelColor: (ctx) => {
                  const c = ctx.dataset.borderColor || ctx.dataset.backgroundColor || '#94a3b8';
                  return {
                    borderColor: c,
                    backgroundColor: c,
                    borderWidth: 0,
                    borderRadius: 2
                  };
                }
              }
            }
          },
          scales: {
            x: {
              type: 'linear',
              ticks: {
                callback: (v) => new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
                maxTicksLimit: 4,
                color: '#64748b',
                font: { size: 10 }
              },
              grid: { display: false, color: '#1e293b' }
            },
            // Left axis: individual series only (Total does not affect this scale)
            y: {
              beginAtZero: false,
              position: 'left',
              ticks: {
                callback: yTick,
                color: '#64748b',
                font: { size: 10 },
                maxTicksLimit: 5
              },
              grid: { color: '#1e293b' }
            },
            // Right axis: Total line only — independent scale
            y1: {
              beginAtZero: true,
              position: 'right',
              display: false, // toggled when Total is present
              ticks: {
                callback: yTick,
                color: '#94a3b8',
                font: { size: 9 },
                maxTicksLimit: 5
              },
              grid: { drawOnChartArea: false }
            }
          }
        }
      });
    });
  }

  function updateCombinedCharts() {
    ensureCombinedCharts();

    COMBINED_METRICS.forEach(m => {
      const chart = combinedCharts[m.key];
      if (!chart) return;

      // Derived metrics (cpuShare) always absolute; others respect delta mode
      const useDelta = !!(FEATURES.DELTA_COMBO && comboDeltaMode && !(m.derived && m.key === 'cpuShare'));
      const baseKey = m.derived && m.key === 'cpuShare' ? 'cpu' : m.key;
      let series = selectComboSeries(baseKey, { delta: useDelta });
      if (m.derived && m.key === 'cpuShare') {
        series = buildCpuShareSeries(selectComboSeries('cpu', { delta: false }));
      }
      const datasets = [];

      // Individual top-N on LEFT axis (Total never shares this scale)
      for (const s of series) {
        const isHL = highlightName && s.name === highlightName;
        const dimmed = !!(highlightName && !isHL);
        const base = colorForName(s.name);
        datasets.push({
          label: s.name,
          data: s.points,
          borderColor: dimmed ? base.replace('58%)', '32%)') : base,
          backgroundColor: 'transparent',
          borderWidth: isHL ? 2.8 : 1.6,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.25,
          yAxisID: 'y',
          dhDimmed: dimmed
        });
      }

      // Total on RIGHT axis — independent scale so it can't crush the others
      let hasTotal = false;
      if (showComboTotal && m.showTotal && series.length >= 1) {
        const totalPts = buildTotalSeries(baseKey, selectComboSeries(baseKey, { delta: useDelta }));
        if (totalPts.length >= 2) {
          hasTotal = true;
          datasets.unshift({
            label: useDelta ? 'Total Δ' : 'Total',
            data: totalPts,
            borderColor: '#e2e8f0',
            backgroundColor: 'transparent',
            borderWidth: 2.2,
            borderDash: [4, 3],
            pointRadius: 0,
            pointHoverRadius: 4,
            tension: 0.2,
            yAxisID: 'y1',
            dhDimmed: false
          });
        }
      }

      if (chart.options.scales.y1) {
        chart.options.scales.y1.display = hasTotal;
      }

      chart.data.datasets = datasets;

      // Title suffix for delta mode
      const titleEl = chart.canvas?.closest('.dh-combo-chart-wrap')?.querySelector('.dh-combo-chart-title');
      if (titleEl) {
        const baseLabel = m.label + (m.derived ? ' <span class="dh-combo-derived">(of live)</span>' : '');
        titleEl.innerHTML = useDelta ? `${m.label} <span class="dh-combo-derived">Δ / interval</span>` : baseLabel;
      }

      // Compact legend text under title
      const legendEl = document.querySelector(`.dh-combo-legend[data-metric="${m.key}"]`);
      if (legendEl) {
        const names = series.map(s => s.name);
        legendEl.textContent = names.length
          ? (names.length <= 3 ? names.join(' · ') : names.slice(0, 3).join(' · ') + ` +${names.length - 3}`)
          : 'no live activity';
        legendEl.title = names.join(', ');
      }

      let globalLatestTime = null;
      for (const dataset of chart.data.datasets) {
        if (dataset.data?.length) {
          const t = dataset.data[dataset.data.length - 1].x;
          if (globalLatestTime === null || t > globalLatestTime) globalLatestTime = t;
        }
      }

      if (globalLatestTime !== null) {
        chart.options.scales.x.max = globalLatestTime;
        chart.options.scales.x.min = globalLatestTime - VISIBLE_WINDOW_MS;
      }

      chart.update('none');
    });
  }

  function updateBulkBar() {
    const bar = document.getElementById('dh-hist-bulk');
    const countEl = document.getElementById('dh-hist-bulk-count');
    const selectAll = document.getElementById('dh-hist-select-all');
    const thSelectAll = document.getElementById('dh-hist-th-select-all');
    const n = selectedNames.size;
    if (countEl) countEl.textContent = `${n} selected`;
    if (bar) bar.classList.toggle('is-empty', n === 0);

    // Sync header/toolbar select-all from visible rows
    const wrap = document.getElementById('dh-hist-table-wrap');
    const boxes = wrap ? [...wrap.querySelectorAll('.dh-hist-row-cb')] : [];
    const allChecked = boxes.length > 0 && boxes.every(cb => cb.checked);
    const someChecked = boxes.some(cb => cb.checked);
    if (selectAll) {
      selectAll.checked = allChecked;
      selectAll.indeterminate = someChecked && !allChecked;
    }
    if (thSelectAll) {
      thSelectAll.checked = allChecked;
      thSelectAll.indeterminate = someChecked && !allChecked;
    }
  }

  function setAllVisibleSelected(on) {
    const wrap = document.getElementById('dh-hist-table-wrap');
    if (!wrap) return;
    wrap.querySelectorAll('.dh-hist-row-cb').forEach(cb => {
      const name = cb.dataset.name;
      if (!name) return;
      cb.checked = on;
      if (on) selectedNames.add(name);
      else selectedNames.delete(name);
      const tr = cb.closest('tr');
      if (tr) tr.classList.toggle('dh-hist-row-selected', on);
    });
    updateBulkBar();
  }

  async function runBulkAction(action) {
    const names = [...selectedNames];
    if (!names.length) {
      showToast('No containers selected', 'info', 1500);
      return;
    }
    if (FEATURES.CAPABILITY_PROBE && window.__dhCapabilities.write === false) {
      showToast('Backend is read-only — action disabled', 'warning', 2200);
      return;
    }

    const label = action.charAt(0).toUpperCase() + action.slice(1);
    if (FEATURES.CONFIRM_ACTIONS) {
      const preview = names.slice(0, 8).map(n => `<code>${n}</code>`).join(', ')
        + (names.length > 8 ? ` <span class="dh-confirm-meta">+${names.length - 8} more</span>` : '');
      const ok = await window.dhConfirm(
        `${label} ${names.length} container(s)?`,
        `Apply <strong>${action}</strong> to:<div class="dh-confirm-preview">${preview}</div>`,
        { okLabel: `${label} ${names.length}`, danger: action === 'stop' }
      );
      if (!ok) return;
    }

    const items = names.map(name => ({ id: name, name, action }));
    const { okCount, total } = await window.dhBatchProgress(
      `Bulk ${label}`,
      items,
      async it => dhApi(`/containers/${encodeURIComponent(it.id)}/${action}`, 'POST'),
      {
        meta: `${names.length} container(s)`,
        onClose: () => {
          selectedNames.clear();
          window.dhRefreshStats?.(true);
          tableBuilt = false;
          buildTable();
        }
      }
    );
    showToast(`Bulk ${action}: ${okCount}/${total} ok`, okCount === total ? 'success' : 'warning', 3000);
  }

  function buildTable() {
    const wrap = document.getElementById('dh-hist-table-wrap');
    if (!wrap) return;

    const scrollTop = wrap.scrollTop;
    miniCharts.forEach(destroyChart);
    miniCharts.clear();

    const keys = getAllKeys();
    const rows = keys.map(name => {
      const live = isStatLive(name);
      const l = live ? (getLatest(name) || {}) : {};
      const rowObj = {
        name,
        live,
        // Realtime values only when still reporting; history is kept separately
        cpu: live ? (l.cpu ?? null) : null,
        mem: live ? (l.mem ?? null) : null,
        memRaw: live ? (l.memRaw ?? null) : null,
        memLimit: live ? (l.memLimit ?? null) : null,
        netRx: live ? (l.netRx ?? 0) : null,
        netTx: live ? (l.netTx ?? 0) : null,
        blockRead: live ? (l.blockRead ?? 0) : null,
        blockWrite: live ? (l.blockWrite ?? 0) : null
      };

      METRICS_LIST.forEach(m => {
        if (!live) {
          rowObj[`${m}_deltaValue`] = 0;
          rowObj[`${m}_deltaHtml`] = ' <span style="color:#64748b;font-size:10.5px">–</span>';
          return;
        }
        const points = getPoints(name, m) || [];
        let numericalDelta = 0;
        if (points.length >= 2) {
          numericalDelta = points[points.length - 1].y - points[points.length - 2].y;
          // Counter reset on cumulative I/O → treat as 0 for sort/value
          if (isCumulativeByteMetric(m) && numericalDelta < 0 &&
              points[points.length - 2].y - points[points.length - 1].y > 1024) {
            numericalDelta = 0;
          }
        }
        rowObj[`${m}_deltaValue`] = numericalDelta;
        rowObj[`${m}_deltaHtml`] = deltaHtml(points, m);
      });

      // Combined last-interval Δ + window ΣΔ: net (Rx+Tx), disk (R+W)
      if (!live) {
        rowObj.net_lastDelta = 0;
        rowObj.disk_lastDelta = 0;
        rowObj.net_totalDelta = 0;
        rowObj.disk_totalDelta = 0;
        rowObj.net_lastDeltaHtml = totalDeltaHtml(null, 'netRx');
        rowObj.disk_lastDeltaHtml = totalDeltaHtml(null, 'blockRead');
        rowObj.net_totalDeltaHtml = totalDeltaHtml(null, 'netRx');
        rowObj.disk_totalDeltaHtml = totalDeltaHtml(null, 'blockRead');
      } else {
        const netLast = combinedLastDelta(name, 'net');
        const diskLast = combinedLastDelta(name, 'disk');
        const netTot = combinedTotalDelta(name, 'net');
        const diskTot = combinedTotalDelta(name, 'disk');
        rowObj.net_lastDelta = netLast;
        rowObj.disk_lastDelta = diskLast;
        rowObj.net_totalDelta = netTot;
        rowObj.disk_totalDelta = diskTot;
        rowObj.net_lastDeltaHtml = totalDeltaHtml(netLast, 'netRx');
        rowObj.disk_lastDeltaHtml = totalDeltaHtml(diskLast, 'blockRead');
        rowObj.net_totalDeltaHtml = totalDeltaHtml(netTot, 'netRx');
        rowObj.disk_totalDeltaHtml = totalDeltaHtml(diskTot, 'blockRead');
      }

      return rowObj;
    });

    rows.sort((a, b) => {
      // Live containers first, then offline (history-only)
      if (a.live !== b.live) return a.live ? -1 : 1;
      if (sortKey === 'name') return a.name.localeCompare(b.name) * sortDir;
      // Prefer precomputed numeric fields (incl. *_deltaValue / *_totalDelta)
      const va = a[sortKey] ?? -Infinity;
      const vb = b[sortKey] ?? -Infinity;
      return (va - vb) * sortDir;
    });

    const th = (key, label, isDelta = false) => {
      const targetKey = isDelta ? `${key}_deltaValue` : key;
      const active = sortKey === targetKey;
      const padding = isDelta ? 'padding:8px 6px' : 'padding:8px 10px';
      const textAlignment = isDelta ? 'text-align:right' : 'text-align:left';
      return `<th data-sort="${targetKey}" style="cursor:pointer;${padding};${textAlignment};font-size:11px;white-space:nowrap;color:${active ? '#38bdf8' : '#94a3b8'};user-select:none">
        ${label}${active ? (sortDir === 1 ? ' ↑' : ' ↓') : ''}
      </th>`;
    };

    const thCombined = (key, kind, label, tip) => {
      // kind: 'lastDelta' | 'totalDelta'
      const targetKey = `${key}_${kind}`;
      const active = sortKey === targetKey;
      return `<th data-sort="${targetKey}" title="${tip}" style="cursor:pointer;padding:8px 6px;text-align:right;font-size:11px;white-space:nowrap;color:${active ? '#38bdf8' : '#94a3b8'};user-select:none">
        ${label}${active ? (sortDir === 1 ? ' ↑' : ' ↓') : ''}
      </th>`;
    };

    const thTotal = (key, label) => thCombined(
      key, 'totalDelta', label,
      key === 'net'
        ? 'Total network traffic (Rx + Tx) over history window'
        : key === 'disk'
          ? 'Total disk I/O (Read + Write) over history window'
          : 'Total delta over retained history window'
    );

    const thLast = (key, label) => thCombined(
      key, 'lastDelta', label,
      key === 'net'
        ? 'This update: Net Rx Δ + Net Tx Δ'
        : key === 'disk'
          ? 'This update: Disk Read Δ + Disk Write Δ'
          : 'Combined delta for this update'
    );

    let html = `<table style="width:100%;border-collapse:collapse;font-size:12.5px">
      <thead>
        <tr style="border-bottom:1px solid #334155;position:sticky;top:0;background:#0f172a;z-index:1">
          <th style="width:28px;padding:8px 4px;text-align:center">
            <input type="checkbox" id="dh-hist-th-select-all" class="dh-hist-cb" title="Select all visible" />
          </th>
          ${th('name', 'Container')}
          ${th('cpu', 'CPU')} ${th('cpu', 'Δ', true)}
          ${th('mem', 'Mem')} ${th('mem', 'Δ', true)}
          ${th('memRaw', 'Mem Raw')} ${th('memRaw', 'Δ', true)}
          ${th('netRx', 'Net Rx')} ${th('netRx', 'Δ', true)}
          ${th('netTx', 'Net Tx')} ${th('netTx', 'Δ', true)}
          ${thLast('net', 'Net Δ')}
          ${thTotal('net', 'Net ΣΔ')}
          ${th('blockRead', 'Disk R')} ${th('blockRead', 'Δ', true)}
          ${th('blockWrite', 'Disk W')} ${th('blockWrite', 'Δ', true)}
          ${thLast('disk', 'Disk Δ')}
          ${thTotal('disk', 'Disk ΣΔ')}
          <th style="width:88px;padding:8px 6px;font-size:11px;color:#94a3b8;text-align:center;white-space:nowrap">Actions</th>
          <th style="width:36px"></th>
        </tr>
      </thead>
      <tbody>`;

    rows.forEach(r => {
      const open = expanded.has(r.name);
      const nameStyle = r.live
        ? 'padding:7px 10px;font-weight:500;max-width:140px;overflow:hidden;text-overflow:ellipsis'
        : 'padding:7px 10px;font-weight:500;max-width:140px;overflow:hidden;text-overflow:ellipsis;opacity:.45';
      const nameLabel = r.live
        ? r.name
        : `${r.name} <span style="font-size:10px;color:#94a3b8;font-weight:400">offline</span>`;
      const dash = '–';
      const isSelected = selectedNames.has(r.name);
      html += `
        <tr data-name="${r.name}" data-live="${r.live ? '1' : '0'}" class="${isSelected ? 'dh-hist-row-selected' : ''}" style="border-bottom:1px solid #1e293b${r.live ? '' : ';opacity:.7'}">
          <td class="dh-hist-cb-cell">
            <input type="checkbox" class="dh-hist-cb dh-hist-row-cb" data-name="${r.name}" ${isSelected ? 'checked' : ''} />
          </td>
          <td style="${nameStyle}">${nameLabel}</td>
          <td style="padding:7px 10px" data-col="cpu">${r.cpu != null ? r.cpu.toFixed(1) + '%' : dash}</td>
          <td style="padding:7px 6px;text-align:right" data-delta="cpu">${r.cpu_deltaHtml}</td>
          <td style="padding:7px 10px" data-col="mem">${
            r.mem != null ? (formatMemPctLine(r.mem, r.memRaw, r.memLimit) || dash) : dash
          }</td>
          <td style="padding:7px 6px;text-align:right" data-delta="mem">${r.mem_deltaHtml}</td>
          <td style="padding:7px 10px" data-col="memRaw">${
            r.memRaw != null ? (formatMemRawLine(r.memRaw, r.memLimit) || dash) : dash
          }</td>
          <td style="padding:7px 6px;text-align:right" data-delta="memRaw">${r.memRaw_deltaHtml}</td>
          <td style="padding:7px 10px" data-col="netRx">${r.netRx != null ? formatBytes(r.netRx) : dash}</td>
          <td style="padding:7px 6px;text-align:right" data-delta="netRx">${r.netRx_deltaHtml}</td>
          <td style="padding:7px 10px" data-col="netTx">${r.netTx != null ? formatBytes(r.netTx) : dash}</td>
          <td style="padding:7px 6px;text-align:right" data-delta="netTx">${r.netTx_deltaHtml}</td>
          <td style="padding:7px 6px;text-align:right" data-lastdelta="net" title="This update: Rx Δ + Tx Δ">${r.net_lastDeltaHtml}</td>
          <td style="padding:7px 6px;text-align:right" data-totaldelta="net" title="Total network traffic (Rx+Tx) over history window">${r.net_totalDeltaHtml}</td>
          <td style="padding:7px 10px" data-col="blockRead">${r.blockRead != null ? formatBytes(r.blockRead) : dash}</td>
          <td style="padding:7px 6px;text-align:right" data-delta="blockRead">${r.blockRead_deltaHtml}</td>
          <td style="padding:7px 10px" data-col="blockWrite">${r.blockWrite != null ? formatBytes(r.blockWrite) : dash}</td>
          <td style="padding:7px 6px;text-align:right" data-delta="blockWrite">${r.blockWrite_deltaHtml}</td>
          <td style="padding:7px 6px;text-align:right" data-lastdelta="disk" title="This update: Read Δ + Write Δ">${r.disk_lastDeltaHtml}</td>
          <td style="padding:7px 6px;text-align:right" data-totaldelta="disk" title="Total disk I/O (Read+Write) over history window">${r.disk_totalDeltaHtml}</td>
          <td class="dh-hist-actions-cell" style="padding:4px 4px;text-align:center;white-space:nowrap">
            <div class="dh-hist-actions">
              <button type="button" class="dh-hist-act dh-hist-act-start" data-name="${r.name}" data-act="start" title="Start" ${r.live ? 'disabled' : ''}>▶</button>
              <button type="button" class="dh-hist-act dh-hist-act-restart" data-name="${r.name}" data-act="restart" title="Restart">↻</button>
              <button type="button" class="dh-hist-act dh-hist-act-stop" data-name="${r.name}" data-act="stop" title="Stop" ${r.live ? '' : 'disabled'}>■</button>
              ${FEATURES.LOG_TAIL ? `<button type="button" class="dh-hist-act dh-hist-act-log" data-name="${r.name}" data-act="logs" title="Logs">📜</button>` : ''}
            </div>
          </td>
          <td style="padding:7px 6px;text-align:center">
            <button class="dh-mini-toggle" data-name="${r.name}" style="background:none;border:none;color:#64748b;cursor:pointer">${open ? '▼' : '▶'}</button>
          </td>
        </tr>`;

      if (open) {
        html += `
          <tr data-mini-for="${r.name}">
            <td colspan="22" style="padding:10px 12px 14px;background:#0b1220">
              <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px">
                ${METRICS_LIST.map(metric => `
                  <div style="display:flex;flex-direction:column">
                    <div style="font-size:11px;color:#64748b;margin-bottom:4px">${METRIC_LABELS[metric]}</div>
                    <div style="height:90px;position:relative;overflow:hidden;background:#1e293b;border-radius:6px">
                      <canvas class="dh-mini-canvas" data-name="${r.name}" data-metric="${metric}" style="width:100%!important;height:100%!important;display:block"></canvas>
                    </div>
                  </div>`).join('')}
              </div>
            </td>
          </tr>`;
      }
    });

    html += '</tbody></table>';
    wrap.innerHTML = html;
    wrap.scrollTop = scrollTop;

    wrap.querySelectorAll('th[data-sort]').forEach(thEl => {
      thEl.onclick = () => {
        const k = thEl.dataset.sort;
        if (sortKey === k) sortDir *= -1;
        else {
          sortKey = k;
          sortDir = k === 'name' ? 1 : -1;
        }
        tableBuilt = false;
        buildTable();
        updateMiniCharts();
      };
    });

    wrap.querySelectorAll('.dh-mini-toggle').forEach(btn => {
      btn.onclick = () => {
        const n = btn.dataset.name;
        if (expanded.has(n)) expanded.delete(n);
        else expanded.add(n);
        tableBuilt = false;
        buildTable();
        updateMiniCharts();
      };
    });

    wrap.querySelectorAll('.dh-hist-act').forEach(btn => {
      btn.onclick = async e => {
        e.preventDefault();
        e.stopPropagation();
        const name = btn.dataset.name;
        const act = btn.dataset.act;
        if (!name || !act) return;

        if (act === 'logs') {
          window.dhShowLogs?.(name, name);
          return;
        }

        if (FEATURES.CAPABILITY_PROBE && window.__dhCapabilities.write === false) {
          showToast('Backend is read-only — action disabled', 'warning', 2200);
          return;
        }

        if (btn.disabled) return;

        const label = act.charAt(0).toUpperCase() + act.slice(1);
        if (FEATURES.CONFIRM_ACTIONS && (act === 'stop' || act === 'restart')) {
          const ok = await window.dhConfirm(
            `${label} container?`,
            `Are you sure you want to <strong>${act}</strong> <strong>${name}</strong>?`,
            { okLabel: label, danger: act === 'stop' }
          );
          if (!ok) return;
        }

        btn.disabled = true;
        const ok = await dhApi(`/containers/${encodeURIComponent(name)}/${act}`, 'POST');
        if (ok) {
          showToast(`${label} · ${name}`, 'success', 1800);
          // Refresh stats / stacks so live flags update
          setTimeout(() => {
            window.dhRefreshStats?.(true);
            tableBuilt = false;
            buildTable();
          }, 800);
        } else {
          showToast(`Failed to ${act} ${name}`, 'error', 2500);
          btn.disabled = false;
        }
      };
    });

    // Row selection checkboxes
    wrap.querySelectorAll('.dh-hist-row-cb').forEach(cb => {
      cb.addEventListener('click', e => e.stopPropagation());
      cb.addEventListener('change', () => {
        const name = cb.dataset.name;
        if (!name) return;
        if (cb.checked) selectedNames.add(name);
        else selectedNames.delete(name);
        const tr = cb.closest('tr');
        if (tr) tr.classList.toggle('dh-hist-row-selected', cb.checked);
        updateBulkBar();
      });
    });

    const thSelect = document.getElementById('dh-hist-th-select-all');
    if (thSelect) {
      thSelect.onclick = e => e.stopPropagation();
      thSelect.onchange = () => setAllVisibleSelected(thSelect.checked);
    }

    updateBulkBar();

    // Hover a table row → emphasize that series on combined charts
    wrap.querySelectorAll('tr[data-name]').forEach(tr => {
      tr.onmouseenter = () => {
        const n = tr.dataset.name;
        if (highlightName === n) return;
        highlightName = n;
        updateCombinedCharts();
      };
      tr.onmouseleave = () => {
        if (highlightName === null) return;
        highlightName = null;
        updateCombinedCharts();
      };
    });

    tableBuilt = true;
    updateMiniCharts();
  }

  function updateMiniCharts() {
    if (!window.Chart) return;
    const wrap = document.getElementById('dh-hist-table-wrap');
    if (!wrap) return;

    wrap.querySelectorAll('.dh-mini-canvas').forEach(canvas => {
      const name = canvas.dataset.name;
      const metric = canvas.dataset.metric;
      const key = `${name}|${metric}`;
      const points = getPoints(name, metric);

      const deltaPoints = points.map((pt, idx) => {
        if (idx === 0) return { x: pt.x, y: 0 };
        const d = pt.y - points[idx - 1].y;
        // Suppress counter-reset spikes on cumulative I/O series
        if (isCumulativeByteMetric(metric) && d < 0 && points[idx - 1].y - pt.y > 1024) {
          return { x: pt.x, y: 0 };
        }
        return { x: pt.x, y: d };
      });

      let chart = miniCharts.get(key);

      if (chart && !chart.canvas.isConnected) {
        destroyChart(chart);
        miniCharts.delete(key);
        chart = null;
      }

      if (chart) {
        chart.data.datasets[0].data = points;
        chart.data.datasets[1].data = deltaPoints;
        if (points.length > 0) {
          const latestTime = points[points.length - 1].x;
          chart.options.scales.x.max = latestTime;
          chart.options.scales.x.min = latestTime - VISIBLE_WINDOW_MS;
        }
        chart.update('none');
      } else {
        const initialMax = points.length > 0 ? points[points.length - 1].x : Date.now();
        const initialMin = initialMax - VISIBLE_WINDOW_MS;

        chart = new Chart(canvas, {
          type: 'line',
          data: {
            datasets: [
              {
                label: 'Value',
                data: points,
                borderColor: '#38bdf8',
                borderWidth: 1.6,
                pointRadius: 0,
                tension: 0.3,
                yAxisID: 'y'
              },
              {
                label: 'Delta',
                data: deltaPoints,
                borderColor: '#f43f5e',
                borderWidth: 1.2,
                borderDash: [3, 3],
                pointRadius: 0,
                tension: 0.1,
                yAxisID: 'yDelta'
              }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  title: (items) => {
                    if (!items.length) return '';
                    return new Date(items[0].parsed.x).toLocaleTimeString([], {
                      hour: '2-digit', minute: '2-digit', second: '2-digit'
                    });
                  },
                  label: (ctx) => {
                    if (ctx.datasetIndex !== 0) return null;
                    const dataIndex = ctx.dataIndex;
                    const valDataset = ctx.chart.data.datasets[0];
                    const deltaDataset = ctx.chart.data.datasets[1];
                    const rawVal = valDataset.data[dataIndex]?.y ?? 0;
                    const rawDelta = deltaDataset.data[dataIndex]?.y ?? 0;
                    const formattedVal = isByteMetric(metric) ? formatBytes(rawVal) : rawVal.toFixed(1);
                    const sign = rawDelta > 0 ? '+' : '';
                    const formattedDelta = isByteMetric(metric)
                      ? sign + formatBytes(rawDelta)
                      : sign + rawDelta.toFixed(1);
                    return `Value: ${formattedVal} (Δ: ${formattedDelta})`;
                  },
                  labelColor: (ctx) => {
                    const dataIndex = ctx.dataIndex;
                    const deltaDataset = ctx.chart.data.datasets[1];
                    const currentDelta = deltaDataset?.data[dataIndex]?.y ?? 0;
                    let markerColor = '#94a3b8';
                    if (currentDelta > 0) markerColor = '#22c55e';
                    else if (currentDelta < 0) markerColor = '#ef4444';
                    return {
                      borderColor: markerColor,
                      backgroundColor: markerColor,
                      borderWidth: 1,
                      borderRadius: 2
                    };
                  }
                }
              }
            },
            scales: {
              x: {
                type: 'linear',
                min: initialMin,
                max: initialMax,
                ticks: {
                  callback: (v) => new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
                  maxTicksLimit: 5,
                  color: '#64748b',
                  font: { size: 10 }
                },
                grid: { display: false }
              },
              y: {
                type: 'linear',
                position: 'left',
                ticks: {
                  maxTicksLimit: 3,
                  font: { size: 9 },
                  color: '#64748b',
                  callback: (value) => isByteMetric(metric) ? formatBytes(value) : value.toFixed(2)
                },
                grid: { color: '#1e293b' }
              },
              yDelta: {
                type: 'linear',
                position: 'right',
                ticks: {
                  maxTicksLimit: 3,
                  font: { size: 8 },
                  color: '#94a3b8',
                  callback: (value) => {
                    const prefix = value > 0 ? '+' : '';
                    return isByteMetric(metric)
                      ? prefix + formatBytes(value)
                      : prefix + value.toFixed(1);
                  }
                },
                grid: { drawOnChartArea: false }
              }
            }
          }
        });
        miniCharts.set(key, chart);
      }
    });
  }

  function updateTableValues() {
    const wrap = document.getElementById('dh-hist-table-wrap');
    if (!wrap || !tableBuilt) {
      buildTable();
      return;
    }

    const keys = getAllKeys();
    const parentRows = wrap.querySelectorAll('tr[data-name]');
    const existingNames = new Set([...parentRows].map(tr => tr.dataset.name));

    // Containers appeared/disappeared → full rebuild
    if (keys.length !== existingNames.size || keys.some(k => !existingNames.has(k))) {
      buildTable();
      return;
    }

    // Live ↔ offline transition → full rebuild (clears stale realtime values)
    for (const tr of parentRows) {
      const wasLive = tr.dataset.live === '1';
      const nowLive = isStatLive(tr.dataset.name);
      if (wasLive !== nowLive) {
        buildTable();
        return;
      }
    }

    const tbody = wrap.querySelector('tbody');
    if (!tbody) return;

    parentRows.forEach(tr => {
      const name = tr.dataset.name;
      const live = isStatLive(name);

      const setVal = (col, val) => {
        const cell = tr.querySelector(`[data-col="${col}"]`);
        if (cell) cell.textContent = val;
      };

      if (!live) {
        // Offline: clear realtime cells, keep row for history expand
        setVal('cpu', '–');
        setVal('mem', '–');
        setVal('memRaw', '–');
        setVal('netRx', '–');
        setVal('netTx', '–');
        setVal('blockRead', '–');
        setVal('blockWrite', '–');
        METRICS_LIST.forEach(m => {
          const deltaCell = tr.querySelector(`[data-delta="${m}"]`);
          if (deltaCell) deltaCell.innerHTML = '<span style="color:#64748b;font-size:10.5px">–</span>';
        });
        for (const kind of ['net', 'disk']) {
          const lastCell = tr.querySelector(`[data-lastdelta="${kind}"]`);
          const totCell = tr.querySelector(`[data-totaldelta="${kind}"]`);
          if (lastCell) lastCell.innerHTML = totalDeltaHtml(null, 'netRx');
          if (totCell) totCell.innerHTML = totalDeltaHtml(null, 'netRx');
        }
        return;
      }

      const l = getLatest(name);
      if (!l) return;

      setVal('cpu', l.cpu != null ? l.cpu.toFixed(1) + '%' : '–');
      setVal('mem', l.mem != null ? (formatMemPctLine(l.mem, l.memRaw, l.memLimit) || '–') : '–');
      setVal('memRaw', l.memRaw != null ? (formatMemRawLine(l.memRaw, l.memLimit) || '–') : '–');
      setVal('netRx', formatBytes(l.netRx ?? 0));
      setVal('netTx', formatBytes(l.netTx ?? 0));
      setVal('blockRead', formatBytes(l.blockRead ?? 0));
      setVal('blockWrite', formatBytes(l.blockWrite ?? 0));

      METRICS_LIST.forEach(m => {
        const valueCell = tr.querySelector(`[data-col="${m}"]`);
        const deltaCell = tr.querySelector(`[data-delta="${m}"]`);
        if (!deltaCell || !valueCell) return;

        const points = getPoints(name, m) || [];
        deltaCell.innerHTML = deltaHtml(points, m).trim();

        if (points.length >= 3) {
          const currentPt = points[points.length - 1].y;
          const previousPt = points[points.length - 2].y;
          if (currentPt !== previousPt) {
            valueCell.classList.remove('dh-flash-up', 'dh-flash-down');
            void valueCell.offsetWidth;
            valueCell.classList.add(currentPt > previousPt ? 'dh-flash-up' : 'dh-flash-down');
          }
        }
      });

      for (const kind of ['net', 'disk']) {
        const lastCell = tr.querySelector(`[data-lastdelta="${kind}"]`);
        const totCell = tr.querySelector(`[data-totaldelta="${kind}"]`);
        if (lastCell) {
          lastCell.innerHTML = totalDeltaHtml(combinedLastDelta(name, kind), 'netRx');
        }
        if (totCell) {
          totCell.innerHTML = totalDeltaHtml(combinedTotalDelta(name, kind), 'netRx');
        }
      }
    });

    // Re-sort: live first, then by current sort key
    const rowsArray = Array.from(parentRows);
    rowsArray.sort((rowA, rowB) => {
      const nameA = rowA.dataset.name;
      const nameB = rowB.dataset.name;
      const liveA = isStatLive(nameA);
      const liveB = isStatLive(nameB);
      if (liveA !== liveB) return liveA ? -1 : 1;

      if (sortKey === 'name') return nameA.localeCompare(nameB) * sortDir;

      const isSortingDelta = sortKey.endsWith('_deltaValue');
      const isSortingTotal = sortKey.endsWith('_totalDelta');
      const isSortingLast = sortKey.endsWith('_lastDelta');
      const metricName = isSortingDelta
        ? sortKey.replace('_deltaValue', '')
        : isSortingTotal
          ? sortKey.replace('_totalDelta', '')
          : isSortingLast
            ? sortKey.replace('_lastDelta', '')
            : sortKey;

      let valA, valB;
      if (isSortingLast) {
        valA = (metricName === 'net' || metricName === 'disk')
          ? combinedLastDelta(nameA, metricName) : 0;
        valB = (metricName === 'net' || metricName === 'disk')
          ? combinedLastDelta(nameB, metricName) : 0;
      } else if (isSortingTotal) {
        // metricName is 'net' or 'disk' for combined columns
        if (metricName === 'net' || metricName === 'disk') {
          valA = combinedTotalDelta(nameA, metricName);
          valB = combinedTotalDelta(nameB, metricName);
        } else {
          valA = totalDeltaValue(nameA, metricName);
          valB = totalDeltaValue(nameB, metricName);
        }
      } else if (isSortingDelta) {
        const pointsA = getPoints(nameA, metricName) || [];
        const pointsB = getPoints(nameB, metricName) || [];
        valA = pointsA.length >= 2 ? pointsA[pointsA.length - 1].y - pointsA[pointsA.length - 2].y : 0;
        valB = pointsB.length >= 2 ? pointsB[pointsB.length - 1].y - pointsB[pointsB.length - 2].y : 0;
        if (isCumulativeByteMetric(metricName)) {
          if (valA < 0 && pointsA.length >= 2 && pointsA[pointsA.length - 2].y - pointsA[pointsA.length - 1].y > 1024) valA = 0;
          if (valB < 0 && pointsB.length >= 2 && pointsB[pointsB.length - 2].y - pointsB[pointsB.length - 1].y > 1024) valB = 0;
        }
      } else if (!liveA) {
        valA = -Infinity;
        valB = -Infinity;
      } else {
        const dataA = getLatest(nameA) || {};
        const dataB = getLatest(nameB) || {};
        valA = dataA[metricName] ?? -Infinity;
        valB = dataB[metricName] ?? -Infinity;
      }
      return (valA - valB) * sortDir;
    });

    rowsArray.forEach(tr => {
      tbody.appendChild(tr);
      const miniChartRow = tbody.querySelector(`tr[data-mini-for="${tr.dataset.name}"]`);
      if (miniChartRow) tbody.appendChild(miniChartRow);
    });

    updateMiniCharts();
  }

  async function renderAll(full = false) {
    if (!panelOpen) return;
    if (!chartJsLoaded) {
      try { await loadChartJs(); }
      catch (e) { console.error('Failed to load Chart.js', e); return; }
    }

    updateCombinedCharts();

    if (full || !tableBuilt) {
      buildTable();
    } else {
      updateTableValues();
    }
  }

  async function setHistoryOpen(open) {
    panelOpen = open;
    panel.classList.toggle('is-open', panelOpen);
    window.dhEnsureStatsPolling?.();
    window.dhMenu?.setActive('history', panelOpen);

    if (panelOpen) {
      window.dhRefreshStats?.(true);
      tableBuilt = false;
      destroyCombinedCharts();
      await renderAll(true);
    } else {
      destroyCombinedCharts();
      miniCharts.forEach(destroyChart);
      miniCharts.clear();
      tableBuilt = false;
      selectedNames.clear();
      updateBulkBar();
    }
  }

  async function toggleHistory() {
    await setHistoryOpen(!panelOpen);
  }

  document.getElementById('dh-hist-close').onclick = () => {
    setHistoryOpen(false);
  };

  // Bulk toolbar (static elements)
  document.getElementById('dh-hist-select-all')?.addEventListener('change', e => {
    setAllVisibleSelected(e.target.checked);
  });
  document.getElementById('dh-hist-bulk-clear')?.addEventListener('click', () => {
    selectedNames.clear();
    setAllVisibleSelected(false);
    updateBulkBar();
  });
  document.querySelectorAll('#dh-hist-bulk [data-bulk]').forEach(btn => {
    btn.addEventListener('click', () => {
      const act = btn.dataset.bulk;
      if (act) runBulkAction(act);
    });
  });

  document.getElementById('dh-hist-refresh').onclick = () => {
    window.dhRefreshStats?.(true);
    setTimeout(() => renderAll(true), 400);
  };

  document.getElementById('dh-hist-combotoggle').onclick = () => {
    const comboContainer = document.getElementById('dh-hist-charts');
    comboGraph = !comboGraph;
    comboContainer.classList.toggle('is-hidden', !comboGraph);
  };

  document.getElementById('dh-hist-totaltoggle').onclick = () => {
    showComboTotal = !showComboTotal;
    updateCombinedCharts();
    showToast(showComboTotal ? 'Total line shown (right axis)' : 'Total line hidden', 'info', 1200);
  };

  if (FEATURES.DELTA_COMBO) {
    document.getElementById('dh-hist-deltatoggle')?.addEventListener('click', () => {
      comboDeltaMode = !comboDeltaMode;
      const btn = document.getElementById('dh-hist-deltatoggle');
      if (btn) btn.classList.toggle('is-active', comboDeltaMode);
      updateCombinedCharts();
      showToast(comboDeltaMode ? 'Combo charts: Δ per interval' : 'Combo charts: absolute', 'info', 1400);
    });
  }

  if (FEATURES.EXPORT_HISTORY) {
    document.getElementById('dh-hist-export')?.addEventListener('click', () => {
      const keys = getAllKeys();
      const rows = [['container', 'timestamp_iso', 'cpu_pct', 'mem_pct', 'mem_raw', 'mem_limit', 'net_rx', 'net_tx', 'block_read', 'block_write', 'pids']];
      for (const name of keys) {
        const arr = window.__dhStatsHistory.get(name) || [];
        for (const e of arr) {
          rows.push([
            name,
            new Date(e.t).toISOString(),
            e.cpu ?? '',
            e.mem ?? '',
            e.memRaw ?? '',
            e.memLimit ?? '',
            e.netRx ?? '',
            e.netTx ?? '',
            e.blockRead ?? '',
            e.blockWrite ?? '',
            e.pids ?? ''
          ]);
        }
      }
      const csv = rows.map(r => r.map(c => {
        const s = String(c);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `container-history-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      showToast(`Exported ${rows.length - 1} history rows`, 'success', 2000);
    });
  }

  window.addEventListener('dh-stats-updated', () => {
    if (!panelOpen) return;
    updateCombinedCharts();
    updateTableValues();
    updateMiniCharts();
  });

  window.dhMenu?.register({
    id: 'history',
    icon: '📈',
    label: 'History & charts',
    order: 30,
    type: 'toggle',
    closeOnClick: true,
    getActive: () => panelOpen,
    onClick: toggleHistory
  });
})();

/* ====================== Capability probe (read-only detection) ====================== */
(function () {
  if (!FEATURES.CAPABILITY_PROBE) return;

  async function probe() {
    try {
      // List is always allowed; try a harmless HEAD-like GET first to confirm connectivity
      const list = await dhApi('/containers', 'GET', { all: 'false' });
      if (!list) {
        window.__dhCapabilities = { write: null, probed: true };
        window.dispatchEvent(new CustomEvent('dh-capabilities'));
        return;
      }

      // Infer read-only: attempt POST start on a non-existent id — 404 = write path works, 403/405 = blocked
      // Avoid starting real containers: use an impossible name.
      if (IS_DOCKER) {
        const url = dockerPath(`/containers/dh-probe-readonly-check-$$/start`);
        try {
          const res = await fetch(url, {
            method: 'POST',
            credentials: 'omit',
            headers: apiHeaders()
          });
          // 404 = container missing but POST accepted by proxy → write enabled
          // 403/401/405/500 with permission → read-only
          if (res.status === 404 || res.status === 304) {
            window.__dhCapabilities = { write: true, probed: true };
          } else if (res.status === 403 || res.status === 401 || res.status === 405) {
            window.__dhCapabilities = { write: false, probed: true };
          } else if (res.status >= 200 && res.status < 300) {
            window.__dhCapabilities = { write: true, probed: true };
          } else {
            // Ambiguous (e.g. 500) — leave null, learn from real actions
            window.__dhCapabilities = { write: null, probed: true };
          }
        } catch (_) {
          window.__dhCapabilities = { write: null, probed: true };
        }
      } else {
        // Dockhand: assume write unless proven otherwise
        window.__dhCapabilities = { write: true, probed: true };
      }
    } catch (_) {
      window.__dhCapabilities = { write: null, probed: true };
    }
    window.dispatchEvent(new CustomEvent('dh-capabilities'));
    window.dhMenu?.render?.();
  }

  setTimeout(probe, 2500);
})();

/* ====================== Threshold alerts ====================== */
(function () {
  if (!FEATURES.ALERTS) return;

  window.__dhCheckAlerts = function (list) {
    const cfg = ALERTS_CONFIG;
    const now = Date.now();
    for (const s of list) {
      if (!s) continue;
      const name = normalize(s.name) || (s.id || '').toString().slice(0, 12);
      if (!name) continue;

      const checks = [
        { key: 'cpu', val: s.cpuPercent, limit: cfg.CPU_PCT, label: 'CPU' },
        { key: 'mem', val: s.memoryPercent, limit: cfg.MEM_PCT, label: 'MEM' }
      ];

      for (const c of checks) {
        if (c.val == null || !isFinite(c.val)) continue;
        const streakKey = `${name}:${c.key}`;
        if (c.val >= c.limit) {
          const streak = (window.__dhAlertStreak.get(streakKey) || 0) + 1;
          window.__dhAlertStreak.set(streakKey, streak);
          if (streak >= cfg.STREAK) {
            const last = window.__dhAlertCooldown.get(streakKey) || 0;
            if (now - last >= cfg.COOLDOWN_MS) {
              window.__dhAlertCooldown.set(streakKey, now);
              showToast(
                `${c.label} high on ${name}: ${Number(c.val).toFixed(1)}% (≥${c.limit}%)`,
                'warning',
                4000
              );
            }
          }
        } else {
          window.__dhAlertStreak.set(streakKey, 0);
        }
      }
    }
  };
})();

/* ====================== Backend mode switch (with confirm) ====================== */
(function () {
  if (!FEATURES.BACKEND_SWITCH) return;

  window.dhMenu?.register({
    id: 'backend-switch',
    icon: '🔀',
    label: `Switch to ${BACKEND.MODE === 'docker' ? 'Dockhand' : 'Docker'}`,
    order: 90,
    type: 'action',
    closeOnClick: true,
    dividerAfter: false,
    onClick: async () => {
      const next = BACKEND.MODE === 'docker' ? 'dockhand' : 'docker';
      const ok = await window.dhConfirm(
        'Switch backend?',
        `Switch from <strong>${BACKEND.MODE}</strong> to <strong>${next}</strong>?
         <div class="dh-confirm-meta">The page will reload. Card stats, history buffer, and open panels will reset.</div>`,
        { okLabel: 'Switch & reload', cancelLabel: 'Cancel' }
      );
      if (!ok) {
        showToast('Backend switch cancelled', 'info', 1200);
        return;
      }
      try {
        localStorage.setItem(BACKEND_MODE_KEY, next);
      } catch (_) {}
      showToast(`Switching to ${next}…`, 'info', 1200);
      setTimeout(() => location.reload(), 400);
    }
  });
})();

/* ====================== Health cache refresh from container list ====================== */
(function () {
  if (!FEATURES.HEALTH_BADGES) return;

  async function refreshHealth() {
    try {
      const list = await dhApi('/containers', 'GET', { all: 'true' });
      let arr = Array.isArray(list) ? list : list?.containers;
      if (!Array.isArray(arr)) return;
      for (const c of arr) {
        const name = normalize(c.name || c.Name || (c.Names && c.Names[0]) || '');
        if (!name) continue;
        const status = c.status || c.Status || '';
        const health = c.health || parseHealthFromStatus(status);
        const restartCount = c.restartCount ?? c.RestartCount ?? null;
        if (health || restartCount != null) {
          const prev = window.__dhHealthCache.get(name) || {};
          window.__dhHealthCache.set(name, {
            health: health ?? prev.health ?? null,
            restartCount: restartCount ?? prev.restartCount ?? null
          });
        }
      }
      window.dispatchEvent(new CustomEvent('dh-stats-updated'));
    } catch (_) {}
  }

  setTimeout(refreshHealth, 3000);
  setInterval(refreshHealth, Math.max(30000, STATS_REFRESH_MS * 3));
})();

/* ====================== Log tail viewer ====================== */
(function () {
  if (!FEATURES.LOG_TAIL) return;

  function decodeDockerLogStream(arrayBuffer) {
    // Docker multiplexed stream: 8-byte header (stream,0,0,0,size) + payload
    const bytes = new Uint8Array(arrayBuffer);
    // Heuristic: if mostly printable, treat as plain text
    let printable = 0;
    const sample = Math.min(bytes.length, 200);
    for (let i = 0; i < sample; i++) {
      const b = bytes[i];
      if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127)) printable++;
    }
    if (sample && printable / sample > 0.85) {
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    }

    const parts = [];
    let offset = 0;
    const view = new DataView(arrayBuffer);
    while (offset + 8 <= bytes.length) {
      const size = view.getUint32(offset + 4, false);
      offset += 8;
      if (size <= 0 || offset + size > bytes.length) break;
      parts.push(new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(offset, offset + size)));
      offset += size;
    }
    return parts.length ? parts.join('') : new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }

  async function fetchLogs(idOrName) {
    if (IS_DOCKER) {
      const q = `stdout=1&stderr=1&timestamps=1&tail=${LOG_TAIL_LINES}`;
      const url = dockerPath(`/containers/${encodeURIComponent(idOrName)}/logs?${q}`);
      const opts = { method: 'GET', credentials: 'omit', headers: { ...apiHeaders() } };
      // logs are not JSON
      delete opts.headers['Content-Type'];
      const res = await fetch(url, opts);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      return decodeDockerLogStream(buf);
    }
    // Dockhand: best-effort
    const data = await dhApi(`/containers/${encodeURIComponent(idOrName)}/logs`, 'GET', { tail: LOG_TAIL_LINES });
    if (typeof data === 'string') return data;
    if (data?.logs) return String(data.logs);
    if (Array.isArray(data)) return data.join('\n');
    return data ? JSON.stringify(data, null, 2) : '(no logs)';
  }

  window.dhShowLogs = async function (idOrName, displayName) {
    const existing = document.getElementById('dh-log-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'dh-log-overlay';
    overlay.innerHTML = `
      <div class="dh-log-panel" role="dialog" aria-modal="true">
        <div class="dh-log-header">
          <span>📜 Logs · ${displayName || idOrName} <small>(last ${LOG_TAIL_LINES})</small></span>
          <div class="dh-log-header-actions">
            <button type="button" id="dh-log-refresh" title="Refresh">↻</button>
            <button type="button" id="dh-log-close" title="Close">×</button>
          </div>
        </div>
        <pre class="dh-log-body" id="dh-log-body">Loading…</pre>
      </div>`;
    document.body.appendChild(overlay);

    const body = document.getElementById('dh-log-body');
    const load = async () => {
      body.textContent = 'Loading…';
      try {
        const text = await fetchLogs(idOrName);
        body.textContent = (text && String(text).trim()) || '(empty)';
        body.scrollTop = body.scrollHeight;
      } catch (err) {
        body.textContent = `Failed to load logs: ${err?.message || err}`;
      }
    };

    document.getElementById('dh-log-close').onclick = () => overlay.remove();
    document.getElementById('dh-log-refresh').onclick = () => load();
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    document.addEventListener('keydown', function onEsc(e) {
      if (e.key === 'Escape') {
        overlay.remove();
        document.removeEventListener('keydown', onEsc);
      }
    });
    load();
  };
})();

/* ====================== Prune unused Docker resources ====================== */
(function () {
  if (!FEATURES.PRUNE || !IS_DOCKER) return;

  async function pruneEndpoint(path, label) {
    const res = await rawFetch(dockerPath(path), 'POST', {});
    return { label, res };
  }

  window.dhMenu?.register({
    id: 'prune',
    icon: '🧹',
    label: 'Prune unused',
    order: 85,
    type: 'action',
    closeOnClick: true,
    onClick: async () => {
      if (FEATURES.CAPABILITY_PROBE && window.__dhCapabilities.write === false) {
        showToast('Backend is read-only — prune disabled', 'warning', 2500);
        return;
      }
      const ok = await window.dhConfirm(
        'Prune unused resources?',
        `This will remove <strong>stopped containers</strong> and <strong>dangling images</strong>.
         <div class="dh-confirm-meta">Volumes and non-dangling images are not touched.</div>`,
        { okLabel: 'Prune', danger: true }
      );
      if (!ok) return;

      showToast('Pruning…', 'info', 1500);
      try {
        const results = [];
        // containers/prune
        const c = await rawFetch(dockerPath('/containers/prune'), 'POST', {});
        if (c && typeof c === 'object') {
          const n = (c.ContainersDeleted || c.containers_deleted || []).length;
          const space = c.SpaceReclaimed ?? c.space_reclaimed ?? 0;
          results.push(`containers: ${n} removed, ${formatBytes(space)} reclaimed`);
        } else {
          results.push('containers: done');
        }
        // images/prune dangling only
        const img = await rawFetch(dockerPath('/images/prune?filters=' + encodeURIComponent('{"dangling":["true"]}')), 'POST', {});
        if (img && typeof img === 'object') {
          const n = (img.ImagesDeleted || img.images_deleted || []).length;
          const space = img.SpaceReclaimed ?? img.space_reclaimed ?? 0;
          results.push(`dangling images: ${n} entries, ${formatBytes(space)} reclaimed`);
        } else {
          results.push('images: done');
        }
        showToast(results.join(' · '), 'success', 4500);
        window.dhRefreshStats?.(true);
      } catch (err) {
        showToast('Prune failed: ' + (err?.message || err), 'error', 3000);
      }
    }
  });
})();

/* ====================== State-change events (die / restart toasts) + restart-loop detection ====================== */
(function () {
  if (!FEATURES.STATE_EVENTS && !FEATURES.RESTART_LOOP_ALERTS) return;

  const prevState = new Map(); // name -> state

  /** Record a restart-count jump for `name`, drop anything outside the window, and
   *  toast + flag the card once the total within WINDOW_MS reaches THRESHOLD. */
  function trackRestartLoop(name, restartCount, now) {
    const prevCount = window.__dhRestartCountPrev.get(name);
    window.__dhRestartCountPrev.set(name, restartCount);

    if (prevCount == null) return; // first sighting — no baseline to diff against yet
    const delta = restartCount - prevCount;

    if (delta < 0) {
      // Counter went backwards: container was recreated. Old restarts no longer apply.
      window.__dhRestartEvents.delete(name);
      setRestartLooping(name, false);
      return;
    }
    if (delta > 0) {
      let events = window.__dhRestartEvents.get(name);
      if (!events) { events = []; window.__dhRestartEvents.set(name, events); }
      events.push({ t: now, n: delta });
    }
    evaluateRestartLoop(name, now, delta > 0);
  }

  function evaluateRestartLoop(name, now, hadNewRestart) {
    const events = window.__dhRestartEvents.get(name);
    if (!events || !events.length) { setRestartLooping(name, false); return; }

    while (events.length && now - events[0].t > RESTART_LOOP_CONFIG.WINDOW_MS) events.shift();
    if (!events.length) {
      window.__dhRestartEvents.delete(name);
      setRestartLooping(name, false);
      return;
    }

    const total = events.reduce((sum, e) => sum + e.n, 0);
    const looping = total >= RESTART_LOOP_CONFIG.THRESHOLD;
    setRestartLooping(name, looping, total);

    if (looping && hadNewRestart) {
      const last = window.__dhRestartLoopCooldown.get(name) || 0;
      if (now - last >= RESTART_LOOP_CONFIG.COOLDOWN_MS) {
        window.__dhRestartLoopCooldown.set(name, now);
        const mins = Math.round(RESTART_LOOP_CONFIG.WINDOW_MS / 60000);
        showToast(`🔁 ${name} is crash-looping — ${total} restarts in ${mins} min`, 'error', 6000);
      }
    }
  }

  function setRestartLooping(name, looping, total) {
    const wasLooping = window.__dhRestartLoopSet.has(name);
    if (looping) {
      window.__dhRestartLoopSet.set(name, { count: total, windowMin: Math.round(RESTART_LOOP_CONFIG.WINDOW_MS / 60000) });
    } else if (wasLooping) {
      window.__dhRestartLoopSet.delete(name);
    } else {
      return; // no state change — skip the re-render dispatch
    }
    window.dispatchEvent(new CustomEvent('dh-stats-updated'));
  }

  async function pollStates() {
    try {
      const list = await dhApi('/containers', 'GET', { all: 'true' });
      const arr = Array.isArray(list) ? list : list?.containers;
      if (!Array.isArray(arr)) return;
      const now = Date.now();

      for (const c of arr) {
        const name = normalize(c.name || c.Name || (c.Names && c.Names[0]) || '');
        if (!name) continue;

        if (FEATURES.RESTART_LOOP_ALERTS) {
          const restartCount = c.restartCount ?? c.RestartCount ?? null;
          if (restartCount != null) trackRestartLoop(name, restartCount, now);
        }

        if (!FEATURES.STATE_EVENTS) continue;

        const state = String(c.state || c.State || '').toLowerCase();
        const prev = prevState.get(name);
        prevState.set(name, state);

        if (prev == null) continue; // first snapshot — no toast
        if (prev === state) continue;

        // Only notify for containers we care about (homepage / interest), if known
        const interest = window.__dhStatsInterest;
        if (interest && interest.size && !interest.has(name)) continue;

        if ((prev === 'running' || prev === 'up') && (state.includes('exit') || state === 'dead')) {
          showToast(`${name} stopped (${state})`, 'warning', 3500);
        } else if ((prev.includes('exit') || prev === 'dead' || prev === 'created') && state === 'running') {
          showToast(`${name} started`, 'success', 2500);
        } else if (state === 'restarting') {
          showToast(`${name} is restarting`, 'warning', 3000);
        }
      }
    } catch (_) {}
  }

  setTimeout(pollStates, 4000);
  setInterval(pollStates, Math.max(15000, STATS_REFRESH_MS * 2));
})();
