const DEBUG = false;

/* long press on mobile */
const HOLD_DURATION = 1000; // ms lomg press delay on mobile , 0 disable

/* network check */
const INVALID_NETWORK_CHECK = true;
const INVALID_NETWORK_NOTIFICATION = false;
const CHECK_INTERVAL = 0; // recheck time in ms, 0 disable 
const CONCURRENCY = 5; // parallel inspect requests

/* ====================== Shared Dockhand Config ====================== */
const DH = {
  BASE_URL: 'http://dockhand.example.com/api', // replace with URL to dockhand API
  TOKEN: 'REPLACE_WITH_DOCKHAND_TOKEN', // replace with dockhand token
  ENV: '1',
  POLL_INTERVAL: 5000,
  HIDE_BUTTONS: ['dockhand'],
  HIDE_STACKS: []
};

async function dhApi(endpoint, method = 'GET', extraQuery = {}) {
  const params = new URLSearchParams({ env: DH.ENV, ...extraQuery });
  const url = `${DH.BASE_URL}${endpoint}?${params.toString()}`;
  if (DEBUG) console.log(url);
  try {
    const res = await fetch(url, {
      method,
      credentials: 'include',
      headers: {
        Authorization: `Bearer ${DH.TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // 204 / empty body
    if (res.status === 204 || res.headers.get('content-length') === '0') return true;
    return await res.json();
  } catch (err) {
    console.error('Dockhand API Error:', err);
    return null;
  }
}

/* ====================== Toast ====================== */
(function () {
  function ensureContainer() {
    let el = document.getElementById('custom-toast-container');
    if (!el) {
      el = document.createElement('div');
      el.id = 'custom-toast-container';
      el.style.cssText =
        'position:fixed;top:20px;right:20px;display:flex;flex-direction:column;gap:10px;z-index:10001;max-width:320px';
      document.body.appendChild(el);
    }
    return el;
  }

  window.showToast = function (message, type = 'info', duration = 2000) {
    const container = ensureContainer();
    const toast = document.createElement('div');

    const styles = {
      info: { bg: '#1f2937', icon: 'ℹ️' },
      success: { bg: '#10b981', icon: '✅' },
      error: { bg: '#ef4444', icon: '❌' },
      warning: { bg: '#f59e0b', icon: '⚠️' }
    };
    const { bg, icon } = styles[type] || styles.info;

    toast.style.cssText = `
      padding:14px 18px;border-radius:10px;color:#fff;font-size:14.5px;font-weight:500;
      box-shadow:0 10px 15px -3px rgba(0,0,0,.3),0 4px 6px -4px rgba(0,0,0,.3);
      display:flex;align-items:center;gap:12px;min-width:260px;opacity:0;transform:translateX(40px);
      transition:all .35s cubic-bezier(.34,1.56,.64,1);backdrop-filter:blur(12px);
      border:1px solid rgba(255,255,255,.1);background:${bg}`;
    toast.innerHTML = `<span style="font-size:19px;flex-shrink:0">${icon}</span><span>${message}</span>`;

    container.appendChild(toast);
    requestAnimationFrame(() => {
      toast.style.opacity = '1';
      toast.style.transform = 'translateX(0)';
    });

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(30px)';
      setTimeout(() => {
        toast.remove();
        if (!container.children.length) container.remove();
      }, 350);
    }, duration);
  };
})();

/* ====================== Long-press Progress Ring (mobile) ====================== */
(function () {

  const isMobile =
    window.innerWidth <= 768 ||
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  if (!isMobile || HOLD_DURATION == 0) return;

  console.log('Long-press : Progress Ring enabled time: ' + HOLD_DURATION);

  let holdTimer = null;
  let progressInterval = null;
  let currentCard = null;

  function createOverlay(card) {
    let overlay = card.querySelector('.long-press-overlay');
    if (!overlay) {
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
    }
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
      if (link?.href) {
        if (DEBUG) console.log('Long-press: Opening', link.href);
        window.location.href = link.href;
      }
      resetHold();
    }, HOLD_DURATION);
  }

  function blockAllLinks(card) {
    card.querySelectorAll('a[href]').forEach((link) => {
      if (link.dataset.longPressBlocked) return;
      link.dataset.longPressBlocked = 'true';
      link.style.pointerEvents = 'none';
      const block = (e) => {
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
    document.querySelectorAll('.service-card').forEach((card) => {
      if (card.dataset.longPressV9) return;
      if (!card.hasAttribute('href') && !card.querySelector('a[href]')) return;

      card.dataset.longPressV9 = 'true';
      blockAllLinks(card);

      const targets = [card, card.querySelector('.service-title')].filter(Boolean);
      targets.forEach((t) => {
        t.addEventListener(
          'touchstart',
          (e) => {
            if (e.target.closest('button, input, .widget, .service-tag')) return;
            startHold(card);
          },
          { passive: true }
        );
      });
      card.addEventListener('touchend', resetHold, { passive: true });
      card.addEventListener('touchcancel', resetHold, { passive: true });
    });
  }

  function init() {
    attachListeners();
    const obs = new MutationObserver(() => setTimeout(attachListeners, 400));
    obs.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

/* ====================== Per-card Start/Stop/Restart controls ====================== */
(function () {
  let controlsVisible = false;
  let managed = [];

  function extractContainerName(id) {
    if (!id) return null;
    let name = id.toLowerCase();
    if (/^(app|root|layout|grid|group|section|row|col|panel|window|container|wrapper|main|body)/.test(name)) {
      return null;
    }
    name = name.replace(/^(srv|container|app|docker|widget|item)-/, '');
    return name.split('-')[0];
  }

  function autoDiscover() {
    document.querySelectorAll('[class="service"]').forEach((card) => {
      const id = card.id;
      if (!id || card.querySelector('.custom-docker-controls')) return;
      const containerName = extractContainerName(id);
      if (!containerName) return;
      managed.push({ elementId: id, containerName });
      if (DEBUG) console.log(id + ':' + containerName);
    });
  }

  async function sendCommand(name, action) {
    const ok = await dhApi(`/containers/${name}/${action}`, 'POST');
    if (ok) {
      showToast(`Dockhand confirmed: ${action} on ${name}.`, 'success');
      return true;
    }
    showToast(`Dockhand API Error executing ${action} on ${name}.`, 'error');
    return false;
  }

  function injectButtons() {
    managed.forEach((item) => {
      const card = document.getElementById(item.elementId);
      if (!card || card.querySelector('.custom-docker-controls')) return;

      card.style.position = 'relative';
      const wrapper = document.createElement('div');
      wrapper.className = 'custom-docker-controls';
      wrapper.style.cssText = `
        display:${controlsVisible ? 'flex' : 'none'};position:absolute;top:10px;left:56px;gap:8px;height:42px;
        background:rgba(15,23,42,.85);backdrop-filter:blur(4px);padding:4px;border-radius:6px;
        border:1px solid rgba(255,255,255,.1);box-shadow:0 4px 12px rgba(0,0,0,.3);z-index:999`;

      const base =
        'padding:4px 10px;height:32px;display:flex;align-items:center;justify-content:center;font-size:11px;color:#fff;border-radius:4px;cursor:pointer;border:none;box-shadow:0 1px 3px rgba(0,0,0,.15);transition:opacity .15s;font-family:system-ui,sans-serif;font-weight:500';

      const setLoading = (loading) => {
        wrapper.querySelectorAll('button').forEach((b) => {
          b.disabled = loading;
          b.style.opacity = loading ? '0.4' : '1';
        });
      };

      const makeBtn = (label, title, color, action) => {
        const btn = document.createElement('button');
        btn.innerHTML = label;
        btn.title = title;
        btn.style.cssText = base + `; background-color:${color};`;
        btn.onclick = async (e) => {
          e.preventDefault();
          e.stopPropagation();
          setLoading(true);
          await sendCommand(item.containerName, action);
          setLoading(false);
        };
        return btn;
      };

      wrapper.append(
        makeBtn('▶ Start', 'Start Container', '#10b981', 'start'),
        makeBtn('↻ Restart', 'Restart Container', '#3b82f6', 'restart'),
        makeBtn('■ Stop', 'Stop Container', '#ef4444', 'stop')
      );
      card.appendChild(wrapper);
    });
  }

  function injectToggle() {
    if (document.getElementById('dockhand-toggle-fab')) return;

    const fab = document.createElement('button');
    fab.id = 'dockhand-toggle-fab';
    fab.innerHTML = '⚙️';
    fab.title = 'Toggle Docker Controls';
    fab.style.cssText = `
      position:fixed;bottom:20px;right:20px;width:45px;height:45px;border-radius:50%;
      background:#1f2937;color:#fff;border:2px solid #374151;box-shadow:0 4px 10px rgba(0,0,0,.3);
      cursor:pointer;z-index:10000;font-size:20px;display:flex;align-items:center;justify-content:center;
      transition:transform .2s,background-color .2s`;

    fab.onmouseenter = () => (fab.style.transform = 'scale(1.2)');
    fab.onmouseleave = () => (fab.style.transform = 'scale(1)');

    fab.onclick = (e) => {
      e.preventDefault();
      controlsVisible = !controlsVisible;
      if (!managed.length) {
        autoDiscover();
        injectButtons();
      }
      document.querySelectorAll('.custom-docker-controls').forEach((el) => {
        el.style.display = controlsVisible ? 'flex' : 'none';
      });
      fab.style.backgroundColor = controlsVisible ? '#1f2937' : '#4b5563';
    };

    document.body.appendChild(fab);
  }

  const obs = new MutationObserver(() => injectToggle());
  obs.observe(document.body, { childList: true, subtree: true });
  if (document.readyState !== 'loading') injectToggle();
  else document.addEventListener('DOMContentLoaded', injectToggle);
})();

/* ====================== Dockhand Stacks FAB ====================== */
(function () {
  let cachedStacks = [];
  let pollId = null;
  let expanded = new Set();
  let keepAlive = false;
  let fakeStacksList = [];
  const fakeStacks = [];

  // UI shell
  const container = document.createElement('div');
  container.id = 'dockhand-fab-container';

  const trigger = document.createElement('button');
  trigger.id = 'dockhand-fab-trigger';
  trigger.innerHTML = '🐳';
  trigger.onmouseenter = () => (trigger.style.transform = 'scale(1.2)');
  trigger.onmouseleave = () => (trigger.style.transform = 'scale(1)');

  const panel = document.createElement('div');
  panel.id = 'dockhand-fab-panel';
  panel.innerHTML = `
    <div class="dh-header">
      <span>Dockhand Stacks</span>
      <button id="dh-refresh" style="border:none;background:none;cursor:pointer">🔄</button>
    </div>
    <div id="dh-stack-list" style="padding:4px">Loading...</div>`;

  container.append(panel, trigger);
  document.body.appendChild(container);

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

  // Toggle + polling
  trigger.addEventListener('click', () => {
    const open = panel.style.display === 'block';
    if (open) {
      panel.style.display = 'none';
      stopPolling();
    } else {
      panel.style.display = 'block';
      fetchStacks();
      startPolling();
    }
  });

  document.getElementById('dh-refresh').addEventListener('click', (e) => {
    e.stopPropagation();
    fetchStacks();
  });

  function startPolling() {
    if (!pollId) pollId = setInterval(pollExpanded, DH.POLL_INTERVAL);
  }
  function stopPolling() {
    clearInterval(pollId);
    pollId = null;
  }

  async function pollExpanded() {
    if (expanded.size === 0) return;
    fetchStacks();
  }

  async function fetchStacks() {
    if (!cachedStacks.length) {
      const list = document.getElementById('dh-stack-list');
      if (list) list.innerHTML = "<div style='padding:12px'>Fetching stacks...</div>";
    }

    let stacks = await dhApi('/stacks');
    keepAlive = !keepAlive;

    if (!stacks) stacks = [];
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
    stacks.forEach((s) => {
      s.id = s.name;
      if (Array.isArray(s.containerDetails)) {
        s.containerDetails.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      }
    });

    cachedStacks = stacks;
    renderStackList();
  }

  function renderStackList() {
    const list = document.getElementById('dh-stack-list');
    if (!list) return;
    list.innerHTML = '';

    cachedStacks.forEach((stack) => {
      if (DH.HIDE_STACKS.includes(stack.name)) return;

      const item = document.createElement('div');
      item.className = 'dh-stack-item';

      let detailsHtml = '';
      if (stack.containerDetails?.length) {
        const badNames = window.__dhInvalidNetMode?.byName || new Set();
        detailsHtml = stack.containerDetails
          .map((c) => {
            const cName = (c.name || '').replace(/^\//, '').toLowerCase();
            const isBad = badNames.has(cName);
            const badInfo = isBad
              ? (window.__dhInvalidNetMode.details || []).find(
                  (d) => (d.name || '').toLowerCase() === cName
                )
              : null;
            stack.badNetwork = badInfo ? true : false;
            const warnAttr = isBad
              ? ` class="dh-nested-c-row dh-invalid-netmode" data-netmode-warn="⚠ missing: ${badInfo?.target || '?'}"`
              : ' class="dh-nested-c-row"';
            return `
          <div${warnAttr}>
            <div class="dh-nested-c-top" style="display:flex;justify-content:space-between">
              <span>🔹${c.name || 'container'} ${c.updateAvailable ? '⬆️' : ''}${isBad ? ' ⚠' : ''}</span>
              <span>${keepAlive ? '🔶' : '🔸'}</span>
            </div>
            <div class="dh-nested-c-meta">
              <span><span class="dh-meta-label">State:</span>
                <span class="state-pill ${getStateClass(c.state)}">${c.state || 'unknown'}</span></span>
              <span><span class="dh-meta-label">Status:</span> ${c.status || 'unknown'}</span>
            </div>
          </div>`;
          })
          .join('');
      } else {
        detailsHtml =
          '<div class="dh-nested-c-row" style="color:#9ca3af;text-align:center">No containers mapped.</div>';
      }

      const isExpanded = expanded.has(String(stack.id));
      const disabled = DH.HIDE_BUTTONS.includes(stack.name) ? 'disabled' : '';

      item.innerHTML = `
        <div class="dh-stack-name" style="display:flex;justify-content:space-between">
          <span>
            ${stack.isFake ? '👻' : statusIcon(stack.status)}
            ${stack.name || stack.id}
          </span>
          <span>${stack.updateCount > 0 ? stack.updateCount : ''}${stack.updatesAvailable ? '⬆️' : ''} ${stack.badNetwork ? '⚠️' : ''}</span>
        </div>
        <div class="dh-actions">
          <button class="dh-btn btn-start" ${disabled} data-id="${stack.id}">▶ Start</button>
          <button class="dh-btn btn-reset" ${disabled} data-id="${stack.id}">↻ Restart</button>
          <button class="dh-btn btn-stop" ${disabled} data-id="${stack.id}">■ Stop</button>
        </div>
        <button class="dh-expand-toggle" data-id="${stack.id}">
          <span>View Containers</span> <span>${isExpanded ? '▲' : '▼'}</span>
        </button>
        <div class="dh-container-details-list" id="dh-details-${stack.id}"
             style="display:${isExpanded ? 'block' : 'none'}">
          ${detailsHtml}
        </div>`;

      list.appendChild(item);
    });

    // Expand toggles
    list.querySelectorAll('.dh-expand-toggle').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = String(btn.dataset.id);
        const details = document.getElementById(`dh-details-${id}`);
        const arrow = btn.querySelector('span:last-child');
        if (details.style.display === 'block') {
          details.style.display = 'none';
          arrow.textContent = '▼';
          expanded.delete(id);
        } else {
          details.style.display = 'block';
          arrow.textContent = '▲';
          expanded.add(id);
          pollExpanded();
        }
      });
    });

    // Action buttons
    list.querySelectorAll('.dh-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = btn.classList.contains('btn-start')
          ? 'start'
          : btn.classList.contains('btn-stop')
            ? 'stop'
            : 'restart';
        const stack = cachedStacks.find((s) => String(s.id) === String(btn.dataset.id));
        if (stack?.containerDetails?.length) {
          openBatchPopup(stack, action);
        } else {
          showToast('No container structures found inside this stack.', 'error');
        }
      });
    });
  }

  function openBatchPopup(stack, action) {
    const containers = stack.containerDetails;
    const overlay = document.createElement('div');
    overlay.id = 'dh-popup-overlay';
    overlay.innerHTML = `
      <div class="dh-popup-content">
        <div class="dh-header">
          <span>Target Action: ${action.toUpperCase()}</span>
          <span style="font-size:12px;color:#4b5563">Stack: ${stack.name}</span>
        </div>
        <div class="dh-popup-body" id="dh-popup-list"></div>
        <div style="padding:12px;background:#f9fafb;display:flex;justify-content:flex-end">
          <button id="dh-close-popup" class="dh-btn btn-stop" style="max-width:80px" disabled>Processing</button>
        </div>
      </div>`;

    document.body.appendChild(overlay);
    const listEl = document.getElementById('dh-popup-list');

    containers.forEach((c, i) => {
      const row = document.createElement('div');
      row.className = 'dh-c-row';
      row.id = `dh-row-${i}`;
      row.innerHTML = `
        <div class="dh-c-info">
          <span class="dh-c-name">${c.name || 'Unnamed Container'}</span>
          <span class="dh-c-sub">State: <span class="state-pill ${getStateClass(c.state)}">${c.state || 'unknown'}</span></span>
          <span class="dh-c-sub">Status: ${c.status || 'unknown'}</span>
        </div>
        <div class="dh-c-status-container" id="dh-status-ctx-${i}">
          <span class="dh-status-badge status-pending">Queued</span>
        </div>`;
      listEl.appendChild(row);
    });

    if (!confirm(`Are you sure you want to ${action} stack ${stack.name}?`)) {
      overlay.remove();
      fetchStacks();
      return;
    }

    (async () => {
      for (let i = 0; i < containers.length; i++) {
        const ctx = document.getElementById(`dh-status-ctx-${i}`);
        const verb =
          action === 'stop' ? 'stopping' : action === 'start' ? 'starting' : 'restarting';
        ctx.innerHTML = `<span style="font-size:12px;color:#2563eb">${verb}</span><div class="dh-spinner"></div>`;

        const id = containers[i].id || containers[i].name;
        const result = await dhApi(`/containers/${id}/${action}`, 'POST');
        ctx.innerHTML = result
          ? '<span class="dh-status-badge status-success">Done</span>'
          : '<span class="dh-status-badge status-error">Failed</span>';
      }

      const closeBtn = document.getElementById('dh-close-popup');
      closeBtn.disabled = false;
      closeBtn.textContent = 'Close';
      closeBtn.style.background = '#2563eb';
      closeBtn.onclick = () => {
        overlay.remove();
        fetchStacks();
      };
    })();
  }

  /* ---------- Fake stacks from labels ---------- */
  function updateFakeStacks(realStacks) {
    const usable = realStacks.filter((s) => !s.isFake && s.containerDetails?.length);
    if (!usable.length) return;

    fakeStacks.length = 0;

    fakeStacksList.forEach((fs) => {
      const selected = [];
      fs.containers.forEach(({ stackName, service }) => {
        const stack = usable.find((s) => s.name === stackName);
        if (!stack) return;
        const c = stack.containerDetails.find((x) => x.service === service);
        if (c) selected.push(c);
      });

      if (!selected.length) return;

      fakeStacks.push({
        name: fs.name,
        id: `fake-${fs.name}`,
        status: '',
        containerDetails: selected,
        isFake: true,
        source: 'labels',
        lastUpdated: new Date().toISOString()
      });
    });
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
        const unique = containers.filter((c) => {
          const k = `${c.stackName}-${c.name}-${c.service}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        result.push({ name, containers: unique });
      }
      result.sort((a, b) => a.name.localeCompare(b.name));
      fakeStacksList = result;
      if (DEBUG) console.log('fakeStacks from labels', result);
    } catch (err) {
      console.error('Failed to build fakeStacks from labels', err);
    }
  }

  // Delay so the page / other scripts can settle
  setTimeout(buildFakeStacksFromLabels, 1000);
})();

/* ====================== Invalid network_mode: container:<id> detector ====================== */
(function () {
  const HIGHLIGHT_CLASS = 'dh-invalid-netmode';
  const STYLE_ID = 'dh-invalid-netmode-style';

  // Shared so stacks FAB can also mark rows
  window.__dhInvalidNetMode = window.__dhInvalidNetMode || {
    byName: new Set(),
    byId: new Set(),
    details: [] // { name, id, networkMode, target }
  };

  let checkInFlight = false;

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .${HIGHLIGHT_CLASS} {
        border: 2px solid #ef4444 !important;
      }
      .${HIGHLIGHT_CLASS}::after {
        content: attr(data-netmode-warn);
        position: absolute;
        bottom: 4px;
        right: 4px;
        background: #ef4444;
        color: #fff;
        font-size: 10px;
        font-weight: 600;
        padding: 2px 6px;
        border-radius: 4px;
        z-index: 50;
        max-width: 70%;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        pointer-events: none;
        font-family: system-ui, sans-serif;
      }
      .dh-nested-c-row.${HIGHLIGHT_CLASS},
      .dh-c-row.${HIGHLIGHT_CLASS} {
        background: rgba(239, 68, 68, 0.12);
        border-left: 3px solid #ef4444;
        border-radius: 4px;
        padding-left: 6px;
      }
      .dh-nested-c-row.${HIGHLIGHT_CLASS}::after,
      .dh-c-row.${HIGHLIGHT_CLASS}::after {
        position: static;
        display: inline-block;
        margin-left: 6px;
        max-width: none;
      }
    `;
    document.head.appendChild(style);
  }

  /** NetworkMode from full Docker inspect payload */
  function getNetworkMode(inspect) {
    if (!inspect || typeof inspect !== 'object') return '';
    const candidates = [
      inspect.HostConfig?.NetworkMode,
      inspect.hostConfig?.NetworkMode,
      inspect.HostConfig?.networkMode,
      inspect.networkMode,
      inspect.NetworkMode
    ];
    for (const v of candidates) {
      if (typeof v === 'string' && v.length) return v;
    }
    return '';
  }

  function normalizeName(n) {
    if (!n) return '';
    return String(n).replace(/^\//, '').toLowerCase();
  }

  function listIdentity(c) {
    const id = (c.id || c.Id || c.ID || '').toString();
    let name = c.name || c.Name || '';
    if (!name && Array.isArray(c.Names) && c.Names[0]) name = c.Names[0];
    name = normalizeName(name);
    const shortId = id.length > 12 ? id.slice(0, 12) : id;
    return { id, shortId, name };
  }

  /** Run async work over items with a concurrency limit */
  async function mapPool(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;

    async function worker() {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }

    const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
  }

  /**
   * 1) List containers → valid id/name set
   * 2) Inspect each → HostConfig.NetworkMode
   * 3) Flag network_mode:container:<ref> where <ref> is missing
   */
  async function findInvalidViaInspect() {
    let list = await dhApi('/containers', 'GET', { all: 'true' });
    if (!list) list = await dhApi('/containers');
    if (list && !Array.isArray(list) && Array.isArray(list.containers)) {
      list = list.containers;
    }
    if (!Array.isArray(list) || !list.length) {
      if (DEBUG) console.warn('Invalid-netmode: empty container list', list);
      return [];
    }

    // Build lookup of every existing container (stopped included)
    const ids = new Set();
    const names = new Set();
    const targets = []; // { id, name } for inspect

    for (const c of list) {
      const { id, shortId, name } = listIdentity(c);
      if (id) {
        ids.add(id.toLowerCase());
        if (shortId) ids.add(shortId.toLowerCase());
      }
      if (name) names.add(name);
      if (Array.isArray(c.Names)) {
        c.Names.forEach((n) => names.add(normalizeName(n)));
      }
      // Prefer id for inspect; fall back to name
      const key = id || name;
      if (key) targets.push({ id, name, key });
    }

    if (DEBUG) console.log(`Invalid-netmode: inspecting ${targets.length} containers (concurrency ${CONCURRENCY})`);

    const inspected = await mapPool(targets, CONCURRENCY, async ({ id, name, key }) => {
      // Prefer /containers/{id}/inspect, fall back to /containers/{id}
      let detail = await dhApi(`/containers/${encodeURIComponent(key)}/inspect`);
      if (!detail) detail = await dhApi(`/containers/${encodeURIComponent(key)}`);
      if (!detail) return null;

      const mode = getNetworkMode(detail);
      const resolvedId = (detail.Id || detail.id || id || '').toString();
      const resolvedName = normalizeName(detail.Name || detail.name || name);

      return {
        id: resolvedId,
        name: resolvedName || name || resolvedId || 'unknown',
        networkMode: mode
      };
    });

    const invalid = [];

    for (const row of inspected) {
      if (!row || !row.networkMode) continue;

      const m = row.networkMode.match(/^container:(.+)$/i);
      if (!m) continue;

      const target = m[1].trim();
      const targetNorm = normalizeName(target);
      const targetLower = target.toLowerCase();

      const exists =
        names.has(targetNorm) ||
        ids.has(targetLower) ||
        ids.has(targetLower.slice(0, 12));

      if (!exists) {
        invalid.push({
          name: row.name,
          id: row.id,
          networkMode: row.networkMode,
          target
        });
      }
    }

    return invalid;
  }

  function clearHighlights() {
    document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach((el) => {
      el.classList.remove(HIGHLIGHT_CLASS);
      el.removeAttribute('data-netmode-warn');
    });
  }

  function highlightHomepageCards(invalid) {
    if (!invalid.length) return;

    const nameSet = new Set(invalid.map((x) => normalizeName(x.name)));
    const idSet = new Set(invalid.map((x) => (x.id || '').toLowerCase()).filter(Boolean));

  // '.service, .service-card, [class*="service"], [id^="srv-"], [id^="container-"], [id^="app-"]'

    const cards = document.querySelectorAll(
      '[class*="service-card"]'
    );

    cards.forEach((card) => {
      const id = (card.id || '').toLowerCase();
      const extracted = id
        .replace(/^(srv|container|app|docker|widget|item)-/, '')
        .split('-')[0];

      const titleEl =
        card.querySelector('.service-title, .title, h1, h2, h3, [class*="title"]') || card;
      const titleText = normalizeName(titleEl.textContent || '');

      const match =
        nameSet.has(extracted) ||
        nameSet.has(normalizeName(id)) ||
        [...nameSet].some((n) => n && (id.includes(n) || titleText.includes(n))) ||
        [...idSet].some((cid) => cid && id.includes(cid.slice(0, 12)));

      if (!match) return;

      const info = invalid.find(
        (x) =>
          normalizeName(x.name) === extracted ||
          normalizeName(x.name) === titleText ||
          (x.id && id.includes((x.id || '').toLowerCase().slice(0, 12)))
      );

      card.classList.add(HIGHLIGHT_CLASS);
      card.setAttribute(
        'data-netmode-warn',
        info ? `⚠ net → missing: ${info.target}` : '⚠ invalid network_mode:container'
      );
      card.title =
        (info
          ? `Network mode "${info.networkMode}" references missing container "${info.target}"`
          : 'Invalid container network mode') + (card.title ? '\n' + card.title : '');

    });
  }

  function highlightStackRows(invalid) {
    if (!invalid.length) return;
    const nameSet = new Set(invalid.map((x) => normalizeName(x.name)));

    document.querySelectorAll('.dh-nested-c-row, .dh-c-row').forEach((row) => {
      const text = normalizeName(row.textContent || '');
      const hit = [...nameSet].find((n) => n && text.includes(n));
      if (!hit) return;

      const info = invalid.find((x) => normalizeName(x.name) === hit);
      row.classList.add(HIGHLIGHT_CLASS);
      row.setAttribute(
        'data-netmode-warn',
        info ? `⚠ missing: ${info.target}` : '⚠ bad netmode'
      );
    });
  }

  async function runCheck(showToastOnFind = false) {
    if (checkInFlight) return;
    checkInFlight = true;
    ensureStyles();

    try {
      const invalid = await findInvalidViaInspect();

      window.__dhInvalidNetMode.byName = new Set(invalid.map((x) => normalizeName(x.name)));
      window.__dhInvalidNetMode.byId = new Set(
        invalid.map((x) => (x.id || '').toLowerCase()).filter(Boolean)
      );
      window.__dhInvalidNetMode.details = invalid;

      clearHighlights();
      highlightHomepageCards(invalid);
      highlightStackRows(invalid);

      if (DEBUG) console.log('Invalid network_mode:container targets', invalid);

      if (showToastOnFind && invalid.length) {
        const names = invalid
          .map((x) => x.name)
          .slice(0, 5)
          .join(', ');
        const more = invalid.length > 5 ? ` (+${invalid.length - 5} more)` : '';
        showToast(
          `${invalid.length} container(s) use network_mode:container with missing target: ${names}${more}`,
          'warning',
          5000
        );
      }
    } catch (err) {
      console.error('Invalid-netmode check failed:', err);
    } finally {
      checkInFlight = false;
    }
  }

  // Re-apply highlights when Homepage mutates cards
  const obs = new MutationObserver(() => {
    const invalid = window.__dhInvalidNetMode?.details;
    if (invalid?.length) {
      highlightHomepageCards(invalid);
      highlightStackRows(invalid);
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });

  const start = () => {
    if (INVALID_NETWORK_CHECK) runCheck(INVALID_NETWORK_NOTIFICATION);
    if (CHECK_INTERVAL != 0) {
      setInterval(() => runCheck(false), CHECK_INTERVAL);
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(start, 1500));
  } else {
    setTimeout(start, 1500);
  }

  // Manual trigger: dhCheckInvalidNetMode() in console
  window.dhCheckInvalidNetMode = () => runCheck(true);
})();
