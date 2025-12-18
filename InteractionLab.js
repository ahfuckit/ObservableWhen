/**
*@Copyright 2025 Chris Singendonk
*/
// PoC v2: In-page interaction observability lab for Chromium
// Usage (page-world injected): InteractionLab.init();

const InteractionLab = (function () {
  'use strict';

  // ---------- Config / State ----------

  const DEFAULTS = {
    interactionWindowMs: 4000,
    maxStoredInteractions: 50,
    primaryEvents: ['click', 'pointerup', 'keydown', 'submit'],

    // Hooks
    enableNetworkHooks: true,     // fetch/xhr/beacon/ws
    enableErrorHooks: true,       // onerror/unhandledrejection
    enableNavHooks: true,         // pushState/replaceState/popstate/hashchange
    enableResourceTimings: true,  // PerformanceObserver('resource') + attach
    enableConsoleAdapter: false,  // optional: capture console.* calls (noisy)

    // Noise control
    logResourceEntriesToConsole: false,
    maxRecentResources: 250,
    resourceMatchWindowMs: 250,   // how close startTime must be to match fetch/xhr → resource entry
    minResourceDurationMs: 0      // set e.g. 50 to ignore tiny resources
  };

  const CONFIG = Object.assign({}, DEFAULTS);

  const state = {
    initialized: false,
    listenersAttached: false,
    interactions: [],
    sessionsById: Object.create(null),
    observers: Object.create(null),
    lastSessionId: null,

    // Recent resource timing cache for matching
    recentResources: [],

    // Patches / originals for clean stop()
    originals: Object.create(null),

    // Global listeners cleanup
    globalListeners: []
  };

  const SYM = {
    xhrMeta: typeof Symbol !== 'undefined' ? Symbol('IL_XHR_META') : '__IL_XHR_META__',
    wsMeta: typeof Symbol !== 'undefined' ? Symbol('IL_WS_META') : '__IL_WS_META__'
  };

  // ---------- Small utilities ----------

  function now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  function wallTimeISO() {
    try { return new Date().toISOString(); } catch { return String(Date.now()); }
  }

  function randId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'int_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2);
  }

  function safeUrl(u) {
    try { return String(u); } catch { return '[unprintable-url]'; }
  }

  function buildSelector(el, maxDepth = 4) {
    const parts = [];
    let depth = 0;
    while (el && el.nodeType === 1 && depth < maxDepth) {
      let part = el.tagName.toLowerCase();
      if (el.id) {
        part += '#' + el.id;
        parts.unshift(part);
        break;
      }
      if (el.classList && el.classList.length) {
        part += '.' + Array.from(el.classList).slice(0, 2).join('.');
      }
      parts.unshift(part);
      el = el.parentElement;
      depth++;
    }
    return parts.join(' > ');
  }

  function summarizeTarget(el) {
    if (!el || el.nodeType !== 1) return { tag: 'UNKNOWN', id: '', className: '', selector: '' };
    const tag = el.tagName;
    const id = el.id || '';
    const className = (typeof el.className === 'string') ? el.className : String(el.className || '');
    return { tag, id, className, selector: buildSelector(el) };
  }

  function logDebug() {
    if (!console || !console.debug) return;
    console.debug.apply(console, arguments);
  }

  // Optional: route logs into your initLogs pipeline if present, else console.*
  function emit(level, tag, message, details, interactionId) {
    // initLogs.js adapter hook (optional)
    try {
      if (window.DOMLogger && typeof window.DOMLogger.addLog === 'function') {
        window.DOMLogger.addLog({
          type: tag,
          message,
          timestamp: wallTimeISO(),
          interactionId: interactionId || null,
          details: details || null
        });
        return;
      }
    } catch (_) {}

    // Console fallback
    const prefix = `[InteractionLab][${tag}]`;
    if (!console) return;
    const fn =
      level === 'error' ? console.error :
      level === 'warn' ? console.warn :
      level === 'info' ? console.info :
      level === 'debug' ? console.debug :
      console.log;

    try {
      if (details !== undefined) fn.call(console, prefix, message, details);
      else fn.call(console, prefix, message);
    } catch {
      // last-resort
      try { console.log(prefix, message); } catch (_) {}
    }
  }

  // Find a session to attach an entry to based on timestamp
  function findSessionForTime(ts) {
    if (!state.interactions.length) return null;

    if (state.lastSessionId) {
      const s = state.sessionsById[state.lastSessionId];
      if (s && ts >= s.startTime && ts <= s.startTime + CONFIG.interactionWindowMs) return s;
    }

    let best = null;
    let bestDelta = Infinity;
    for (const s of state.interactions) {
      const start = s.startTime;
      const end = start + CONFIG.interactionWindowMs;
      if (ts < start || ts > end) continue;
      const delta = Math.abs(ts - start);
      if (delta < bestDelta) { bestDelta = delta; best = s; }
    }
    if (best) state.lastSessionId = best.id;
    return best;
  }

  function attachToSession(session, bucket, item) {
    if (!session) return;
    if (!session[bucket]) session[bucket] = [];
    session[bucket].push(item);
  }

  // ---------- Interaction sessions ----------

  function startInteractionFromEvent(ev) {
    const time = now();
    const id = randId();
    const targetInfo = summarizeTarget(ev.target);

    const session = {
      id,
      startTime: time,
      endTime: null,

      _targetNode: (ev.target && ev.target.nodeType === 1) ? ev.target : null,

      domEvent: {
        type: ev.type,
        key: ev.type.startsWith('key') ? ev.key : undefined,
        button: ev.button,
        pointerType: ev.pointerType,
        target: targetInfo,
        modifiers: {
          alt: !!ev.altKey,
          ctrl: !!ev.ctrlKey,
          meta: !!ev.metaKey,
          shift: !!ev.shiftKey
        }
      },

      scrollY: (typeof window !== 'undefined') ? window.scrollY : 0,
      viewport: (typeof window !== 'undefined')
        ? { width: window.innerWidth, height: window.innerHeight }
        : { width: 0, height: 0 },

      visibility: null,

      perf: {
        eventTimings: [],
        longAnimationFrames: [],
        longTasks: [],
        layoutShifts: [],
        lcpEntries: [],
        resources: [],
        navigation: [],
        paints: []
      },

      network: [],
      errors: [],
      reports: [],
      nav: [],

      metrics: {
        inpLike: 0,
        maxLoafMs: 0,
        totalCls: 0,
        netCount: 0,
        netMaxMs: 0
      },

      timeoutHandle: null
    };

    state.sessionsById[id] = session;
    state.interactions.push(session);
    if (state.interactions.length > CONFIG.maxStoredInteractions) {
      const old = state.interactions.shift();
      if (old) delete state.sessionsById[old.id];
    }
    state.lastSessionId = id;

    console.groupCollapsed(
      `%c[InteractionStart]%c ${ev.type} on ${targetInfo.selector}`,
      'color:#4caf50;font-weight:bold;',
      'color:inherit;'
    );
    console.log('Session', session);
    console.groupEnd();

    // Observe the specific target (if possible)
    if (state.observers.intersection && session._targetNode) {
      try { state.observers.intersection.observe(session._targetNode); } catch (_) {}
    }
    if (state.observers.resize && session._targetNode) {
      try { state.observers.resize.observe(session._targetNode); } catch (_) {}
    }

    session.timeoutHandle = setTimeout(function () {
      closeInteraction(id);
    }, CONFIG.interactionWindowMs);

    return session;
  }

  function closeInteraction(id) {
    const session = state.sessionsById[id];
    if (!session || session.endTime !== null) return;

    session.endTime = now();

    const m = session.metrics;
    const inp = Math.round(m.inpLike || 0);
    const loaf = Math.round(m.maxLoafMs || 0);
    const cls = m.totalCls || 0;

    const netCount = session.network.length;
    const lcpCount = session.perf.lcpEntries.length;

    console.groupCollapsed(
      `%c[InteractionSummary]%c ${session.domEvent.type} on ${session.domEvent.target.selector}  ` +
      `→ INP≈${inp}ms, LoAF max ${loaf}ms, CLS ${cls.toFixed(3)}, net ${netCount}, LCPs ${lcpCount}`,
      'color:#2196f3;font-weight:bold;',
      'color:inherit;'
    );
    console.log('Full session', session);
    console.groupEnd();
  }

  // ---------- DOM interaction listeners ----------

  const domHandlers = [];

  function setupDomListeners() {
    if (state.listenersAttached) return;
    if (typeof document === 'undefined') return;

    CONFIG.primaryEvents.forEach(function (type) {
      const handler = function (ev) {
        try {
          startInteractionFromEvent(ev);
        } catch (e) {
          emit('error', 'DOM', 'Error in interaction handler', e);
        }
      };
      document.addEventListener(type, handler, true);
      domHandlers.push({ type, handler });
    });

    state.listenersAttached = true;
    logDebug('[InteractionLab] DOM interaction listeners attached');
  }

  function removeDomListeners() {
    if (!state.listenersAttached || typeof document === 'undefined') return;
    domHandlers.forEach(function (h) {
      document.removeEventListener(h.type, h.handler, true);
    });
    domHandlers.length = 0;
    state.listenersAttached = false;
  }

  // ---------- PerformanceObserver / ObserverHub ----------

  function setupPerformanceObservers() {
    if (typeof PerformanceObserver === 'undefined') {
      logDebug('[InteractionLab] PerformanceObserver not available');
      return;
    }

    const supported = PerformanceObserver.supportedEntryTypes || [];

    function observeType(type, cb) {
      if (!supported.includes(type)) {
        logDebug('[InteractionLab] Entry type not supported:', type);
        return null;
      }
      try {
        const po = new PerformanceObserver(function (list) {
          list.getEntries().forEach(cb);
        });
        po.observe({ type, buffered: true });
        return po;
      } catch (e) {
        emit('warn', 'Perf', `Failed to observe ${type}`, e);
        return null;
      }
    }

    // Event Timing (INP-ish)
    state.observers.eventTiming = observeType('event', function (entry) {
      const session = findSessionForTime(entry.startTime);
      if (session) {
        session.perf.eventTimings.push(entry);
        const d = entry.duration || 0;
        session.metrics.inpLike = Math.max(session.metrics.inpLike || 0, d);
      }
      emit('debug', 'EventTiming', entry.name || 'event', entry, session ? session.id : null);
    });

    // Long Animation Frame
    state.observers.longAnimationFrame = observeType('long-animation-frame', function (entry) {
      const session = findSessionForTime(entry.startTime);
      if (session) {
        session.perf.longAnimationFrames.push(entry);
        const d = entry.duration || 0;
        session.metrics.maxLoafMs = Math.max(session.metrics.maxLoafMs || 0, d);
      }
      emit('debug', 'LoAF', 'long-animation-frame', entry, session ? session.id : null);
    });

    // Long Tasks
    state.observers.longtask = observeType('longtask', function (entry) {
      const session = findSessionForTime(entry.startTime);
      if (session) session.perf.longTasks.push(entry);
      emit('debug', 'LongTask', 'longtask', entry, session ? session.id : null);
    });

    // Layout shift (CLS)
    state.observers.layoutShift = observeType('layout-shift', function (entry) {
      if (entry && !entry.hadRecentInput) {
        const session = findSessionForTime(entry.startTime);
        if (session) {
          session.perf.layoutShifts.push(entry);
          session.metrics.totalCls = (session.metrics.totalCls || 0) + (entry.value || 0);
        }
        emit('debug', 'CLS', 'layout-shift', entry, session ? session.id : null);
      }
    });

    // LCP
    state.observers.lcp = observeType('largest-contentful-paint', function (entry) {
      const session = findSessionForTime(entry.startTime);
      if (session) session.perf.lcpEntries.push(entry);
      emit('debug', 'LCP', 'largest-contentful-paint', entry, session ? session.id : null);
    });

    // Paint (first-paint / first-contentful-paint)
    state.observers.paint = observeType('paint', function (entry) {
      const session = findSessionForTime(entry.startTime);
      if (session) session.perf.paints.push(entry);
      emit('debug', 'Paint', entry.name || 'paint', entry, session ? session.id : null);
    });

    // Navigation timings
    state.observers.navigation = observeType('navigation', function (entry) {
      const session = findSessionForTime(entry.startTime);
      if (session) session.perf.navigation.push(entry);
      emit('info', 'NavigationTiming', 'navigation', entry, session ? session.id : null);
    });

    // Resource timings
    if (CONFIG.enableResourceTimings) {
      state.observers.resource = observeType('resource', function (entry) {
        if ((entry.duration || 0) < CONFIG.minResourceDurationMs) return;

        const simplified = {
          name: entry.name,
          initiatorType: entry.initiatorType,
          startTime: entry.startTime,
          duration: entry.duration,
          transferSize: entry.transferSize,
          encodedBodySize: entry.encodedBodySize,
          decodedBodySize: entry.decodedBodySize,
          nextHopProtocol: entry.nextHopProtocol
        };

        // cache for matching
        state.recentResources.push(simplified);
        if (state.recentResources.length > CONFIG.maxRecentResources) {
          state.recentResources.shift();
        }

        const session = findSessionForTime(entry.startTime);
        if (session) session.perf.resources.push(simplified);

        if (CONFIG.logResourceEntriesToConsole) {
          emit('debug', 'Resource', simplified.initiatorType || 'resource', simplified, session ? session.id : null);
        }
      });
    }

    // Snapshot current navigation entry immediately (useful even without PO)
    try {
      if (performance && typeof performance.getEntriesByType === 'function') {
        const nav = performance.getEntriesByType('navigation');
        if (nav && nav.length) emit('info', 'NavigationTiming', 'snapshot', nav[0], null);
      }
    } catch (_) {}
  }

  // ---------- ReportingObserver ----------

  function setupReportingObserver() {
    if (typeof ReportingObserver === 'undefined') {
      logDebug('[InteractionLab] ReportingObserver not available');
      return;
    }

    try {
      const ro = new ReportingObserver(function (reports) {
        reports.forEach(function (report) {
          const ts = now();
          const session = findSessionForTime(ts);
          if (session) session.reports.push(report);
          emit('warn', 'ReportingObserver', report.type, report, session ? session.id : null);
        });
      }, { types: ['deprecation', 'intervention'], buffered: true });

      ro.observe();
      state.observers.reporting = ro;
    } catch (e) {
      emit('warn', 'ReportingObserver', 'Failed to create ReportingObserver', e);
    }
  }

  // ---------- Intersection / Resize / Mutation ----------

  function setupDomObservers() {
    // Intersection: track visibility for interaction target nodes
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          // find the most recent session that targeted this node
          for (let i = state.interactions.length - 1; i >= 0; i--) {
            const s = state.interactions[i];
            if (s && s._targetNode === entry.target) {
              s.visibility = {
                isIntersecting: entry.isIntersecting,
                ratio: entry.intersectionRatio,
                time: now()
              };
              break;
            }
          }
          emit('debug', 'Intersection', 'entry', {
            target: summarizeTarget(entry.target),
            isIntersecting: entry.isIntersecting,
            ratio: entry.intersectionRatio
          });
        });
      });
      state.observers.intersection = io;
    }

    // Resize: log when target/body changes size
    if ('ResizeObserver' in window) {
      const ro = new ResizeObserver(function (entries) {
        entries.forEach(function (entry) {
          emit('debug', 'Resize', 'entry', {
            target: summarizeTarget(entry.target),
            rect: entry.contentRect
          });
        });
      });
      state.observers.resize = ro;
      try { ro.observe(document.body); } catch (_) {}
    }

    // Mutation: coarse DOM change logging (throttled)
    if ('MutationObserver' in window) {
      let pending = 0;
      let t = null;

      const mo = new MutationObserver(function (mutations) {
        pending += mutations.length;
        if (t) return;
        t = setTimeout(function () {
          const count = pending;
          pending = 0;
          t = null;
          emit('debug', 'Mutation', 'batch', { count });
        }, 250);
      });

      try {
        mo.observe(document.documentElement || document, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: false
        });
        state.observers.mutation = mo;
      } catch (e) {
        emit('warn', 'Mutation', 'Failed to attach MutationObserver', e);
      }
    }
  }

  // ---------- NEW: Network hooks (fetch / XHR / beacon / WebSocket) ----------

  function matchResourceTiming(url, startTime) {
    // best-effort match by URL + startTime proximity
    const u = safeUrl(url);
    let best = null;
    let bestDelta = Infinity;

    for (let i = state.recentResources.length - 1; i >= 0; i--) {
      const r = state.recentResources[i];
      if (!r || r.name !== u) continue;
      const delta = Math.abs((r.startTime || 0) - (startTime || 0));
      if (delta < bestDelta) {
        bestDelta = delta;
        best = r;
      }
      // since recentResources is time-ish ordered, we can bail when delta grows a lot
      if (bestDelta <= CONFIG.resourceMatchWindowMs && delta > bestDelta + CONFIG.resourceMatchWindowMs) break;
    }

    if (best && bestDelta <= CONFIG.resourceMatchWindowMs) return best;
    return null;
  }

  function tagNetworkEvent(evt) {
    const ts = (evt && typeof evt.startTime === 'number') ? evt.startTime : now();
    const session = findSessionForTime(ts);

    if (session) {
      session.network.push(evt);
      session.metrics.netCount = session.network.length;
      session.metrics.netMaxMs = Math.max(session.metrics.netMaxMs || 0, evt.duration || 0);
    }

    emit(evt.level || 'info', 'Network', evt.kind || evt.type || 'network', evt, session ? session.id : null);
    return session ? session.id : null;
  }

  function setupNetworkHooks() {
    // fetch
    if (CONFIG.enableNetworkHooks && typeof window.fetch === 'function') {
      state.originals.fetch = window.fetch;

      window.fetch = function patchedFetch(input, init) {
        const start = now();
        const url = (typeof input === 'string') ? input : (input && input.url) || '';
        const method = (init && init.method) || (input && input.method) || 'GET';

        return state.originals.fetch.apply(this, arguments).then(function (res) {
          const end = now();
          const evt = {
            type: 'fetch',
            kind: 'fetch',
            url: safeUrl(url),
            method: String(method || 'GET'),
            status: res && typeof res.status === 'number' ? res.status : -1,
            ok: !!(res && res.ok),
            startTime: start,
            endTime: end,
            duration: end - start,
            redirected: !!(res && res.redirected),
            responseType: res && res.type,
            level: (res && res.ok) ? 'info' : 'warn'
          };

          const rt = matchResourceTiming(evt.url, start);
          if (rt) evt.resourceTiming = rt;

          tagNetworkEvent(evt);
          return res;
        }).catch(function (err) {
          const end = now();
          const evt = {
            type: 'fetch',
            kind: 'fetch',
            url: safeUrl(url),
            method: String(method || 'GET'),
            status: -1,
            ok: false,
            startTime: start,
            endTime: end,
            duration: end - start,
            error: { name: err && err.name, message: err && err.message },
            level: 'error'
          };

          const rt = matchResourceTiming(evt.url, start);
          if (rt) evt.resourceTiming = rt;

          tagNetworkEvent(evt);
          throw err;
        });
      };
    }

    // XHR
    if (CONFIG.enableNetworkHooks && window.XMLHttpRequest && window.XMLHttpRequest.prototype) {
      const proto = window.XMLHttpRequest.prototype;
      state.originals.xhrOpen = proto.open;
      state.originals.xhrSend = proto.send;
      state.originals.xhrSetHeader = proto.setRequestHeader;

      proto.open = function patchedOpen(method, url, async, user, pass) {
        try {
          this[SYM.xhrMeta] = this[SYM.xhrMeta] || Object.create(null);
          this[SYM.xhrMeta].method = String(method || 'GET');
          this[SYM.xhrMeta].url = safeUrl(url);
          this[SYM.xhrMeta].headers = Object.create(null);
        } catch (_) {}
        return state.originals.xhrOpen.apply(this, arguments);
      };

      proto.setRequestHeader = function patchedSetRequestHeader(k, v) {
        try {
          const m = this[SYM.xhrMeta] || (this[SYM.xhrMeta] = Object.create(null));
          if (!m.headers) m.headers = Object.create(null);
          m.headers[String(k)] = String(v);
        } catch (_) {}
        return state.originals.xhrSetHeader.apply(this, arguments);
      };

      proto.send = function patchedSend(body) {
        const xhr = this;
        const start = now();
        try {
          const m = xhr[SYM.xhrMeta] || (xhr[SYM.xhrMeta] = Object.create(null));
          m.startTime = start;
        } catch (_) {}

        function finalize(kind, err) {
          try {
            const end = now();
            const meta = xhr[SYM.xhrMeta] || {};
            const url = meta.url || '[unknown]';
            const method = meta.method || 'GET';

            const status = (() => { try { return xhr.status; } catch { return -1; } })();
            const ok = status >= 200 && status < 400;

            const evt = {
              type: 'xhr',
              kind: kind || 'xhr',
              url: safeUrl(url),
              method,
              status,
              ok,
              startTime: start,
              endTime: end,
              duration: end - start,
              responseType: xhr.responseType,
              level: err ? 'error' : (ok ? 'info' : 'warn')
            };

            if (err) evt.error = { name: err.name, message: err.message };
            const rt = matchResourceTiming(evt.url, start);
            if (rt) evt.resourceTiming = rt;

            tagNetworkEvent(evt);
          } catch (e) {
            emit('warn', 'Network', 'XHR finalize failed', e);
          }
        }

        xhr.addEventListener('loadend', function () { finalize('xhr'); }, { once: true });
        xhr.addEventListener('error', function (e) { finalize('xhr-error', e || new Error('XHR error')); }, { once: true });
        xhr.addEventListener('abort', function () { finalize('xhr-abort', new Error('XHR abort')); }, { once: true });
        xhr.addEventListener('timeout', function () { finalize('xhr-timeout', new Error('XHR timeout')); }, { once: true });

        return state.originals.xhrSend.apply(this, arguments);
      };
    }

    // sendBeacon
    if (CONFIG.enableNetworkHooks && navigator && typeof navigator.sendBeacon === 'function') {
      state.originals.sendBeacon = navigator.sendBeacon.bind(navigator);

      navigator.sendBeacon = function patchedBeacon(url, data) {
        const start = now();
        const ok = state.originals.sendBeacon(url, data);
        const end = now();

        tagNetworkEvent({
          type: 'beacon',
          kind: 'beacon',
          url: safeUrl(url),
          method: 'POST',
          status: ok ? 204 : -1,
          ok: !!ok,
          startTime: start,
          endTime: end,
          duration: end - start,
          dataSize: (() => {
            try {
              if (typeof data === 'string') return data.length;
              if (data && typeof data.byteLength === 'number') return data.byteLength;
            } catch (_) {}
            return undefined;
          })(),
          level: ok ? 'info' : 'warn'
        });

        return ok;
      };
    }

    // WebSocket
    if (CONFIG.enableNetworkHooks && typeof window.WebSocket === 'function') {
      state.originals.WebSocket = window.WebSocket;

      window.WebSocket = function PatchedWebSocket(url, protocols) {
        const ws = protocols !== undefined
          ? new state.originals.WebSocket(url, protocols)
          : new state.originals.WebSocket(url);

        try {
          ws[SYM.wsMeta] = { url: safeUrl(url), createdAt: now(), sent: 0, received: 0 };
        } catch (_) {}

        ws.addEventListener('open', function () {
          emit('info', 'WebSocket', 'open', { url: safeUrl(url) });
        });

        ws.addEventListener('close', function (e) {
          emit('info', 'WebSocket', 'close', {
            url: safeUrl(url),
            code: e && e.code,
            reason: e && e.reason,
            wasClean: e && e.wasClean
          });
        });

        ws.addEventListener('error', function () {
          emit('warn', 'WebSocket', 'error', { url: safeUrl(url) });
        });

        ws.addEventListener('message', function (e) {
          const meta = ws[SYM.wsMeta];
          if (meta) meta.received++;
          emit('debug', 'WebSocket', 'message', {
            url: safeUrl(url),
            size: (() => {
              try {
                const d = e && e.data;
                if (typeof d === 'string') return d.length;
                if (d && typeof d.byteLength === 'number') return d.byteLength;
              } catch (_) {}
              return undefined;
            })()
          });
        });

        return ws;
      };

      // Preserve static props
      window.WebSocket.prototype = state.originals.WebSocket.prototype;
      window.WebSocket.OPEN = state.originals.WebSocket.OPEN;
      window.WebSocket.CLOSED = state.originals.WebSocket.CLOSED;
      window.WebSocket.CLOSING = state.originals.WebSocket.CLOSING;
      window.WebSocket.CONNECTING = state.originals.WebSocket.CONNECTING;

      // Patch send for size tracking
      try {
        const sendOrig = state.originals.WebSocket.prototype.send;
        state.originals.wsSend = sendOrig;
        state.originals.WebSocket.prototype.send = function patchedWSSend(data) {
          const meta = this[SYM.wsMeta];
          if (meta) meta.sent++;
          emit('debug', 'WebSocket', 'send', {
            url: meta ? meta.url : '[unknown]',
            size: (() => {
              try {
                if (typeof data === 'string') return data.length;
                if (data && typeof data.byteLength === 'number') return data.byteLength;
              } catch (_) {}
              return undefined;
            })()
          });
          return sendOrig.apply(this, arguments);
        };
      } catch (_) {}
    }
  }

  // ---------- NEW: Error hooks ----------

  function setupErrorHooks() {
    if (!CONFIG.enableErrorHooks) return;

    // window.onerror
    const onError = function (msg, src, line, col, err) {
      const ts = now();
      const session = findSessionForTime(ts);

      const payload = {
        type: 'error',
        message: String(msg || 'Error'),
        source: src,
        line: line,
        col: col,
        error: err ? { name: err.name, message: err.message, stack: err.stack } : null,
        time: ts
      };

      if (session) attachToSession(session, 'errors', payload);
      emit('error', 'Error', payload.message, payload, session ? session.id : null);
    };

    window.addEventListener('error', function (e) {
      const ts = now();
      const session = findSessionForTime(ts);
      const err = e && e.error;

      const payload = {
        type: 'error-event',
        message: e && e.message,
        filename: e && e.filename,
        lineno: e && e.lineno,
        colno: e && e.colno,
        error: err ? { name: err.name, message: err.message, stack: err.stack } : null,
        time: ts
      };

      if (session) attachToSession(session, 'errors', payload);
      emit('error', 'Error', 'window error event', payload, session ? session.id : null);
    });

    // Unhandled promise rejections
    window.addEventListener('unhandledrejection', function (e) {
      const ts = now();
      const session = findSessionForTime(ts);

      const r = e && e.reason;
      const payload = {
        type: 'unhandledrejection',
        reason: r ? (typeof r === 'string' ? r : (r.message || String(r))) : 'unknown',
        rawReason: r,
        time: ts
      };

      if (session) attachToSession(session, 'errors', payload);
      emit('error', 'Promise', payload.reason, payload, session ? session.id : null);
    });

    state.globalListeners.push(['error', onError]);
  }

  // ---------- NEW: Navigation hooks ----------

  function setupNavHooks() {
    if (!CONFIG.enableNavHooks) return;

    function logNav(kind, extra) {
      const ts = now();
      const session = findSessionForTime(ts);

      const payload = Object.assign({
        kind,
        href: safeUrl(location.href),
        referrer: safeUrl(document.referrer),
        time: ts
      }, extra || {});

      if (session) attachToSession(session, 'nav', payload);
      emit('info', 'Nav', kind, payload, session ? session.id : null);
    }

    // history.pushState / replaceState
    if (history && typeof history.pushState === 'function') {
      state.originals.pushState = history.pushState.bind(history);
      history.pushState = function patchedPushState(stateObj, title, url) {
        const before = safeUrl(location.href);
        const r = state.originals.pushState.apply(history, arguments);
        const after = safeUrl(location.href);
        logNav('pushState', { before, after, url: safeUrl(url) });
        return r;
      };
    }

    if (history && typeof history.replaceState === 'function') {
      state.originals.replaceState = history.replaceState.bind(history);
      history.replaceState = function patchedReplaceState(stateObj, title, url) {
        const before = safeUrl(location.href);
        const r = state.originals.replaceState.apply(history, arguments);
        const after = safeUrl(location.href);
        logNav('replaceState', { before, after, url: safeUrl(url) });
        return r;
      };
    }

    // popstate / hashchange
    window.addEventListener('popstate', function () {
      logNav('popstate', {});
    });
    window.addEventListener('hashchange', function (e) {
      logNav('hashchange', {
        oldURL: e && e.oldURL,
        newURL: e && e.newURL
      });
    });

    // BFCache-ish lifecycle hooks
    window.addEventListener('pageshow', function (e) {
      logNav('pageshow', { persisted: !!(e && e.persisted) });
    });
    window.addEventListener('pagehide', function (e) {
      logNav('pagehide', { persisted: !!(e && e.persisted) });
    });
  }

  // ---------- Public API ----------

  function init(options) {
    if (state.initialized) return;

    if (typeof window === 'undefined' || typeof document === 'undefined') {
      emit('warn', 'Init', 'Not running in a window+document context; init skipped');
      return;
    }

    // Allow small runtime overrides
    if (options && typeof options === 'object') {
      Object.keys(options).forEach(function (k) {
        if (k in CONFIG) CONFIG[k] = options[k];
      });
    }

    setupDomListeners();
    setupPerformanceObservers();
    setupReportingObserver();
    setupDomObservers();

    if (CONFIG.enableNetworkHooks) setupNetworkHooks();
    if (CONFIG.enableErrorHooks) setupErrorHooks();
    if (CONFIG.enableNavHooks) setupNavHooks();

    state.initialized = true;
    emit('info', 'Init', 'Initialized');
  }

  function stop() {
    removeDomListeners();

    // Disconnect observers
    Object.keys(state.observers).forEach(function (key) {
      const obs = state.observers[key];
      if (!obs) return;
      try {
        if (typeof obs.disconnect === 'function') obs.disconnect();
        if (typeof obs.takeRecords === 'function') obs.takeRecords();
      } catch (_) {}
      state.observers[key] = null;
    });

    // Restore patched globals
    try {
      if (state.originals.fetch) window.fetch = state.originals.fetch;
      if (state.originals.sendBeacon) navigator.sendBeacon = state.originals.sendBeacon;

      if (state.originals.xhrOpen && window.XMLHttpRequest && window.XMLHttpRequest.prototype) {
        const p = window.XMLHttpRequest.prototype;
        p.open = state.originals.xhrOpen;
        p.send = state.originals.xhrSend;
        p.setRequestHeader = state.originals.xhrSetHeader;
      }

      if (state.originals.pushState) history.pushState = state.originals.pushState;
      if (state.originals.replaceState) history.replaceState = state.originals.replaceState;

      if (state.originals.WebSocket) {
        window.WebSocket = state.originals.WebSocket;
        if (state.originals.wsSend && state.originals.WebSocket.prototype) {
          state.originals.WebSocket.prototype.send = state.originals.wsSend;
        }
      }
    } catch (_) {}

    state.initialized = false;
    emit('info', 'Stop', 'Stopped');
  }

  function getState() {
    return {
      initialized: state.initialized,
      config: Object.assign({}, CONFIG),
      interactions: state.interactions.slice(),
      observers: Object.keys(state.observers).filter(function (k) { return !!state.observers[k]; }),
      recentResourcesCount: state.recentResources.length
    };
  }
  // Expose tagNetworkEvent so initLogs interceptors can call in directly if you want.
  return {
    init,
    stop,
    getState,
    tagNetworkEvent
  };
})();
