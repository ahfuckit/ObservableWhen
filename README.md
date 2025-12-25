<img width="72" height="72" alt="mo1lofac" src="https://github.com/user-attachments/assets/a6344e87-fa18-4934-a940-c9d658ed7940" /> InteractionLab & DOMLogger
Author: Chris Singendonk
Years: 2023–2026
License: TBD
Copyright: © 2023

# Overview

**Modern web apps are complex and opaque. InteractionLab provides a lightweight way to observe and understand them with**:

Session‑based observability
Configurable logging & visualization

Automatic/custom instrumentation

Zero‑dependency, browser‑agnostic runtime

Hooks for replay, analytics, debugging, and monitoring

Unlike many RUM/devtools, it’s portable, scriptable, session‑aware, and free.

Architecture
InteractionLab acts as a mini bootloader for observability:

Captures & enriches events (DOM, viewport, metrics)

Groups into sessions with batching & safe logging

Tracks lifecycle, navigation, performance, network, and errors

Exposes feature flags & configuration options

Supports optional export pipelines

Components
InteractionLab
Starts/stops sessions around user interactions

Tracks DOM, navigation, performance, network, and error data

Computes metrics (INP‑like, CLS, LCP, durations)

DOMLogger
Optional client‑side UI for visualizing logs

Hooks into any logging framework

Key Features
✅ Structured sessions with events, metrics, network, errors, visibility, navigation

⚙️ Configurable via CONFIG (hooks, timing, console adapter, noise control, limits)

Roadmap
Planned evolution:

Telemetry export pipeline

Plugin system

Replay engine

Session explorer UI

Browser extension wrapper

OpenTelemetry exporter

Status
Architecture is stable, instrumentation robust, UI functional.
Include the script in your frontend or run interactionLab in devtools to start observing.

Author
Chris Singendonk  
GitHub: https://github.com/ahfuckit
LinkedIn: Chris Singendonk
