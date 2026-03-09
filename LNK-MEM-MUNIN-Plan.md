# LNK Memory + MuninnDB Hybrid Plan

> Status: **updated after architecture decision**
>
> The original version of this document captured an **extension-first integration plan**.
> That work produced useful prototypes and should be preserved, but the **final target architecture has now changed**.
>
> **The authoritative detailed plan is now:** `LNK-MUNINN-MEMORY_PLAN.md`
>
> This document is retained as the concise historical plan + status ledger for what has already been done and what remains to reach the final gateway-based implementation.

---

## 1. Final architecture decision

We are **not** treating Muninn as an MCP-first add-on anymore.

### Final target architecture
Adopt a **Pi RPC Gateway + Muninn hybrid memory architecture** where:
- `pi-lnk-memory` remains the **transcript/session memory** lane
- MuninnDB becomes the **durable shared cognitive memory** lane
- a **Memory Broker** mediates recall, writes, triggers, and transport selection
- **Pi RPC workers** are used for orchestrated multi-agent workflows
- the architecture must still work in **local solo Pi mode** on the same machine

### Important clarification
This architecture is still valid for local-only use:
- local interactive Pi should use the same memory broker and Muninn setup
- Discord orchestration is an additional front door, not a different memory architecture

For the detailed decision memo, architecture, workstreams, and implementation phases, see:
- `LNK-MUNINN-MEMORY_PLAN.md`

---

## 2. What has already been accomplished

## Research and architecture discovery
Completed:
- reviewed Pi extension, SDK, and RPC docs
- reviewed Muninn local docs, website docs, REST docs, MCP docs, semantic trigger docs, SDK docs, and proto/service definitions
- confirmed OpenClaw uses **Pi in RPC mode**, validating the gateway/control-plane pattern

## Muninn local setup
Completed:
- cloned Muninn locally at `/home/jake/pi-plugins/muninndb`
- installed Muninn binary locally
- started Muninn successfully
- created and used a local vault for testing
- configured Pi MCP access in `~/.pi/agent/mcp.json`

## `pi-lnk-memory` prototype work
Completed:
- built session indexing/retrieval foundation
- built local LLM extraction path using `http://127.0.0.1:8080`
- built backfill scanner
- built backfill review flow
- built backfill sync flow
- built global-memory review command for `memory.md`
- built Muninn REST client for writes and explicit recall
- added provenance fields to extracted memories
- tightened extraction/storage rules so `memory.md` is curated, not a dump
- added explicit approval flow before appending to `memory.md`
- implemented an initial hybrid recall merge and one-shot injection path

## Backfill behavior improvements already achieved
Completed:
- default backfill testing now targets **one session at a time**
- `all` runs sequentially with fresh local-LLM calls per session
- fenced JSON output parsing was fixed
- timeout/abort handling was improved
- global-memory candidate output was reduced significantly

## Validation already completed
Completed:
- typecheck passes after recent changes
- Muninn REST write works
- Muninn REST activate works
- corrected a vault-targeting issue in batch write handling so memories land in the intended vault
- targeted backfill scans and sync runs completed successfully

---

## 3. What the prototype proved

The extension-first work was **not wasted**. It proved that:
- `lnk-memory` is a strong base for transcript/session memory
- backfill extraction/review/promotion is feasible
- local LLM extraction can be used effectively
- Muninn can already be used as the durable memory destination
- hybrid recall is practical
- `memory.md` should stay small and curated

These results still stand and will be carried forward.

---

## 4. What changed architecturally

Originally, the plan was:
- integrate Muninn more deeply **inside `pi-lnk-memory`**
- keep background and automatic operations inside the extension
- rely on REST for deterministic work and use MCP for manual/agent-visible use

That remains a good **prototype shape**, but it is no longer the **final system shape**.

### Why the architecture changed
Because the target system is now explicitly:
- a **Discord singleton interface**
- acting as an **orchestration agent**
- for **multi-agent workflows**
- where all workers should benefit from hybrid memory
- while using as much of Muninn's full feature set as practical

That requires:
- a control plane
- worker supervision
- centralized trigger handling
- shared memory routing
- architecture that works for both solo and orchestrated usage

This points to **Pi RPC Gateway + Muninn**, not extension-only integration.

---

## 5. Critical findings that still matter

## Muninn transport reality
Confirmed:
- REST write works
- REST activate works
- MCP tools can be surfaced in Pi

But also discovered:
- REST `/api/subscribe` is documented
- local runtime testing on `v0.3.9-alpha` returned `500 streaming not supported`

### Implication
Push/trigger behavior must be implemented with:
- **capability detection**
- **transport fallback**
- likely preference for **gRPC** over REST for subscribe/streaming if full trigger behavior is needed

## MCP conclusion
Still true:
- MCP is useful
- MCP is not the right primary integration plane for this system
- the final design should be **MCP-capable, not MCP-centered**

---

## 6. What remains to be done

## A. Preserve and stabilize the current extension
- keep current `pi-lnk-memory` functionality working
- preserve backfill/review/global-review flows
- keep standalone local use working during refactor

## B. Extract a shared Memory Broker / core layer
- move memory policy out of extension-only codepaths
- create transport-agnostic interfaces
- centralize hybrid recall merge logic
- centralize capability detection and trigger normalization

## C. Implement fuller Muninn transport support
- keep REST adapter for stable CRUD/activate/status flows
- add gRPC adapter for subscribe and richer streaming behavior
- keep MCP adapter for MCP-only / compatibility features

## D. Implement Pi RPC gateway
- spawn and supervise Pi RPC workers
- support local solo mode through the same architecture
- provide worker/task/session abstractions
- support memory injection and routing through RPC

## E. Integrate `lnk-memory` with RPC workers
- keep transcript/session memory local to workers
- avoid duplicate memory injection between worker and gateway layers
- preserve worker-local indexing and `memory.md`

## F. Complete hybrid memory behavior in final architecture
- durable recall from Muninn
- transcript recall from `lnk-memory`
- strict merge/dedupe/token budgets
- safe push-trigger handling when available

## G. Integrate Discord orchestration last, not first
- once gateway + workers + memory broker are solid
- then add the Discord singleton front door

---

## 7. Final implementation goal

Reach a system where:
- local interactive Pi works through the same overall memory architecture
- Discord can orchestrate multiple Pi workers
- `lnk-memory` remains the transcript/session lane
- Muninn is the durable shared memory layer
- all usable Muninn features are leveraged through the best available transport
- review/approval remains explicit where needed (`memory.md`, durable promotion)
- the memory model does not need to be redesigned later

---

## 8. Current status summary

### Completed and reusable
- backfill extraction/review/sync prototype
- curated `memory.md` review flow
- hybrid recall prototype
- Muninn REST write/activate integration
- provenance preservation
- stricter extraction policies

### Needs refactor, not deletion
- extension-owned Muninn integration code
- current hybrid recall wiring
- sync/promotion logic

### Not yet built
- Memory Broker abstraction
- Pi RPC gateway
- gRPC subscribe path
- trigger event pipeline
- Discord orchestration layer

---

## 9. Next reference document

Use this as the concise history/status file.

Use the following file as the full decision memo and implementation reference for the next implementation session:
- `LNK-MUNINN-MEMORY_PLAN.md`
