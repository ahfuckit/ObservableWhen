# <img width="72" height="72" alt="mo1lofac" src="https://github.com/user-attachments/assets/a6344e87-fa18-4934-a940-c9d658ed7940" />  
# InteractionLab & DOMLogger

**Author:** Chris Singendonk  
**Years:** 2023–2026  
**License:** To be determined  
**Copyright:** © 2023  
_All Rights Reserved_

---

## Why This Exists

Modern web applications are complex, dynamic, and opaque.  
**InteractionLab** keeps things clear by providing:

- **structured, session‑based observability**  
- **in‑page logging and visualization**  
- **automatic instrumentation**  
- **zero‑dependency runtime**  
- **developer‑friendly hooks**  
- **a foundation for replay, analytics, or debugging tools**

Meanwhile, browser DevTools — powerful as they are — remain:

- ephemeral  
- not user‑visible  
- not scriptable  
- not session‑aware  
- not embeddable  
- not exportable  

---

## Architecture

This project independently converges on several patterns used by large‑scale production systems.

### ✅ GitHub’s `stats.ts`

GitHub’s telemetry client collects events, enriches them, samples them, batches them, and ships them via `navigator.sendBeacon`.

**InteractionLab parallels:**

- event capture → session capture  
- enrichment (DOM target, viewport, metrics)  
- batching (per session)  
- safe logging  
- flush on interaction end  
- optional export pipeline  

InteractionLab goes further by capturing **full interaction sessions**, not just discrete events.

---

### ✅ GitHub’s `@github/selector-observer`

GitHub uses selector‑observer to declaratively attach behavior to DOM nodes as they appear, change, or disappear.

**InteractionLab parallels:**

- DOM lifecycle tracking  
- MutationObserver batching  
- WeakMap‑based state  
- per‑target metadata  
- safe, non‑intrusive instrumentation  

Where selector‑observer tracks **elements**, InteractionLab tracks **interactions**.

---

### ✅ GitHub’s Bootloader

GitHub’s bootloader initializes:

- telemetry  
- feature flags  
- runtime environment  
- DOM observers  
- page bundles  

**InteractionLab parallels:**

- `InteractionLab.init()`  
- network hooks  
- error hooks  
- performance observers  
- DOM observers  
- navigation hooks  
- configuration flags  

InteractionLab is effectively a **mini bootloader** for observability.

---

## Core Components

### **InteractionLab**  
<sub>The heart of the system. It:</sub>

- Listens for primary user events  
- Starts a new **interaction session**  
- Tracks:
  - DOM target  
  - viewport  
  - visibility  
  - navigation  
  - performance entries  
  - resource timings  
  - network events  
  - errors  
  - reports  
- Computes metrics:
  - INP‑like  
  - LoAF  
  - CLS  
  - LCP count  
  - network durations  
- Closes sessions after a configurable window (default: 4000ms)

---

### **DOMLogger**

A full in‑page logging UI:

- Log panel with expandable entries  
- Copy‑to‑clipboard  
- Remove entry  
- Toast notifications  
- Theme support  
- Filtering  
- Persistent log buffer  
- Console fallback  

DOMLogger acts as the **visual layer** for InteractionLab.

---

## Key Features

### ✅ Session‑based Observability

Every interaction is grouped into a structured session with:

- start/end time  
- DOM target summary  
- performance metrics  
- network events  
- errors  
- DOM visibility  
- navigation events  

### ✅ Network Instrumentation

Correlates network events with resource timing entries.

### ✅ Observers

- `MutationObserver`  
- `IntersectionObserver`  
- `ResizeObserver`  
- `PerformanceObserver`  
- `ReportingObserver`

### ✅ Error & Navigation Hooks

Captures:

- `window.onerror`  
- `unhandledrejection`  
- `pushState` / `replaceState`  
- `popstate`  
- `hashchange`  

---

## Configuration

InteractionLab exposes a `CONFIG` object with toggles for:

- network hooks  
- error hooks  
- navigation hooks  
- resource timing  
- console adapter  
- noise control  
- max stored interactions  
- interaction window duration  

---

## Roadmap

This system is designed to evolve into:

- a full telemetry export pipeline  
- a plugin system  
- a replay engine  
- a session explorer UI  
- a browser extension wrapper  
- an OpenTelemetry‑compatible exporter  

---

## Status
The architecture is **stable**, the instrumentation is **robust**, and the UI is **functional**.
Use by including the script within your own frontend, or run interactionLab in the devtools console to begin observing any website!

Feel free to try it out!
---

## Author

**Chris Singendonk**

If this project helps you, inspires you, or you build something cool with it — I’d love to hear about it.

GitHub: https://github.com/ahfuckit  
LinkedIn: Chris Singendonk
