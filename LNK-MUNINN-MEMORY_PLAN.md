# LNK + Muninn Memory: Decision Memo and Implementation Plan

## 0. Direct answer: does the recommended architecture still work for local solo Pi use?

**Yes.** The recommended architecture is still valid when using Pi only from your local machine.

The key is to treat the **Pi RPC Gateway + Muninn** design as the **system architecture**, not as a Discord-only architecture.

It should support two first-class operating modes:

1. **Local solo mode**
   - you run the gateway locally on your machine
   - you use Pi interactively from your terminal
   - the same memory broker, Muninn vaults, and `lnk-memory` assets are used
   - no architecture fork is needed

2. **Orchestrated mode**
   - the Discord singleton talks to the same gateway
   - the gateway manages multiple Pi workers/sessions
   - Muninn remains the shared durable memory substrate
   - `lnk-memory` remains the worker-local/session-local transcript lane

So the final design must be **local-first and orchestration-ready**, not two separate systems.

---

## 1. Executive decision

### Final architecture decision
Adopt a **Pi RPC Gateway + Muninn hybrid memory architecture**.

### What this means
- **Pi** remains the agent runtime.
- **Pi RPC** becomes the control boundary for orchestrated workers.
- **`pi-lnk-memory`** remains responsible for transcript/session memory and curated `memory.md` behavior.
- **MuninnDB** becomes the shared durable cognitive memory layer.
- **A Memory Broker layer** mediates between Pi workers and Muninn using the best available transport.
- **Discord** becomes a client/front door to the gateway, not the memory system itself.

### Non-goals
- Do **not** make MCP the core integration plane.
- Do **not** replace `lnk-memory` with Muninn.
- Do **not** flatten all transcript history into one global durable pool.

---

## 2. Why this architecture wins

This architecture best fits the target system:
- a **Discord singleton orchestration interface**
- coordinating **multiple Pi workers / workflows**
- with a **hybrid memory system**
- while aiming to leverage **all usable Muninn features**

### Why not MCP-first?
Because:
- Pi is designed around **extensions / SDK / RPC**, not MCP as its native extensibility model.
- Muninn's full feature surface is better exposed through **gRPC + REST + streaming** than MCP alone.
- Some Muninn features are MCP-oriented, but MCP should be treated as an **auxiliary capability layer**, not the system backbone.

### Why not extension-only?
An extension-only integration is good for a single Pi instance, but weak for:
- multi-agent orchestration
- centralized trigger handling
- shared routing logic
- worker supervision
- Discord control-plane behavior

### Why RPC gateway?
Because it cleanly separates:
- **control plane** (gateway / Discord / coordination)
- **worker runtimes** (Pi sessions)
- **shared durable memory** (Muninn)
- **local transcript memory** (`lnk-memory`)

---

## 3. Final target architecture

```text
                          ┌─────────────────────────────┐
                          │       Discord Singleton     │
                          │  orchestration interface    │
                          └──────────────┬──────────────┘
                                         │
                                         ▼
                          ┌─────────────────────────────┐
                          │       Pi RPC Gateway        │
                          │  control plane / routing    │
                          │  workflow orchestration     │
                          │  worker supervision         │
                          └───────┬───────────┬─────────┘
                                  │           │
                     local solo ──┘           └── orchestrated workers
                                  │
                 ┌────────────────┴─────────────────┐
                 │                                  │
                 ▼                                  ▼
      ┌─────────────────────┐            ┌─────────────────────┐
      │   Pi Worker A       │            │   Pi Worker B       │
      │  (RPC controlled)   │            │  (RPC controlled)   │
      │ + lnk-memory        │            │ + lnk-memory        │
      └─────────┬───────────┘            └─────────┬───────────┘
                │                                  │
                └──────────────┬───────────────────┘
                               ▼
                   ┌──────────────────────────┐
                   │      Memory Broker       │
                   │ hybrid recall / writes   │
                   │ trigger handling         │
                   │ transport capability     │
                   └──────────┬───────────────┘
                              │
          ┌───────────────────┼────────────────────┐
          │                   │                    │
          ▼                   ▼                    ▼
  ┌───────────────┐   ┌───────────────┐   ┌────────────────┐
  │ Muninn gRPC   │   │ Muninn REST   │   │ Muninn MCP     │
  │ primary push  │   │ ops/fallback  │   │ compat/MCP-only│
  └──────┬────────┘   └──────┬────────┘   └──────┬─────────┘
         └───────────────────┴───────────────────┘
                             ▼
                    ┌──────────────────┐
                    │    MuninnDB      │
                    │ durable memory   │
                    │ graph + triggers │
                    └──────────────────┘
```

---

## 4. First-class operating modes

## 4.1 Local solo mode
This must be explicitly supported.

### Behavior
- gateway runs locally on the same machine
- one interactive Pi session can register as the current worker
- the same Memory Broker and Muninn instance are used
- `lnk-memory` continues to provide transcript/session recall
- hybrid memory works exactly the same way as in orchestrated mode

### Why this matters
This keeps local usage simple while avoiding a future rewrite.

### Target UX
- local Pi still feels like local Pi
- no Discord dependency is required for solo usage
- the gateway can be optional to the user experience, but not optional to the architecture

## 4.2 Orchestrated mode
### Behavior
- Discord singleton sends tasks into the gateway
- gateway selects or spawns Pi workers
- workers use `lnk-memory` locally and Muninn via the Memory Broker
- gateway can coordinate multi-agent workflows with shared durable memory

---

## 5. Responsibility split

## 5.1 Discord singleton
Owns:
- user-facing interaction
- orchestration requests
- approval / escalation UX
- workflow triggers
- high-level routing and coordination requests

Does **not** own:
- transcript indexing
- direct memory extraction logic
- durable memory storage internals

## 5.2 Pi RPC Gateway
Owns:
- worker lifecycle
- RPC session management
- routing tasks to workers
- cross-worker coordination
- queueing and supervision
- gateway-level memory policy
- deciding when to inject pushed memory into workers

## 5.3 Pi workers
Owns:
- actual reasoning/tool execution
- session-local context and transcript history
- local `lnk-memory` indexing and retrieval
- local review commands and user interaction when interactive

## 5.4 `pi-lnk-memory`
Keeps ownership of:
- session discovery and parsing
- transcript chunking/indexing
- lexical/vector recall over session history
- curated `memory.md`
- backfill extraction and review flows
- one-shot hybrid prompt injection at worker level

Must evolve to support:
- a broker-backed hybrid recall path
- worker-local memory candidates for promotion to Muninn
- compatibility with both local interactive mode and RPC-managed workers

## 5.5 Memory Broker
This is the critical new layer.

Owns:
- Muninn transport abstraction
- capability detection (gRPC, REST subscribe, MCP-only features)
- hybrid recall merge policy
- semantic trigger subscription handling
- contradiction escalation policy
- durable write APIs for workers and gateway
- normalized event model for pushed memory

### Broker API shape (target)
The implementation should expose functions along these lines:
- `activateHybrid(query, scope)`
- `rememberBatch(memories, scope)`
- `link(sourceId, targetId, relation, scope)`
- `recordDecision(...)`
- `setState(...)`
- `subscribe(scope, contexts, options)`
- `getStatus()`
- `getCapabilities()`
- `explain(...)`
- `getSessionActivity(...)`

## 5.6 MuninnDB
Muninn is the durable shared memory substrate and should be treated as such.

Use Muninn for:
- durable facts
- decisions
- preferences worth sharing beyond one session
- issue/fix history
- procedures
- entity/relationship graph
- contradictions
- state transitions
- trigger-driven relevance updates

---

## 6. Memory lanes and memory roles

## 6.1 Lane A — `lnk-memory`
Role:
- transcript/session memory
- recency-heavy memory
- local session archaeology
- branch/session summaries
- curated `memory.md`

Best for questions like:
- what were we just doing?
- what did we say in a recent session?
- what was that exact command or snippet from a previous branch?

## 6.2 Lane B — Muninn
Role:
- durable structured memory
- cross-worker shared memory
- graph-based relationships
- contradictions
- long-lived memory with activation semantics
- workflow/project/user durable memory

Best for questions like:
- what is true long-term?
- what decisions were made before?
- what issues were resolved and how?
- what facts should all workers benefit from?

## 6.3 `memory.md`
Role:
- very small, curated local profile memory
- user preferences
- stable constraints
- environment defaults
- interaction style

Rule:
- do not dump extracted history into `memory.md`
- only add reviewed, stable, high-value items

---

## 7. Muninn transport strategy

## 7.1 Principle
Use **the best transport for the job**, not one transport for everything.

## 7.2 Preferred transport order
### Primary: gRPC
Use for:
- subscribe / push semantics
- low-latency memory operations
- richer long-lived connections
- full-feature cognitive/event usage where practical

### Secondary: REST
Use for:
- CRUD
- activate fallback
- stats/session/admin/debug
- easy interoperability
- easier scripted validation

### Compatibility/MCP-only lane: MCP
Use for:
- MCP-only or MCP-biased features
- compatibility with generic agent clients
- `muninn_guide` and similar tool-centric flows when beneficial
- hierarchical-memory conveniences if truly needed

## 7.3 Capability detection is mandatory
On startup, the Memory Broker should detect and record:
- can REST `activate` work?
- can REST write/batch work?
- can REST subscribe work?
- can gRPC activate work?
- can gRPC subscribe work?
- what MCP tools are available?

The system should not assume docs and runtime always match.

## 7.4 Known observed runtime issue
At the time of this plan:
- REST write works
- REST activate works
- REST subscribe is documented
- but local testing on `muninn v0.3.9-alpha` returned `500 streaming not supported` for `/api/subscribe`

This means push integration must be implemented with **feature detection and fallback**, not assumption.

---

## 8. Vault strategy

Do **not** use a single giant vault for everything.

## Recommended vaults

### `user-profile`
Stores:
- stable preferences
- interaction style
- profile facts
- environment constraints

Suggested profile:
- preset: `reference`
- behavior: `autonomous`

### `orchestrator`
Stores:
- coordination memory
- workflow routing memory
- delegation heuristics
- worker capability facts
- failure patterns

Suggested profile:
- preset: `knowledge-graph` or `reference`
- behavior: `autonomous`

### `project:<name>`
Stores:
- shared project facts
- architecture decisions
- bugs/fixes
- procedures
- contradictions and evidence

Suggested profile:
- preset: `reference`
- behavior: `autonomous`

### `agent:<role>` or `agent:<id>`
Stores:
- role-specific durable learnings
- worker heuristics
- medium-lived agent-local durable memory

Suggested profile:
- preset: `scratchpad` or `reference`
- behavior: `selective` or `autonomous`

### `workflow:<id>` (optional)
Stores:
- ephemeral workflow state
- per-run coordination memory
- task/handoff state

Suggested profile:
- preset: `scratchpad`
- behavior: `selective`

---

## 9. Hybrid recall and injection model

## 9.1 Recall policy
Before an LLM call, memory should be assembled from:
1. Muninn durable recall
2. `lnk-memory` transcript/session recall
3. optional workflow/orchestrator state

## 9.2 Merge policy
- prefer Muninn for durable facts and decisions
- prefer `lnk-memory` for recency and exact transcript phrasing
- dedupe aggressively
- budget aggressively
- avoid repeated injection loops

## 9.3 Injection policy
- one-shot injection per prompt/turn boundary
- strict token budgets
- contradiction events may justify higher-priority warning injection
- triggered pushes should be queued and merged, not blindly injected raw

## 9.4 Push trigger mapping
Map Muninn trigger types into Pi behavior:

### `new_write`
- low priority
- queue for next turn if relevant

### `threshold_crossed`
- medium priority
- queue or summarize for next turn

### `contradiction_detected`
- high priority
- inject as warning or steer-level message when justified

---

## 10. What has already been done

This section captures the current state so implementation can continue without re-discovery.

## 10.1 Research completed
### Pi side
Reviewed:
- Pi README
- extensions docs
- SDK docs
- RPC docs
- provider/model extensibility docs

### Muninn side
Reviewed:
- local repo docs
- website docs
- feature reference
- semantic triggers docs
- REST docs
- SDK docs
- architecture docs
- MCP docs
- proto/service definitions
- trigger and subscribe code paths

### OpenClaw reference
Confirmed:
- OpenClaw uses **Pi agent runtime in RPC mode**
- this validates the gateway/control-plane pattern as a real design precedent

## 10.2 Muninn local setup completed
- Muninn cloned locally: `/home/jake/pi-plugins/muninndb`
- Muninn installed locally: `~/.local/bin/muninn`
- version installed/tested: `v0.3.9-alpha`
- Muninn server started successfully
- health checks succeeded
- Pi MCP config created in `~/.pi/agent/mcp.json`
- Muninn vault created and used for testing

## 10.3 Current `pi-lnk-memory` implementation progress completed
Implemented already in the current repo:
- session indexing and retrieval foundation
- local LLM extraction client at `http://127.0.0.1:8080`
- backfill scanner
- backfill review flows
- backfill sync flows
- global-memory review command
- Muninn REST client for writes/activate
- stricter extraction rules for `memory.md`
- explicit review before append to `memory.md`
- initial hybrid recall merge / one-shot injection logic
- provenance metadata for extracted memories

## 10.4 Backfill workflow already proven
Working commands/prototype flows include:
- `/lnk-memory-backfill-scan`
- `/lnk-memory-backfill-review`
- `/lnk-memory-backfill-sync`
- `/lnk-memory-global-review`

Current behavior improvements already established:
- default backfill = latest single session only
- `all` processes sequentially, not in one huge batch
- fenced JSON parsing fixed
- local LLM extraction made more robust
- global-memory candidate set tightened significantly

## 10.5 Muninn recall/write proof completed
Confirmed working:
- REST writes to Muninn
- explicit REST `activate`
- corrected vault handling bug so writes land in the intended vault
- hybrid recall can consume Muninn results

## 10.6 Known gap discovered
REST `/api/subscribe` is documented but currently failed locally with:
- `500 streaming not supported`

This is a critical implementation note.

---

## 11. What from the current prototype is kept vs refactored

## Keep
The following is still directly useful:
- session parsing/indexing code
- `lnk-memory` retrieval pipeline
- curated `memory.md` flows
- extraction + review commands
- Muninn REST write/activate client logic
- hybrid injection budget logic
- provenance schema

## Refactor
The following needs to be evolved into architecture-safe layers:
- Muninn client code → into transport-specific adapter(s)
- hybrid recall code → into shared broker/core logic
- backfill sync logic → into promotion pipeline with broker-aware target selection
- injection path → make compatible with both standalone local Pi and RPC-managed workers

## New layers required
- Memory Broker abstraction
- Pi RPC worker/gateway integration
- trigger event normalization
- gateway-level orchestration memory policy
- capability detection on Muninn startup

---

## 12. Final implementation goal

Build a system where:
- local interactive Pi use is fully supported
- Discord orchestration is fully supported
- `lnk-memory` remains the transcript/session lane
- Muninn becomes the shared durable memory lane
- durable memory can be written, recalled, linked, traversed, contradicted, and activated across workers
- trigger-based memory surfacing is used when available
- fallback behavior exists when streaming/subscribe capabilities are unavailable

---

## 13. Implementation workstreams

## Workstream A — stabilize current `pi-lnk-memory` prototype
Goal:
- keep current extension usable while architecture evolves

Tasks:
- preserve working backfill/review/global-review commands
- verify current typecheck/tests stay green
- keep standalone local mode functioning during refactor

## Workstream B — extract shared memory core / broker layer
Goal:
- separate memory policy from Pi extension entrypoints

Tasks:
- define transport-agnostic memory interfaces
- extract Muninn adapter contracts
- extract hybrid recall merge logic
- extract normalization / dedupe / scoring / budgeting logic
- add capability probing and status surface

## Workstream C — implement Muninn transport adapters
Goal:
- support all needed Muninn operations through the best available transport

Tasks:
- REST adapter (write, batch, activate, status, session, links)
- gRPC adapter (activate, subscribe, possibly write/link if practical)
- MCP adapter for MCP-only or compatibility features
- transport-selection policy
- fallback rules when a transport fails or is unavailable

## Workstream D — implement Pi RPC gateway
Goal:
- create the orchestration control plane

Tasks:
- spawn/manage Pi in `--mode rpc`
- maintain worker registry
- map gateway tasks to worker sessions
- surface status and health
- attach local solo Pi usage path
- define injection/steer/follow-up policies for memory pushes

## Workstream E — integrate `lnk-memory` with gateway-managed workers
Goal:
- preserve transcript memory behavior inside each worker while allowing gateway orchestration

Tasks:
- decide whether `lnk-memory` remains loaded in workers as an extension
- ensure worker-local transcript indexes remain available
- expose worker-local recall signals to the gateway/broker as needed
- prevent duplicate injection from both worker and gateway

## Workstream F — implement semantic trigger pipeline
Goal:
- use Muninn push features where available

Tasks:
- verify gRPC subscribe end-to-end
- if REST subscribe becomes usable, support it too
- normalize push events into gateway queue
- assign trigger priority classes
- inject or route events safely into workers
- handle contradictions distinctly

## Workstream G — complete durable memory promotion pipeline
Goal:
- move reviewed, durable knowledge from session history into Muninn cleanly

Tasks:
- keep explicit review before `memory.md`
- keep provenance on all promoted memories
- refine write targets by vault and memory type
- add decisions/state/link creation where appropriate
- allow review-before-sync workflows to remain human-controlled

## Workstream H — Discord singleton integration
Goal:
- make the orchestrator the front door without changing memory architecture

Tasks:
- define task envelope and workflow state
- map Discord threads/channels/users to gateway/workflow scopes
- map memory scopes and vault routing to Discord-originated workflows
- expose observability and approvals cleanly

---

## 14. Detailed phase plan

## Phase 0 — planning freeze and architecture pivot capture
Deliverables:
- this decision memo
- updated historical hybrid plan
- explicit statement that final architecture is gateway-centric, local-first, hybrid-memory

## Phase 1 — refactor current code into reusable layers
Deliverables:
- shared memory core module
- transport abstraction interfaces
- clean split between extension glue and memory logic

Concrete tasks:
- move Muninn-specific logic out of ad hoc extension-only paths
- isolate hybrid recall merger
- isolate promotion/review logic
- add broker capability report command/status output

## Phase 2 — implement transport-complete Muninn broker
Deliverables:
- REST adapter
- gRPC adapter prototype
- MCP compatibility adapter
- startup capability probing

Concrete tasks:
- implement gRPC `Subscribe` and `Activate`
- retain REST write/activate/status/session fallback
- expose broker health summary for debugging

## Phase 3 — implement Pi RPC gateway skeleton
Deliverables:
- gateway process that can spawn and manage Pi RPC workers
- local solo mode through the same gateway

Concrete tasks:
- define worker abstraction
- define RPC client wrapper
- support prompt, steer, follow-up, get state, session management
- support memory injection messages routed through RPC

## Phase 4 — preserve local interactive Pi usage
Deliverables:
- local solo workflow that uses the same broker and Muninn setup

Concrete tasks:
- choose local mode behavior:
  - either gateway-managed interactive Pi worker
  - or standalone Pi using the same shared memory core and broker endpoints
- ensure no regression in current local workflows

## Phase 5 — hybrid recall unification
Deliverables:
- one merged recall system usable in both local and orchestrated mode

Concrete tasks:
- merge Muninn recall + `lnk-memory` recall through shared policy
- apply strict budgets
- ensure worker-local recency stays useful
- add observability for why items were injected

## Phase 6 — trigger and contradiction pipeline
Deliverables:
- trigger event queue
- contradiction escalation path

Concrete tasks:
- prefer gRPC subscribe if available
- if unavailable, fall back to explicit activate-on-turn and periodic refresh
- ensure contradiction events can interrupt safely when needed

## Phase 7 — durable promotion and backfill completion
Deliverables:
- complete, reviewable memory promotion pipeline
- vault-aware sync behavior

Concrete tasks:
- keep global review command for `memory.md`
- improve Muninn write classification by vault/type
- re-run backfill against selected sessions after architecture refactor

## Phase 8 — Discord orchestration integration
Deliverables:
- singleton interface connected to gateway
- workflow-level memory routing

Concrete tasks:
- map workflow/task identities to vaults and worker scopes
- enable multi-agent workflows with shared durable memory and local transcript lanes

## Phase 9 — final validation
Deliverables:
- documented acceptance criteria met
- tested local and orchestrated modes

---

## 15. Acceptance criteria

The final implementation is successful when all of the following are true:

### Local usage
- interactive local Pi works without Discord
- hybrid memory is available locally
- `lnk-memory` transcript recall remains useful
- Muninn durable recall remains useful

### Orchestrated usage
- Discord singleton can route work through gateway-managed Pi workers
- workers can share durable Muninn memory while keeping local transcript memory separate
- workflows can use shared project/orchestrator vaults safely

### Muninn feature coverage
- durable write works
- activate works
- link works
- state/decision/explain/session/status paths are available where needed
- push/subscribe works via the best available transport, or falls back safely
- contradictions are surfaced distinctly

### Human control
- `memory.md` remains curated and reviewed
- promotion to durable memory preserves provenance
- review-before-sync remains available for sensitive memory ingestion

### Reliability
- capability detection is visible
- transport failures degrade gracefully
- no duplicate or runaway injection loops
- local solo mode and orchestrated mode share one architecture, not two divergent codepaths

---

## 16. Immediate next implementation priorities

1. **Freeze current progress into updated plan documents**
2. **Refactor current extension logic into a shared memory core / broker shape**
3. **Implement Muninn capability detection and gRPC feasibility path**
4. **Design and scaffold the Pi RPC gateway**
5. **Define local solo mode explicitly so the architecture stays local-first**
6. **Then integrate Discord orchestration on top of the gateway**

---

## 17. Summary

The final system should be understood as:

- **Pi** = worker runtime
- **Pi RPC Gateway** = orchestration control plane
- **`lnk-memory`** = transcript/session memory lane
- **MuninnDB** = durable shared cognitive memory lane
- **Memory Broker** = the integration brain that chooses transports, merges recall, handles triggers, and preserves hybrid behavior

This architecture supports both:
- **solo local Pi use**, and
- **Discord-driven multi-agent orchestration**,

without requiring a future rewrite of the memory model.
