# Relay Roadmap

## Goal

Strengthen Relay in the order that gives the highest operational value first:

1. **Observability** — know what happened, where, and why
2. **Reliability** — prevent stuck/lost/duplicated work
3. **Architecture** — refactor only after runtime behavior is visible and stable

This roadmap assumes the current architecture stays in place:

- `@RiGHT_AI_BoT` = visible Telegram bot
- `session-driver` = orchestrator / dispatcher
- `@Cody_Code_bot` / Claude Code = internal execution engine

---

## Phase 1 — Observability + reliability baseline

### Objective
Make every topic/session explainable and debuggable without tmux archaeology.

### Priority outcomes
- know whether a session is **up / stuck / degraded / down**
- know whether a message was **queued / consumed / answered / failed**
- know when output was cleaned, downgraded, retried, or quarantined
- be able to inspect and replay failures safely

### 1. Session health model
Add explicit runtime states per session:

- `up`
- `stuck`
- `degraded`
- `down`

#### Signals to use
- queue depth
- queue age
- `lastId` progression
- last inbound timestamp
- last outbound timestamp
- send failures / fallback count
- parse-mode downgrade count
- repeated same-output/no-output situations
- tmux/process alive vs actual work progressing

#### Deliverables
- health evaluator in runtime or support script
- per-session health summary command / endpoint
- degraded/stuck reason string, not only boolean state

---

### 2. Correlation IDs and audit trail
Introduce a single correlation ID for each inbound message flow.

Track:
- inbound receive
- queue write
- queue consume
- dispatch to model
- response extraction
- cleanup/fallback events
- outbound send
- final ack

#### Deliverables
- JSONL audit stream per session or global audit log
- correlation id included in all relevant log lines
- basic inspection tooling for "show message journey"

---

### 3. Dead-letter / quarantine path
Do not silently lose or blur failed work.

Add explicit buckets for:
- failed send
- failed parse
- ignored system traffic
- quarantined suspicious payloads

#### Deliverables
- dead-letter directory or store
- replay-safe format
- reason codes for each quarantined item
- simple replay command/script for operator use

---

### 4. Debug / inspect / replay tools
Make runtime state operator-friendly.

#### Suggested commands
- `relay inspect session <name>`
- `relay inspect topic <thread_id>`
- `relay queue tail <thread_id>`
- `relay replay message <id>`
- `relay explain-routing <thread_id>`

#### Deliverables
- scripts or CLI wrappers for the above
- outputs that do not require reading raw queue files manually

---

### 5. Delivery idempotency
Prevent double replies when send succeeds but state update does not.

#### Deliverables
- outbound delivery record keyed by inbound id / correlation id
- safe retry logic
- duplicate prevention on driver restart

---

## Phase 2 — Runtime hardening

### Objective
Reduce human intervention when sessions go weird.

### 1. Startup phases
Separate bootstrap noise from user work.

Proposed phases:
1. `boot`
2. `warmup`
3. `ready`
4. `consume`

Only `consume` may process real user traffic.

#### Deliverables
- explicit startup state
- startup logs separate from user-message processing
- no validator/system/startup junk entering normal queue flow

---

### 2. Output contract tightening
Move from cleanup-heavy behavior toward a stricter response contract.

Instead of trusting arbitrary terminal-like output, prefer a small response envelope such as:
- final text
- reply target
- optional operator note
- optional delivery mode

#### Deliverables
- internal response contract definition
- extractor adapted to prefer structured output when available
- fallback cleaning retained only as compatibility layer

---

### 3. Auto-remediation
Once health signals are trustworthy, recover automatically from known failure classes.

Examples:
- queue not progressing for N minutes → soft restart driver
- repeated send parse failure → temporary plain-text downgrade
- dirty restore detection → isolate, clear stale state, restart
- process alive but no consume loop progress → restart session-driver only

#### Deliverables
- bounded retry policies
- remediation reason logs
- cooldowns to avoid restart loops

---

## Phase 3 — Architecture cleanup

### Objective
Replace fragile file-scattered runtime state with cleaner primitives.

### 1. State store upgrade
Move from scattered queue/state files toward a stronger state backend.

Recommended incremental target:
- **SQLite (WAL mode)** first

Benefits:
- durable queue state
- replay support
- dead-letter support
- ack semantics
- easier inspection
- less forensic work across many files

---

### 2. Separate control plane from data plane
#### Control plane
- topic/session mapping
- health
- orchestration
- deploy/restart
- audit

#### Data plane
- inbound message handling
- queue transport
- session-driver dispatch
- model execution
- outbound delivery

#### Deliverables
- clearer module boundaries
- easier future HA / remote-host support
- lower coupling between bot/runtime/ops tools

---

### 3. Policy layer
Add per-topic / per-session policies for:
- who can trigger risky actions
- which tools are allowed
- model/provider overrides
- read-only vs interactive sessions

---

## Suggested execution order

### Quick wins (1 day)
1. session health summary
2. correlation ids in logs
3. dead-letter folder + reason codes
4. inspect / replay scripts
5. outbound dedupe guard

### Short implementation wave (2–3 days)
1. startup phases
2. structured audit trail
3. parse/send fallback accounting
4. basic auto-remediation

### Heavier refactor (1 week+)
1. SQLite queue/state
2. control plane vs data plane split
3. stricter output contract
4. policy layer

---

## Success criteria

Relay is meaningfully improved when:
- any failed or missing reply can be traced end-to-end
- stuck sessions are identified automatically
- queue flow is observable per topic
- duplicate/lost delivery risk is bounded
- operators do not need tmux/log archaeology for normal debugging

---

## Short version

**Do not refactor first.**

First make Relay:
1. visible
2. explainable
3. recoverable

Then make it prettier.
