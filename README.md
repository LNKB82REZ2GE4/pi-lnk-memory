# pi-lnk-memory

Hybrid memory extension for Pi coding agent:
- cross-session indexing (all local sessions),
- lexical retrieval + vector retrieval (Qdrant),
- local embeddings via Ollama,
- ephemeral memory injection per prompt,
- append-only global `memory.md` for user preferences/profile.

## Key behavior

- **Default retrieval adds no extra completion-model calls**.
  - Uses lexical scoring + Ollama embeddings (`/api/embed`) + Qdrant similarity.
- Memory context is injected via `context` event and consumed once per prompt.
- Global memory file is append-only by extension and still manually editable:
  - `~/.pi/agent/lnk-memory/memory.md`
- Dedupe/reconciliation keeps newest preference statements authoritative.
  - If LLM-assisted dedupe is enabled, it uses local endpoint only (`http://localhost:8080`).

## Install

### Global install (recommended)

```bash
pi install /home/jake/pi-plugins/pi-lnk-memory
```

This adds the package to global Pi settings so it loads in all Pi instances.

### Install from packaged tarball

```bash
cd /home/jake/pi-plugins/pi-lnk-memory
npm pack
pi install /home/jake/pi-plugins/pi-lnk-memory/pi-lnk-memory-0.1.0.tgz
```

(Use the generated tarball filename for your current version.)

## Configuration

Add this to `~/.pi/agent/settings.json`:

```json
{
  "pi-lnk-memory": {
    "enabled": true,
    "ollama": {
      "baseUrl": "http://127.0.0.1:11434",
      "model": "nomic-embed-text",
      "fallbackModels": ["all-minilm", "mxbai-embed-large"]
    },
    "qdrant": {
      "baseUrl": "http://127.0.0.1:6333",
      "collection": "pi_lnk_memory_chunks"
    },
    "indexing": {
      "diskCapBytes": 21474836480
    },
    "dedupe": {
      "intervalMs": 1800000,
      "llmAssist": false,
      "llmEndpoint": "http://127.0.0.1:8080"
    }
  }
}
```

## Commands

- `/lnk-memory-status`
- `/lnk-memory-index`
- `/lnk-memory-reindex`
- `/lnk-memory-search <query>`
- `/lnk-memory-prune`
- `/lnk-memory-global-add <text>`
- `/lnk-memory-global-open`
- `/lnk-memory-global-dedupe`

## Notes

- This extension indexes all local Pi sessions (`SessionManager.listAll()`).
- Extension-owned injected memory blocks are excluded from indexing.
