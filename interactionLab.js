/**
*@Copyright 2025 Chris Singendonk
*/
// InteractionLab v2.1.0: UX observable-interaction lab for Chromium based browsers
const InteractionLab = (function () {
  'use strict';

  // Reuse existing instance if injected twice (prevents double patching)
  const GLOBAL_KEY = '__InteractionLab__';
  try {
    if (typeof window !== 'undefined' && window[GLOBAL_KEY] && window[GLOBAL_KEY].version) {
      return window[GLOBAL_KEY];
    }
  } catch (_) {}

  // ---------- Config / State ----------

  const DEFAULTS = {
    interactionWindowMs: 4000,
    maxStoredInteractions: 50,
    primaryEvents: ['click', 'pointerup', 'keydown', 'submit'],
    enableNetworkHooks: true,    
    enableErrorHooks: true,      
    enableNavHooks: true,
    enableResourceTimings: true,
    enableConsoleAdapter: false,
    logResourceEntriesToConsole: false,
    maxRecentResources: 250,
    resourceMatchWindowMs: 250, 
    minResourceDurationMs: 0,
    // policy decisions (kept inert by default)
    // networkDecision: (evt) => ({ allow: true }) 
    // return {allow:false, reason:"..."} to block
    networkDecision: null,
    // cap stored details to avoid balloon sessions on noisy pages
    maxPerfEntriesPerSession: 500,
    maxConsoleEntriesPerSession: 200
  };

  const CONFIG = Object.assign({}, DEFAULTS);

  const state = {
    initialized: false,
    listenersAttached: false,
    interactions: [],
    sessionsById: Object.create(null),
    observers: Object.create(null),
    lastSessionId: null,
    recentResources: [],
    originals: Object.create(null),
    globalListeners: [],
    inConsoleHook: false
  };

  const SYM = {
    xhrMeta: (typeof Symbol !== 'undefined') ? Symbol('IL_XHR_META') : '__IL_XHR_META__',
    wsMeta: (typeof Symbol !== 'undefined') ? Symbol('IL_WS_META') : '__IL_WS_META__'
  };
  
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

  function toAbsUrl(u) {
    const s = safeUrl(u);
    try { return new URL(s, location.href).href; } catch { return s; }
  }

  function buildSelector(el, maxDepth) {
    maxDepth = (typeof maxDepth === 'number') ? maxDepth : 4;
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
    try { console.debug.apply(console, arguments); } catch (_) {}
  }

  function addGlobalListener(target, type, handler, opts) {
    if (!target || !target.addEventListener) return;
    try {
      target.addEventListener(type, handler, opts);
      state.globalListeners.push({ target, type, handler, opts: opts || false });
    } catch (_) {}
  }

  function removeGlobalListeners() {
    for (let i = state.globalListeners.length - 1; i >= 0; i--) {
      const rec = state.globalListeners[i];
      try { rec.target.removeEventListener(rec.type, rec.handler, rec.opts); } catch (_) {}
    }
    state.globalListeners.length = 0;
  }

  function clampArray(arr, max) {
    if (!arr || !arr.length) return;
    if (arr.length > max) arr.splice(0, arr.length - max);
  }

  function safeSerializeArg(v) {
    try {
      if (v === null) return { t: 'null', v: null };
      const t = typeof v;
      if (t === 'string') return { t: 'string', v: v.length > 2000 ? v.slice(0, 2000) + '…' : v };
      if (t === 'number' || t === 'boolean' || t === 'bigint') return { t, v: String(v) };
      if (t === 'undefined') return { t: 'undefined' };
      if (t === 'function') return { t: 'function', v: (v.name || '(anonymous)') };
      if (v instanceof Error) return { t: 'Error', v: { name: v.name, message: v.message, stack: v.stack } };
      const ctor = v && v.constructor && v.constructor.name ? v.constructor.name : 'Object';
      return { t: ctor, v: String(v) };
    } catch (e) {
      return { t: 'unserializable', v: String(e && e.message || e) };
    }
  }
    const prefix = `[InteractionLab][${tag}]`;
    if (!console) return;
    const c = state.originals.console || console;
    const fn =
      level === 'error' ? (c.error || console.error) :
      level === 'warn'  ? (c.warn  || console.warn)  :
      level === 'info'  ? (c.info  || console.info)  :
      level === 'debug' ? (c.debug || console.debug || console.log) :
                          (c.log   || console.log);
    try {
      if (details !== undefined) fn.call(console, prefix, message, details);
      else fn.call(console, prefix, message);
    } catch {
      try { console.log(prefix, message); } catch (_) {}
    }
  }
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
        key: (ev.type && ev.type.indexOf('key') === 0) ? ev.key : undefined,
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
      console: [],
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
      if (old) {
        try { if (old.timeoutHandle) clearTimeout(old.timeoutHandle); } catch (_) {}
        // Unobserve old target to avoid observer growth
        try {
          if (old._targetNode && state.observers.intersection && state.observers.intersection.unobserve) {
            state.observers.intersection.unobserve(old._targetNode);
          }
          if (old._targetNode && state.observers.resize && state.observers.resize.unobserve) {
            state.observers.resize.unobserve(old._targetNode);
          }
        } catch (_) {}
        delete state.sessionsById[old.id];
      }
    }
    state.lastSessionId = id;
    try {
      console.groupCollapsed(
        `%c[InteractionStart]%c ${ev.type} on ${targetInfo.selector}`,
        'color:#4caf50;font-weight:bold;',
        'color:inherit;'
      );
      console.log('Session', session);
      console.groupEnd();
    } catch (_) {}
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
    try { if (session.timeoutHandle) clearTimeout(session.timeoutHandle); } catch (_) {}
    session.timeoutHandle = null;
    try {
      if (session._targetNode && state.observers.intersection && state.observers.intersection.unobserve) {
        state.observers.intersection.unobserve(session._targetNode);
      }
      if (session._targetNode && state.observers.resize && state.observers.resize.unobserve) {
        state.observers.resize.unobserve(session._targetNode);
      }
    } catch (_) {}
    const m = session.metrics;
    const inp = Math.round(m.inpLike || 0);
    const loaf = Math.round(m.maxLoafMs || 0);
    const cls = m.totalCls || 0;
    const netCount = session.network.length;
    const lcpCount = session.perf.lcpEntries.length;
    try {
      console.groupCollapsed(
        `%c[InteractionSummary]%c ${session.domEvent.type} on ${session.domEvent.target.selector}  ` +
        `→ INP≈${inp}ms, LoAF max ${loaf}ms, CLS ${cls.toFixed(3)}, net ${netCount}, LCPs ${lcpCount}`,
        'color:#2196f3;font-weight:bold;',
        'color:inherit;'
      );
      console.log('Full session', session);
      console.groupEnd();
    } catch (_) {}
  }
  const domHandlers = [];

  function setupDomListeners() {
    if (state.listenersAttached) return;
    if (typeof document === 'undefined') return;
    CONFIG.primaryEvents.forEach(function (type) {
      const handler = function (ev) {
        try { startInteractionFromEvent(ev); }
        catch (e) { emit('error', 'DOM', 'Error in interaction handler', e); }
      };
      document.addEventListener(type, handler, true);
      domHandlers.push({ type, handler });
    });
    state.listenersAttached = true;
    logDebug('[InteractionLab] DOM interaction listeners attached');
  }

  function removeDomListeners() {
    if (!state.listenersAttached || typeof document === 'undefined') return;
    domHandlers.forEach(function (h) { document.removeEventListener(h.type, h.handler, true); });
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
          const entries = list.getEntries();
          for (let i = 0; i < entries.length; i++) cb(entries[i]);
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
        clampArray(session.perf.eventTimings, CONFIG.maxPerfEntriesPerSession);
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
        clampArray(session.perf.longAnimationFrames, CONFIG.maxPerfEntriesPerSession);
        const d = entry.duration || 0;
        session.metrics.maxLoafMs = Math.max(session.metrics.maxLoafMs || 0, d);
      }
      emit('debug', 'LoAF', 'long-animation-frame', entry, session ? session.id : null);
    });

    // Long Tasks
    state.observers.longtask = observeType('longtask', function (entry) {
      const session = findSessionForTime(entry.startTime);
      if (session) {
        session.perf.longTasks.push(entry);
        clampArray(session.perf.longTasks, CONFIG.maxPerfEntriesPerSession);
      }
      emit('debug', 'LongTask', 'longtask', entry, session ? session.id : null);
    });

    // Layout shift (CLS)
    state.observers.layoutShift = observeType('layout-shift', function (entry) {
      if (entry && !entry.hadRecentInput) {
        const session = findSessionForTime(entry.startTime);
        if (session) {
          session.perf.layoutShifts.push(entry);
          clampArray(session.perf.layoutShifts, CONFIG.maxPerfEntriesPerSession);
          session.metrics.totalCls = (session.metrics.totalCls || 0) + (entry.value || 0);
        }
        emit('debug', 'CLS', 'layout-shift', entry, session ? session.id : null);
      }
    });

    state.observers.lcp = observeType('largest-contentful-paint', function (entry) {
      const session = findSessionForTime(entry.startTime);
      if (session) {
        session.perf.lcpEntries.push(entry);
        clampArray(session.perf.lcpEntries, CONFIG.maxPerfEntriesPerSession);
      }
      emit('debug', 'LCP', 'largest-contentful-paint', entry, session ? session.id : null);
    });

    // Paint (first-paint / first-contentful-paint)
    state.observers.paint = observeType('paint', function (entry) {
      const session = findSessionForTime(entry.startTime);
      if (session) {
        session.perf.paints.push(entry);
        clampArray(session.perf.paints, CONFIG.maxPerfEntriesPerSession);
      }
      emit('debug', 'Paint', entry.name || 'paint', entry, session ? session.id : null);
    });

    // Navigation timings
    state.observers.navigation = observeType('navigation', function (entry) {
      const session = findSessionForTime(entry.startTime);
      if (session) {
        session.perf.navigation.push(entry);
        clampArray(session.perf.navigation, CONFIG.maxPerfEntriesPerSession);
      }
      emit('info', 'NavigationTiming', 'navigation', entry, session ? session.id : null);
    });

    // Resource timings
    if (CONFIG.enableResourceTimings) {
      state.observers.resource = observeType('resource', function (entry) {
        if ((entry.duration || 0) < CONFIG.minResourceDurationMs) return;

        const simplified = {
          name: toAbsUrl(entry.name),
          initiatorType: entry.initiatorType,
          startTime: entry.startTime,
          duration: entry.duration,
          transferSize: entry.transferSize,
          encodedBodySize: entry.encodedBodySize,
          decodedBodySize: entry.decodedBodySize,
          nextHopProtocol: entry.nextHopProtocol
        };

        state.recentResources.push(simplified);
        if (state.recentResources.length > CONFIG.maxRecentResources) state.recentResources.shift();

        const session = findSessionForTime(entry.startTime);
        if (session) {
          session.perf.resources.push(simplified);
          clampArray(session.perf.resources, CONFIG.maxPerfEntriesPerSession);
        }

        if (CONFIG.logResourceEntriesToConsole) {
          emit('debug', 'Resource', simplified.initiatorType || 'resource', simplified, session ? session.id : null);
        }
      });
    }

    // Snapshot current navigation entry immediately
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
        for (let i = 0; i < reports.length; i++) {
          const report = reports[i];
          const ts = now();
          const session = findSessionForTime(ts);
          if (session) {
            session.reports.push(report);
            clampArray(session.reports, CONFIG.maxPerfEntriesPerSession);
          }
          emit('warn', 'ReportingObserver', report.type, report, session ? session.id : null);
        }
      }, { types: ['deprecation', 'intervention'], buffered: true });

      ro.observe();
      state.observers.reporting = ro;
    } catch (e) {
      emit('warn', 'ReportingObserver', 'Failed to create ReportingObserver', e);
    }
  }

  // ---------- Intersection / Resize / Mutation ----------

  function setupDomObservers() {
    if (typeof window === 'undefined') return;

    // Intersection
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver(function (entries) {
        for (let j = 0; j < entries.length; j++) {
          const entry = entries[j];
          // find most recent session for this node
          for (let i = state.interactions.length - 1; i >= 0; i--) {
            const s = state.interactions[i];
            if (s && s._targetNode === entry.target) {
              s.visibility = { isIntersecting: entry.isIntersecting, ratio: entry.intersectionRatio, time: now() };
              break;
            }
          }
          emit('debug', 'Intersection', 'entry', {
            target: summarizeTarget(entry.target),
            isIntersecting: entry.isIntersecting,
            ratio: entry.intersectionRatio
          });
        }
      });
      state.observers.intersection = io;
    }

    // Resize
    if ('ResizeObserver' in window) {
      const ro = new ResizeObserver(function (entries) {
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          emit('debug', 'Resize', 'entry', {
            target: summarizeTarget(entry.target),
            rect: entry.contentRect
          });
        }
      });
      state.observers.resize = ro;
      try { ro.observe(document.body); } catch (_) {}
    }

    // Mutation (throttled)
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

  // ---------- Network hooks (fetch / XHR / beacon / WebSocket) ----------

  function matchResourceTiming(url, startTime) {
    const u = toAbsUrl(url);
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
      // bail if we’ve already got a good match and we're drifting further away
      if (bestDelta <= CONFIG.resourceMatchWindowMs && delta > bestDelta + CONFIG.resourceMatchWindowMs) break;
    }

    return (best && bestDelta <= CONFIG.resourceMatchWindowMs) ? best : null;
  }

  function applyNetworkDecision(evt) {
    const decider = CONFIG.networkDecision;
    if (typeof decider !== 'function') return { allow: true };
    try {
      const r = decider(evt);
      if (r && typeof r.allow === 'boolean') return r;
      return { allow: true };
    } catch (e) {
      emit('warn', 'Network', 'networkDecision threw; defaulting allow', e);
      return { allow: true };
    }
  }

  function tagNetworkEvent(evt) {
    const ts = (evt && typeof evt.startTime === 'number') ? evt.startTime : now();
    const session = findSessionForTime(ts);

    if (session) {
      session.network.push(evt);
      session.metrics.netCount = session.network.length;
      session.metrics.netMaxMs = Math.max(session.metrics.netMaxMs || 0, evt.duration || 0);
      clampArray(session.network, CONFIG.maxPerfEntriesPerSession);
    }

    emit(evt.level || 'info', 'Network', evt.kind || evt.type || 'network', evt, session ? session.id : null);
    return session ? session.id : null;
  }

  function setupNetworkHooks() {
    if (!CONFIG.enableNetworkHooks || typeof window === 'undefined') return;

    // fetch
    if (typeof window.fetch === 'function') {
      state.originals.fetch = window.fetch;

      window.fetch = function patchedFetch(input, init) {
        const start = now();
        const rawUrl = (typeof input === 'string') ? input : (input && input.url) || '';
        const url = toAbsUrl(rawUrl);
        const method = (init && init.method) || (input && input.method) || 'GET';

        const preEvt = {
          type: 'fetch',
          kind: 'fetch-start',
          url,
          method: String(method || 'GET'),
          startTime: start,
          level: 'debug'
        };

        const decision = applyNetworkDecision(preEvt);
        if (decision && decision.allow === false) {
          const end = now();
          const blocked = Object.assign({}, preEvt, {
            kind: 'fetch-blocked',
            endTime: end,
            duration: end - start,
            ok: false,
            status: 0,
            level: 'warn',
            blocked: true,
            reason: decision.reason || 'blocked'
          });
          tagNetworkEvent(blocked);
          // Mimic a network failure without throwing synchronously
          return Promise.resolve(new Response(null, { status: 403, statusText: 'Blocked by policy' }));
        }

        return state.originals.fetch.apply(this, arguments).then(function (res) {
          const end = now();
          const evt = {
            type: 'fetch',
            kind: 'fetch',
            url,
            method: String(method || 'GET'),
            status: (res && typeof res.status === 'number') ? res.status : -1,
            ok: !!(res && res.ok),
            startTime: start,
            endTime: end,
            duration: end - start,
            redirected: !!(res && res.redirected),
            responseType: res && res.type,
            contentLength: (() => {
              try { return res && res.headers && res.headers.get('content-length'); } catch (_) { return undefined; }
            })(),
            level: (res && res.ok) ? 'info' : 'warn'
          };

          const rt = matchResourceTiming(url, start);
          if (rt) evt.resourceTiming = rt;

          tagNetworkEvent(evt);
          return res;
        }).catch(function (err) {
          const end = now();
          const evt = {
            type: 'fetch',
            kind: 'fetch-error',
            url,
            method: String(method || 'GET'),
            status: -1,
            ok: false,
            startTime: start,
            endTime: end,
            duration: end - start,
            error: { name: err && err.name, message: err && err.message, stack: err && err.stack },
            level: 'error'
          };

          const rt = matchResourceTiming(url, start);
          if (rt) evt.resourceTiming = rt;

          tagNetworkEvent(evt);
          throw err;
        });
      };
    }

    // XHR
    if (window.XMLHttpRequest && window.XMLHttpRequest.prototype) {
      const proto = window.XMLHttpRequest.prototype;
      state.originals.xhrOpen = proto.open;
      state.originals.xhrSend = proto.send;
      state.originals.xhrSetHeader = proto.setRequestHeader;

      proto.open = function patchedOpen(method, url, async, user, pass) {
        try {
          this[SYM.xhrMeta] = this[SYM.xhrMeta] || Object.create(null);
          this[SYM.xhrMeta].method = String(method || 'GET');
          this[SYM.xhrMeta].urlRaw = safeUrl(url);
          this[SYM.xhrMeta].url = toAbsUrl(url);
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

        const meta = xhr[SYM.xhrMeta] || (xhr[SYM.xhrMeta] = Object.create(null));
        meta.startTime = start;

        const url = meta.url || '[unknown]';
        const method = meta.method || 'GET';

        const preEvt = { type: 'xhr', kind: 'xhr-start', url, method, startTime: start, level: 'debug' };
        const decision = applyNetworkDecision(preEvt);

        if (decision && decision.allow === false) {
          // Abort early
          try { xhr.abort(); } catch (_) {}
          const end = now();
          tagNetworkEvent({
            type: 'xhr',
            kind: 'xhr-blocked',
            url,
            method,
            startTime: start,
            endTime: end,
            duration: end - start,
            status: 0,
            ok: false,
            blocked: true,
            reason: decision.reason || 'blocked',
            level: 'warn'
          });
          return;
        }

        function finalize(kind, errLike) {
          try {
            const end = now();
            const status = (() => { try { return xhr.status; } catch { return -1; } })();
            const ok = status >= 200 && status < 400;

            const evt = {
              type: 'xhr',
              kind: kind || 'xhr',
              url,
              method,
              status,
              ok,
              startTime: start,
              endTime: end,
              duration: end - start,
              responseType: xhr.responseType,
              responseURL: (() => { try { return xhr.responseURL; } catch { return undefined; } })(),
              requestHeaders: meta.headers || undefined,
              responseHeaders: (() => {
                try { return xhr.getAllResponseHeaders ? xhr.getAllResponseHeaders() : undefined; } catch (_) { return undefined; }
              })(),
              level: errLike ? 'error' : (ok ? 'info' : 'warn')
            };

            if (errLike) {
              // errLike might be Error or ProgressEvent; normalize
              evt.error = (errLike instanceof Error)
                ? { name: errLike.name, message: errLike.message, stack: errLike.stack }
                : { name: 'XHR', message: 'XHR error/abort/timeout', detail: safeSerializeArg(errLike) };
            }

            const rt = matchResourceTiming(url, start);
            if (rt) evt.resourceTiming = rt;

            tagNetworkEvent(evt);
          } catch (e) {
            emit('warn', 'Network', 'XHR finalize failed', e);
          }
        }

        xhr.addEventListener('loadend', function () { finalize('xhr'); }, { once: true });
        xhr.addEventListener('error', function (e) { finalize('xhr-error', e || new Error('XHR error')); }, { once: true });
        xhr.addEventListener('abort', function (e) { finalize('xhr-abort', e || new Error('XHR abort')); }, { once: true });
        xhr.addEventListener('timeout', function (e) { finalize('xhr-timeout', e || new Error('XHR timeout')); }, { once: true });

        return state.originals.xhrSend.apply(this, arguments);
      };
    }

    // sendBeacon
    if (navigator && typeof navigator.sendBeacon === 'function') {
      state.originals.sendBeacon = navigator.sendBeacon.bind(navigator);

      navigator.sendBeacon = function patchedBeacon(url, data) {
        const start = now();
        const abs = toAbsUrl(url);

        const decision = applyNetworkDecision({ type: 'beacon', kind: 'beacon-start', url: abs, method: 'POST', startTime: start, level: 'debug' });
        if (decision && decision.allow === false) {
          const end = now();
          tagNetworkEvent({
            type: 'beacon',
            kind: 'beacon-blocked',
            url: abs,
            method: 'POST',
            status: 0,
            ok: false,
            startTime: start,
            endTime: end,
            duration: end - start,
            blocked: true,
            reason: decision.reason || 'blocked',
            level: 'warn'
          });
          return false;
        }

        const ok = state.originals.sendBeacon(url, data);
        const end = now();

        tagNetworkEvent({
          type: 'beacon',
          kind: 'beacon',
          url: abs,
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
    if (typeof window.WebSocket === 'function') {
      state.originals.WebSocket = window.WebSocket;

      window.WebSocket = function PatchedWebSocket(url, protocols) {
        const abs = toAbsUrl(url);
        const start = now();

        const decision = applyNetworkDecision({ type: 'ws', kind: 'ws-start', url: abs, startTime: start, level: 'debug' });
        if (decision && decision.allow === false) {
          tagNetworkEvent({
            type: 'ws',
            kind: 'ws-blocked',
            url: abs,
            startTime: start,
            endTime: now(),
            duration: 0,
            ok: false,
            blocked: true,
            reason: decision.reason || 'blocked',
            level: 'warn'
          });
          // Create a socket that errors immediately
          const dummy = { addEventListener() {}, removeEventListener() {}, close() {} };
          return dummy;
        }

        const ws = (protocols !== undefined)
          ? new state.originals.WebSocket(url, protocols)
          : new state.originals.WebSocket(url);

        try { ws[SYM.wsMeta] = { url: abs, createdAt: now(), sent: 0, received: 0 }; } catch (_) {}

        ws.addEventListener('open', function () {
          emit('info', 'WebSocket', 'open', { url: abs });
          tagNetworkEvent({ type: 'ws', kind: 'ws-open', url: abs, startTime: now(), endTime: now(), duration: 0, ok: true, level: 'info' });
        });

        ws.addEventListener('close', function (e) {
          emit('info', 'WebSocket', 'close', { url: abs, code: e && e.code, reason: e && e.reason, wasClean: e && e.wasClean });
          tagNetworkEvent({ type: 'ws', kind: 'ws-close', url: abs, startTime: now(), endTime: now(), duration: 0, ok: true, level: 'info', code: e && e.code });
        });

        ws.addEventListener('error', function () {
          emit('warn', 'WebSocket', 'error', { url: abs });
          tagNetworkEvent({ type: 'ws', kind: 'ws-error', url: abs, startTime: now(), endTime: now(), duration: 0, ok: false, level: 'warn' });
        });

        ws.addEventListener('message', function (e) {
          const meta = ws[SYM.wsMeta];
          if (meta) meta.received++;
          const size = (() => {
            try {
              const d = e && e.data;
              if (typeof d === 'string') return d.length;
              if (d && typeof d.byteLength === 'number') return d.byteLength;
            } catch (_) {}
            return undefined;
          })();

          emit('debug', 'WebSocket', 'message', { url: abs, size });
          tagNetworkEvent({ type: 'ws', kind: 'ws-message', url: abs, startTime: now(), endTime: now(), duration: 0, ok: true, level: 'debug', size });
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
          const size = (() => {
            try {
              if (typeof data === 'string') return data.length;
              if (data && typeof data.byteLength === 'number') return data.byteLength;
            } catch (_) {}
            return undefined;
          })();

          emit('debug', 'WebSocket', 'send', { url: meta ? meta.url : '[unknown]', size });
          tagNetworkEvent({ type: 'ws', kind: 'ws-send', url: meta ? meta.url : '[unknown]', startTime: now(), endTime: now(), duration: 0, ok: true, level: 'debug', size });

          return sendOrig.apply(this, arguments);
        };
      } catch (_) {}
    }
  }

  // ---------- Error hooks ----------

  function setupErrorHooks() {
    if (!CONFIG.enableErrorHooks || typeof window === 'undefined') return;

    // window.onerror (property-style)
    state.originals.onerror = window.onerror;
    window.onerror = function (msg, src, line, col, err) {
      const ts = now();
      const session = findSessionForTime(ts);

      const payload = {
        type: 'onerror',
        message: String(msg || 'Error'),
        source: src,
        line: line,
        col: col,
        error: err ? { name: err.name, message: err.message, stack: err.stack } : null,
        time: ts
      };

      if (session) attachToSession(session, 'errors', payload);
      emit('error', 'Error', payload.message, payload, session ? session.id : null);

      try { if (typeof state.originals.onerror === 'function') return state.originals.onerror.apply(this, arguments); } catch (_) {}
      return false;
    };

    // window 'error' event
    const onErrorEvent = function (e) {
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
    };

    // Unhandled promise rejections
    const onUnhandled = function (e) {
      const ts = now();
      const session = findSessionForTime(ts);

      const r = e && e.reason;
      const payload = {
        type: 'unhandledrejection',
        reason: r ? (typeof r === 'string' ? r : (r.message || String(r))) : 'unknown',
        rawReason: safeSerializeArg(r),
        time: ts
      };

      if (session) attachToSession(session, 'errors', payload);
      emit('error', 'Promise', payload.reason, payload, session ? session.id : null);
    };

    addGlobalListener(window, 'error', onErrorEvent, true);
    addGlobalListener(window, 'unhandledrejection', onUnhandled, true);
  }

  // ---------- Navigation hooks ----------

  function setupNavHooks() {
    if (!CONFIG.enableNavHooks || typeof window === 'undefined') return;

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

    const onPop = function () { logNav('popstate', {}); };
    const onHash = function (e) { logNav('hashchange', { oldURL: e && e.oldURL, newURL: e && e.newURL }); };
    const onShow = function (e) { logNav('pageshow', { persisted: !!(e && e.persisted) }); };
    const onHide = function (e) { logNav('pagehide', { persisted: !!(e && e.persisted) }); };

    addGlobalListener(window, 'popstate', onPop, true);
    addGlobalListener(window, 'hashchange', onHash, true);
    addGlobalListener(window, 'pageshow', onShow, true);
    addGlobalListener(window, 'pagehide', onHide, true);
  }

  // ---------- Console adapter ----------

  function setupConsoleAdapter() {
    if (!CONFIG.enableConsoleAdapter || typeof console === 'undefined') return;

    // Wrap once
    if (state.originals.console) return;

    // Capture original console fns
    const orig = state.originals.console = {
      log: console.log ? console.log.bind(console) : null,
      info: console.info ? console.info.bind(console) : null,
      warn: console.warn ? console.warn.bind(console) : null,
      error: console.error ? console.error.bind(console) : null,
      debug: console.debug ? console.debug.bind(console) : null
    };

    function wrap(level) {
      const origFn = orig[level] || orig.log;
      if (!origFn) return;

      console[level] = function () {
        // Always preserve DevTools output
        try { origFn.apply(console, arguments); } catch (_) {}

        // Avoid recursive console events if something below logs
        if (state.inConsoleHook) return;

        state.inConsoleHook = true;
        try {
          const ts = now();
          const session = findSessionForTime(ts);

          const entry = {
            type: 'console',
            level,
            time: ts,
            wallTime: wallTimeISO(),
            args: Array.prototype.map.call(arguments, safeSerializeArg)
          };

          if (session) {
            session.console.push(entry);
            clampArray(session.console, CONFIG.maxConsoleEntriesPerSession);
          }

          // Optional: forward into DOMLogger without using console again
          try {
            if (window.DOMLogger && typeof window.DOMLogger.addLog === 'function') {
              window.DOMLogger.addLog({
                type: 'Console',
                message: level,
                timestamp: entry.wallTime,
                interactionId: session ? session.id : null,
                details: entry
              });
            }
          } catch (_) {}
        } finally {
          state.inConsoleHook = false;
        }
      };
    }

    wrap('log');
    wrap('info');
    wrap('warn');
    wrap('error');
    if (console.debug) wrap('debug');
  }

  function teardownConsoleAdapter() {
    const orig = state.originals.console;
    if (!orig) return;
    try {
      if (orig.log) console.log = orig.log;
      if (orig.info) console.info = orig.info;
      if (orig.warn) console.warn = orig.warn;
      if (orig.error) console.error = orig.error;
      if (orig.debug) console.debug = orig.debug;
    } catch (_) {}
    state.originals.console = null;
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

    setupConsoleAdapter();
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
    // Close any still-open sessions
    for (let i = 0; i < state.interactions.length; i++) {
      const s = state.interactions[i];
      if (s && s.endTime === null) closeInteraction(s.id);
    }

    removeDomListeners();
    removeGlobalListeners();

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

      if ('onerror' in window) window.onerror = state.originals.onerror || null;
    } catch (_) {}

    teardownConsoleAdapter();

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

  const api = {
    version: '2.1.0',
    init,
    stop,
    getState,
    tagNetworkEvent,
    closeInteraction
  };

  try { if (typeof window !== 'undefined') window[GLOBAL_KEY] = api; } catch (_) {}

  return api;
})();
