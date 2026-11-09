# dsh-plugin-context-mode

[![DeepSeek Harness](https://img.shields.io/badge/DSH-Plugin-0284c7.svg)](https://github.com/deepseek-ai)
[![Context Mode](https://img.shields.io/badge/Context%20Mode-v2.1.7-10b981.svg)](https://github.com/mksglu/context-mode)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Native [DeepSeek Harness (DSH)](https://github.com/deepseek-ai) plugin adding full, native support for **[context-mode](https://github.com/mksglu/context-mode)** by [Mert Koseoglu](https://github.com/mksglu).

---
<img width="771" height="777" alt="image" src="https://github.com/user-attachments/assets/661f78a8-30ab-4a4e-8128-4ef8bf62d4ee" />

## What is Context Mode?

Context Mode is a lightweight, local-first context optimization engine designed to prevent LLM context window degradation and token bloat. In standard agentic loops, commands and tools often dump dozens or hundreds of kilobytes into the context window, causing:

1. **Context Window Saturation:** Hitting context limits and incurring high token costs.
2. **Context Degradation & Amnesia:** "Lost in the middle" phenomena where the model loses track of core instructions and goals due to noise.
3. **Redundant Repetitions:** Repeatedly reading the same files or command outputs over multiple turns.

**Context Mode solves this by keeping tool outputs out of the model's context window:**
- Large tool outputs (>4 KB) are automatically intercepted and indexed into a local **SQLite FTS5** database.
- A compact preview with an indexed source handle is returned to the model.
- The model uses semantic BM25 + Trigram Reciprocal Rank Fusion (RRF) search (`ctx_search`) to retrieve only the exact snippets it needs on demand.
- Continuity across compaction or subagents is maintained via session journals and compact state blocks (`ctx_resume`).

---

## Features

- **8 Native Tools:**
  - `ctx_execute`: Sandboxed execution of Node.js, Python, or shell code with an output cap of 16 KB. Full outputs are indexed; intent-guided semantic filtering retrieves only relevant excerpts.
  - `ctx_batch`: Batch execution of multiple shell commands, concatenated and indexed into SQLite FTS5 for unified querying.
  - `ctx_index`: Explicitly index files, raw text, or web URLs into SQLite FTS5 without expanding the context window.
  - `ctx_search`: Query indexed chunks across sessions or worktrees using BM25 and Trigram Reciprocal Rank Fusion (`RRF_K=60`).
  - `ctx_resume`: Rebuild context state and memory across compaction boundaries or subagent delegates with compact state blocks (<= 2048 B).
  - `ctx_stats`: Real-time analytics on intercepted bytes, kept-out bytes, and estimated token savings.
  - `ctx_doctor`: Health diagnostics for SQLite FTS5 tokenizers (Porter + Trigram) and runtime environments.
  - `ctx_purge`: Clean up indexed sources or wipe Context Mode tables.
- **Zero-Dependency SQLite FTS5 Engine:**
  - Utilizes Node.js native `node:sqlite` (`DatabaseSync`) with virtual FTS5 tables (`porter unicode61` and `trigram`).
  - No external C++ compilation or native binary installation required.
- **Automatic Lifecycle Interception:**
  - Plugs into DSH's `tools/post-execute` waterfall lifecycle.
  - Outputs exceeding `replaceTriggerBytes` (default 4 KB) are safely intercepted and replaced with head/tail previews and search handles.
- **Full Web UI Integration:**
  - Custom Settings section in the DSH Web UI.
  - Live metric cards showing bytes kept out, token savings, and context reduction progress bars.
  - Built-in diagnostic inspection table and one-click database vacuum/purge controls.
- **Bilingual Support:** Full English and Simplified Chinese localization (`en.json`, `zh.json`).

---

## Installation

### Method 1: Local Development / Linked Bundle

Link this directory into your DSH installation:

```bash
# In DSH workspace
plugin_manager install_bundle target="link:F:/unity/vogel/plugins/dsh-plugin-context-mode"
```

### Method 2: npm Package

```bash
plugin_manager install_bundle target="dsh-plugin-context-mode"
```

---

## Configuration

In your `cordis.patch.yml` or DSH Settings:

```yaml
- insert:
    - id: dsh-plugin-context-mode
      name: dsh-plugin-context-mode
      config:
        enabled: true
        autoIntercept: true
        replaceTriggerBytes: 4096
        injectSystemPrompt: true
        dbPath: "" # defaults to ~/.context-mode/context.db
```

| Key | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `enabled` | boolean | `true` | Enable or disable the plugin. |
| `autoIntercept` | boolean | `true` | Automatically intercept and index tool outputs exceeding threshold. |
| `replaceTriggerBytes` | number | `4096` | Output byte threshold to trigger interception & FTS5 indexing. |
| `injectSystemPrompt` | boolean | `true` | Inject Context Mode tool guidelines into model system prompt. |
| `dbPath` | string | `""` | Optional custom SQLite database path. |

---

## Tool Reference

### `ctx_execute`
Execute code in a sandboxed subprocess.
```json
{
  "language": "shell",
  "code": "git log --oneline -n 100",
  "intent": "merge commit"
}
```

### `ctx_batch`
Execute multiple shell commands in batch and query results.
```json
{
  "commands": ["pnpm test", "git status --short", "cat package.json"],
  "queries": ["dependencies", "test failed"]
}
```

### `ctx_index`
Index a file, URL, or string into SQLite FTS5.
```json
{
  "path": "docs/architecture.md",
  "source": "architecture-doc"
}
```

### `ctx_search`
Search indexed content using BM25 + Trigram RRF.
```json
{
  "queries": ["PostToolUse", "FTS5 schema"],
  "limit": 5
}
```

### `ctx_stats`
Check your context savings report.
```json
{
  "scope": "all"
}
```

---

## Architecture & Storage Schema

SQLite database is located at `~/.context-mode/context.db`.

Tables:
- `events`: Turn-by-turn journal tracking executed commands, intercepted outputs, and token savings.
- `sources`: Catalog of all indexed files, batches, and outputs.
- `chunks`: Virtual table using FTS5 `tokenize = 'porter unicode61 remove_diacritics 2'` for English and stemmed terms.
- `chunks_tri`: Virtual table using FTS5 `tokenize = 'trigram'` for exact code symbols, paths, and substrings.
- `meta`: Key-value configuration metadata.

---

## Credits

- **context-mode:** [https://github.com/mksglu/context-mode](https://github.com/mksglu/context-mode) by [Mert Koseoglu](https://github.com/mksglu).
- **DeepSeek Harness:** [DeepSeek AI](https://github.com/deepseek-ai).

---

## License

MIT © [Domush](https://github.com/Domush)
