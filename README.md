# Homepage Custom.js Enhancements for gethomepage.dev

Custom JavaScript enhancements for [gethomepage.dev](https://gethomepage.dev) designed for self-hosted HomeLab environments that are **not** exposed to the internet.

These scripts add container status icons, mobile long-press protection, Dockhand-powered start/stop/restart controls, stack management (including fake/custom stacks), and invalid network-mode detection — all without modifying the core Homepage application.

> **Important**: This is intended for private/local networks only. Do not expose the Dockhand API or these controls to the public internet without proper authentication and network isolation.

---

## Features

### 1. Visual Status Icons & Card Styling (CSS-driven)
- Automatically show icons on service cards based on Homepage labels:
  - **Ondemand** containers (e.g. Sablier-managed)
  - **VPN** containers
  - **VPN-UK** containers (UK-routed VPN)
- Fade / dim service cards when the underlying container is not running
- Fully controlled via CSS using the `homepage.id` label

### 2. Long-Press Protection (Mobile)
- Prevents accidental taps that open services while scrolling on mobile
- Hold the card for a configurable duration (default 1000 ms)
- Visual progress ring + “Hold to open…” feedback
- Can be disabled by setting `HOLD_DURATION = 0`

### 3. Per-Container Docker Controls (requires Dockhand)
- Floating ⚙️ button toggles Start / Restart / Stop buttons on every service card
- Buttons appear only for containers whose Homepage `id` can be mapped to a real container name
- Confirmation toasts for success / failure

### 4. Dockhand Stacks Panel
- Floating 🐳 button opens a side panel listing all stacks
- Per-stack Start / Restart / Stop (with confirmation dialog)
- Expandable container list per stack
- Shows update availability and count
- Colored status indicators:
  - 🟩 Running
  - 🟥 Stopped
  - 🟨 Partial
  - 🟦 Created
  - 👻 Fake stack
- Live polling of expanded stacks

### 5. Fake / Custom Stacks
- Create arbitrary groups of containers (e.g. “Downloaders”, “MediaStack”, “QuickStart”)
- Defined entirely via Docker labels — no Dockhand configuration required
- A container can belong to multiple fake stacks
- Appear in the Stacks panel with the 👻 icon

### 6. Invalid Network Mode Detection
- Detects containers using `network_mode: container:<name-or-id>` where the target container no longer exists
- Highlights affected service cards with a red border and warning badge
- Also flags the containers inside the Stacks panel
- Optional toast notification on first detection
- Configurable re-check interval

### 7. Toast Notifications
- Clean, non-intrusive toast system used by all features

---

## Requirements

- [gethomepage.dev](https://gethomepage.dev) (recent version)
- [Dockhand](https://github.com/onlyoffice/dockhand) (or compatible API) for container/stack control features
- Docker labels on your containers (see configuration below)
- Optional: reverse proxy (Traefik recommended) with CORS middleware for Dockhand API

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

All configuration lives at the top of `custom.js`:

```js
const DEBUG = false;

/* Long press on mobile */
const HOLD_DURATION = 1000; // ms – set to 0 to disable

/* Network check */
const INVALID_NETWORK_CHECK = true;   // Enable network validation
const INVALID_NETWORK_NOTIFICATION = false; // Notification on page refresh using popup
const CHECK_INTERVAL = 0;          // recheck interval in ms (0 = disabled)
const CONCURRENCY = 5;             // parallel inspect requests

/* Shared Dockhand Config */
const DH = {
  BASE_URL: 'http://dockhand.example.com/api',  // ← change this
  TOKEN: 'REPLACE_WITH_DOCKHAND_TOKEN',         // ← change this
  ENV: '1',                                     // ← change this to your enviroment id in dockhand
  POLL_INTERVAL: 5000,                          // stack poll rate
  HIDE_BUTTONS: ['dockhand'],                   // stacks that should not show action buttons
  HIDE_STACKS: []                               // stacks to hide completely from the panel
};
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

The first part of the `id` (before the first `-`) is used as the container name for Dockhand commands.

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
- Fake stacks appear automatically in the Dockhand Stacks panel

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

Apply the middleware to your Dockhand router.

---

## custom.css where you can see icons mapped etc.

```css
/* VPN icons */
[id*="-vpnuk"]::after {
  content: "";
  background-image: url('/icons/uk-shield.png');
  /* size, position, etc. */
}

[id*="-vpn"]:not([id*="-vpnuk"])::after {
  content: "";
  background-image: url('/icons/vpn.png');
}

/* Fade non-running containers (example – adjust selector to your status style) */
.service-card:not([data-status="running"]) {
  opacity: 0.55;
  filter: grayscale(0.4);
}
```

---

## Usage

| Action                        | How                                      |
|-------------------------------|------------------------------------------|
| Toggle container buttons      | Click the ⚙️ floating button (bottom-right) |
| Open Stacks panel             | Click the 🐳 floating button             |
| Expand a stack                | Click “View Containers”                  |
| Start / Stop / Restart stack  | Use the buttons on the stack card (confirmation required) |
| Force network check           | Open browser console → `dhCheckInvalidNetMode()` |
| Disable long-press            | Set `HOLD_DURATION = 0`                  |

---

## Troubleshooting

- **Buttons / stacks not appearing**  
  Check browser console for Dockhand API errors. Verify `BASE_URL`, `TOKEN`, and CORS.

- **Container name not detected**  
  Ensure `homepage.id` starts with the real container name (e.g. `dockhand-ondemand-vpn`).

- **Fake stacks missing**  
  Labels must be present on the containers and Dockhand must return them in `/stacks`. Wait a few seconds after page load (script builds them with a short delay).

- **Network highlights not showing**  
  Confirm `INVALID_NETWORK_CHECK = true` and that Dockhand can inspect containers.

- **Icons not loading**  
  Verify the icons are served under `/icons/` and the volume mount is correct.

---

## Security Notes

- These controls give full start/stop/restart power over your containers.
- Keep Homepage and Dockhand on a private network or behind strong authentication.
- Never commit real tokens to a public repository.
- Consider restricting the Dockhand token to the minimum required permissions.

---

## Credits

Created for a personal HomeLab using Homepage + Dockhand + Sablier + Traefik.  
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