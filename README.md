# Homepage Custom.js Enhancements for gethomepage.dev

Custom JavaScript + CSS enhancements for [gethomepage.dev](https://gethomepage.dev) designed for self-hosted HomeLab environments that are **not** exposed to the internet.

These scripts add dual-backend container control (Dockhand **or** Docker Engine API), live CPU/memory/network/disk stats on service cards, a full history & charts panel, stack management (including fake/custom stacks), invalid network-mode detection, restart-loop alerts, threshold toasts, log tailing, and mobile long-press protection — all without modifying the core Homepage application.

> **Important**: This is intended for private/local networks only. Do not expose the Dockhand API, Docker socket proxy, or these controls to the public internet without proper authentication and network isolation.

> I created this for my own use and share here because I've had so much fun and learnt so much from the selfhosting community in the last 7 months. Also my ideas, AI aided coding/optimization, human fixed.

---

## Features

### 1. Dual Backend: Dockhand **or** Docker Engine
- Switch between **Dockhand** REST API and raw **Docker Engine API** (via HTTP proxy such as `tecnativa/docker-socket-proxy` or socat).
- Runtime toggle from the floating menu (reloads the page); preference is stored in `localStorage`.
- Docker mode builds “stacks” from Compose project labels (`com.docker.compose.project`).
- Capability probe detects read-only proxies and automatically hides write controls (start/stop/restart/prune).

### 2. Visual Status Icons & Card Styling (CSS-driven)
- Automatically show icons on service cards based on Homepage labels:
  - **Ondemand** containers (e.g. Sablier-managed)
  - **VPN** containers
  - **VPN-UK** containers (UK-routed VPN)
- Fade / dim service cards when the underlying container is not running (lighter dim for ondemand)
- Fully controlled via CSS using the `homepage.id` label

### 3. Long-Press Protection (Mobile)
- Prevents accidental taps that open services while scrolling on mobile
- Hold the card for a configurable duration (default 1000 ms)
- Visual progress ring + “Hold to open…” feedback
- Can be disabled by setting `HOLD_DURATION = 0`

### 4. Unified Floating Menu (FAB)
- Single floating button (bottom-right) opens a compact menu of all tools
- Menu items register themselves; order and active state are managed centrally
- Stale-stats indicator: FAB turns amber when stats have not refreshed recently

### 5. Per-Container Docker Controls
- Toggle **Container controls** from the menu to show Start / Restart / Stop buttons on every mapped service card
- Buttons appear only for containers whose Homepage `id` can be mapped to a real container name
- Confirmation dialogs (optional) and success / failure toasts
- Hidden automatically when the backend is detected as read-only

### 6. Stacks Panel (Dockhand or Compose)
- Open **Compose stacks** / **Dockhand stacks** from the menu
- Per-stack Start / Restart / Stop (with confirmation + batch progress dialog)
- Expandable container list per stack with live stats, uptime/exit info, and log button
- Optional **Compose project restart** action (Docker mode)
- Search / filter box for stacks and containers
- Pin favourite stacks to the top (persisted in `localStorage`)
- Colored status indicators:
  - 🟩 Running
  - 🟥 Stopped
  - 🟨 Partial
  - 🟦 Created
  - 👻 Fake stack
- Live polling while the panel (or expanded stacks) is open

### 7. Fake / Custom Stacks
- Create arbitrary groups of containers (e.g. “Downloaders”, “MediaStack”, “QuickStart”)
- Defined entirely via Docker labels — no Dockhand configuration required
- A container can belong to multiple fake stacks
- Appear in the Stacks panel with the 👻 icon

### 8. Card Stats (CPU / Memory / Network / Disk)
- Toggle **Card stats** from the menu to overlay live resource usage on service cards
- Layouts: `single`, `stacked`, or `single-nograph` (configurable)
- Optional hide of host-wide memory limit (when no explicit `mem_limit` is set)
- Visibility preference can be remembered in `localStorage`
- Stats are fetched selectively (homepage cards + expanded stacks) to reduce load

### 9. History & Charts Panel
- Full-screen panel with:
  - Combo charts (CPU, memory, network, disk) — absolute or Δ-per-interval mode
  - Per-container mini charts
  - Sortable table of latest values + deltas
  - Bulk select + Start / Restart / Stop
  - Per-row Start / Restart / Stop / Logs actions
  - CSV export of the history buffer
- Rolling window (default 20 minutes) with configurable max points

### 10. Invalid Network Mode Detection
- Detects containers using `network_mode: container:<name-or-id>` where the target container no longer exists
- Highlights affected service cards with a red border and warning badge
- Also flags the containers inside the Stacks panel
- Optional toast notification on first detection
- Configurable re-check interval
- Manual trigger: `dhCheckInvalidNetMode()` from the browser console

### 11. Health Badges & Restart-Loop Alerts
- Optional health badges on cards (healthy / unhealthy / starting)
- Restart-loop detection: rolling window of restart-count jumps → persistent card badge + error toast
- State-change toasts when tracked containers start, stop, or enter restarting

### 12. Threshold Alerts
- Toast when container CPU or memory stays above configurable thresholds for N consecutive polls
- Per-metric cooldown to avoid spam

### 13. Log Tail Viewer
- View last N lines of container logs from expanded stack rows or the history table
- Works with Docker multiplexed log streams and Dockhand (best-effort)

### 14. Prune (Docker mode, optional)
- Menu action to prune stopped containers and dangling images
- Confirmation required; respects read-only capability probe

### 15. Toast Notifications & Themed Dialogs
- Clean, non-intrusive toast system used by all features
- Shared confirm dialog and batch-progress dialog for multi-container actions

---

## Requirements

- [gethomepage.dev](https://gethomepage.dev) (recent version)
- **Either**:
  - [Dockhand](https://github.com/onlyoffice/dockhand) (or compatible API), **or**
  - Docker Engine API over HTTP (e.g. [tecnativa/docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy), socat, or any reverse proxy that exposes the socket)
- Docker labels on your containers (see configuration below)
- Optional: reverse proxy (Traefik recommended) with CORS middleware for the chosen backend
- Optional: Chart.js is loaded on demand for the History panel (no local install needed)

---

## Installation

1. Place `custom.js` and `custom.css` in your Homepage configuration directory (usually next to `settings.yaml`).

2. Mount an icons folder so Homepage can serve the custom icons:

```yaml
# docker-compose.yml (Homepage service)
volumes:
  - ./homepage/config:/app/config
  - ./homepage/icons:/app/public/icons   # or wherever you keep the icons
```

3. Restart Homepage.

---

## Configuration

All configuration lives at the top of `custom.js`.

### Core toggles

```js
const DEBUG = false;

/* Long press on mobile */
const HOLD_DURATION = 1000; // ms – set to 0 to disable

/* Network check */
const INVALID_NETWORK_CHECK = true;
const INVALID_NETWORK_NOTIFICATION = false;
const CHECK_INTERVAL = 0;          // recheck interval in ms (0 = once only)
const CONCURRENCY = 5;

/* Stats polling */
const STATS_REFRESH_MS = 12000;

/* Card stats */
const CARD_STATS_LAYOUT = 'single-nograph'; // 'single' | 'stacked' | 'single-nograph'
const SHOW_CPU_ON_CARDS = true;
const SHOW_MEMORY_ON_CARDS = true;
const CARD_STATS_DEFAULT_VISIBLE = false;
const HIDE_HOST_MEM_LIMIT = true;
```

### Feature flags

```js
const FEATURES = {
  CAPABILITY_PROBE: true,          // detect read-only proxy; hide write controls
  SELECTIVE_STATS: true,           // only /stats for homepage cards + expanded stacks
  HEALTH_BADGES: false,            // healthy / unhealthy / restart count on cards
  STACKS_FILTER: true,             // search box in stacks panel
  PIN_FAVORITES: true,             // pin stacks to top (localStorage)
  ALERTS: true,                    // threshold toasts
  EXPORT_HISTORY: true,            // CSV download from history panel
  BACKEND_SWITCH: true,            // menu toggle Dockhand ↔ Docker (reloads)
  COMPOSE_PROJECT_ACTIONS: true,   // explicit "restart project" on compose stacks
  STALE_INDICATOR: true,           // dim FAB when stats are stale
  CONFIRM_ACTIONS: true,           // themed confirm before stack/backend actions
  LOG_TAIL: true,                  // last N log lines from expanded stack rows
  UPTIME: true,                    // show uptime / exit info on nested rows
  PRUNE: false,                    // prune unused containers/images (menu)
  DELTA_COMBO: true,               // history combo charts: absolute ↔ delta mode
  STATE_EVENTS: true,              // toast when a tracked container dies / restarts
  RESTART_LOOP_ALERTS: true,       // toast + persistent card badge when a container crash-loops
  PERSIST_CARD_STATS: true         // remember card-stats toggle in localStorage
};
```

### Alert & restart-loop thresholds

```js
const ALERTS_CONFIG = {
  CPU_PCT: 90,
  MEM_PCT: 90,
  STREAK: 2,
  COOLDOWN_MS: 5 * 60 * 1000
};

const RESTART_LOOP_CONFIG = {
  WINDOW_MS: 5 * 60 * 1000,
  THRESHOLD: 3,
  COOLDOWN_MS: 10 * 60 * 1000
};
```

### Backend configuration

```js
const BACKEND = {
  MODE: 'docker', // 'dockhand' | 'docker'  (overridden by localStorage if set)

  DOCKHAND: {
    EXT_URL: 'http://dockhand.example.com',
    BASE_URL: 'http://dockhand.example.com/api',
    TOKEN: 'REPLACE_WITH_DOCKHAND_TOKEN',
    ENV: '1',
    POLL_INTERVAL: 8000,
    HIDE_BUTTONS: ['dockhand'],
    HIDE_STACKS: []
  },

  DOCKER: {
    BASE_URL: 'http://docker.example.com',  // HTTP Docker Engine endpoint
    // TOKEN: null,                         // optional Bearer
    USERNAME: '',
    PASSWORD: '',
    API_VERSION: '',                        // e.g. 'v1.44' or leave empty
    POLL_INTERVAL: 8000,
    HIDE_BUTTONS: [],
    HIDE_STACKS: [],
    COMPOSE_PROJECT_LABEL: 'com.docker.compose.project',
    COMPOSE_SERVICE_LABEL: 'com.docker.compose.service'
  }
};
```

Docker-mode performance knobs (near the top of the file):

```js
const DOCKER_STATS_CONCURRENCY = 12;
const DOCKER_LIST_CACHE_MS = 2500;
const DOCKER_INSPECT_CACHE_MS = 60000;
const DOCKER_STATS_ONE_SHOT = false;  // false = better disk I/O samples
```

### Homepage Settings Recommendation

```yaml
# settings.yaml
statusStyle: "dot"
```

### Docker Labels

#### Service Card Icons & Identification

```yaml
labels:
  - homepage.id=mycontainer-ondemand-vpn      # or -vpnuk, -ondemand, etc.
  - homepage.name=My Service
  - homepage.group=Media
  - homepage.icon=...
```

The first part of the `id` (before suffixes like `-vpn` / `-ondemand`) is used as the container name for API commands.

Supported suffixes:
- `-ondemand` → ondemand icon
- `-vpn` → generic VPN icon
- `-vpnuk` → UK VPN icon

You can extend the CSS rules for additional suffixes.

#### Fake Stacks

```yaml
labels:
  - fakeStack.Downloaders=true
  - fakeStack.MediaStack=true
  - fakeStack.QuickStart=true
```

- The part after `fakeStack.` becomes the stack name
- One container can be a member of many fake stacks
- Fake stacks appear automatically in the Stacks panel

---

## Traefik CORS Example (if using reverse proxy)

```yaml
# fileConfig.yml or dynamic config
middlewares:
  dockhand-cors:
    headers:
      accessControlAllowOriginList:
        - "http://homepage.example.com"   # your Homepage URL
      accessControlAllowMethods:
        - "GET"
        - "POST"
        - "PUT"
        - "DELETE"
        - "OPTIONS"
      accessControlAllowHeaders:
        - "Content-Type"
        - "Authorization"
        - "X-Requested-With"
      accessControlAllowCredentials: true
      accessControlMaxAge: 1728000
```

Apply the middleware to your Dockhand **or** Docker-proxy router.

For Docker socket proxy, also restrict which API endpoints the proxy exposes (prefer read-only + only the verbs you need).

---

## custom.css notes

Icons, dimming, long-press overlay, FAB/menu, stacks panel, card stats bars, invalid-netmode highlight, health/restart-loop badges, history panel, confirm/batch/log dialogs, and toast styles all live in `custom.css`. Key examples:

```css
/* VPN / ondemand icons */
[id*="-ondemand"]::before {
  background-image: url('/icons/ondemand.png');
}
[id*="-vpnuk"]::after {
  background-image: url('/icons/uk shield.png');
}
[id*="-vpn"]:not([id*="-vpnuk"])::after {
  background-image: url('/icons/vpn.png');
}

/* Fade non-running containers (non-ondemand) */
.service:not([id*="ondemand"]) .service-card:has(
  .docker-status:not([title*="Healthy"]):not([title*="Running"]):not([title*="Starting"])
) {
  opacity: 0.35;
  pointer-events: none;
}
```

---

## Usage

| Action | How |
|--------|-----|
| Open tools menu | Click the floating FAB (bottom-right) |
| Toggle per-card Start/Restart/Stop | Menu → **Container controls** |
| Open Stacks panel | Menu → **Compose stacks** / **Dockhand stacks** |
| Expand a stack | Click the expand control on a stack card |
| Start / Stop / Restart stack | Buttons on the stack card (confirmation when enabled) |
| Pin a stack | 📌 button on the stack row |
| Filter stacks | Search box at the top of the stacks panel |
| Toggle card CPU/mem/net/disk | Menu → **Card stats** |
| History, charts, bulk actions, CSV | Menu → **History & charts** |
| View container logs | 📜 on an expanded stack row or history row |
| Switch Dockhand ↔ Docker | Menu → **Switch to …** (reloads) |
| Prune unused (Docker, if enabled) | Menu → **Prune unused** |
| Force network-mode check | Console → `dhCheckInvalidNetMode()` |
| Disable long-press | Set `HOLD_DURATION = 0` |

---

## Troubleshooting

- **Buttons / stacks not appearing**  
  Check the browser console for API errors. Verify `BASE_URL`, token/auth, and CORS. Confirm the capability probe is not treating the backend as read-only.

- **Container name not detected**  
  Ensure `homepage.id` starts with the real container name (e.g. `myapp-ondemand-vpn`). Suffixes `-vpn`, `-vpnuk`, `-ondemand` are stripped automatically.

- **Fake stacks missing**  
  Labels must be present on the containers and the backend must return them (Dockhand `/stacks` or Docker list with labels). Wait a few seconds after page load.

- **Network highlights not showing**  
  Confirm `INVALID_NETWORK_CHECK = true` and that the backend can inspect containers.

- **Icons not loading**  
  Verify the icons are served under `/icons/` and the volume mount is correct.

- **Stats empty or stale**  
  Open Card stats, Stacks, or History so polling is active. Check `STATS_REFRESH_MS` and Docker proxy permissions for `/containers/json` and `/containers/.../stats`.

- **Disk I/O looks wrong in Docker mode**  
  Prefer `DOCKER_STATS_ONE_SHOT = false` so the daemon can sample properly (especially on cgroup v2).

- **Write actions fail**  
  Capability probe may have marked the backend read-only. Ensure the proxy allows POST to start/stop/restart (and prune if you use it).

---

## Security Notes

- These controls can start, stop, and restart containers (and optionally prune resources).
- Keep Homepage and the Docker/Dockhand endpoint on a private network or behind strong authentication.
- Prefer a least-privilege Docker socket proxy over raw socket exposure.
- Never commit real tokens or credentials to a public repository.
- Restrict CORS origins to your Homepage URL only.

---

## Credits

Created for a personal HomeLab using Homepage + Dockhand / Docker Engine + Sablier + Traefik.  
Feel free to adapt, extend, or improve.

---

## License

MIT License

Copyright (c) 2026 planet22

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
