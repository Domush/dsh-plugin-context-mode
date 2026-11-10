# Changelog

All notable changes to `dsh-plugin-context-mode` will be documented in this file.

## [1.0.1] - 2026-11-09

### Added
- Added DSH Plugin badge to README.
- Added non-commandline UI installation instructions to README.

### Changed
- Removed local drive paths from installation instructions.

## [1.0.0] - 2026-11-09

### Added
- Initial release of native DeepSeek Harness support for [context-mode](https://github.com/mksglu/context-mode).
- Implemented zero-dependency SQLite FTS5 storage engine (`lib/store.js`) using Node.js `node:sqlite` (`DatabaseSync`).
- Dual FTS5 virtual tables: `porter unicode61` (stemmed terms & prose) and `trigram` (exact code symbols, filenames, substrings).
- BM25 + Trigram Reciprocal Rank Fusion (`RRF_K=60`) ranking algorithm.
- 8 Native Context Mode Tools:
  - `ctx_execute`: Sandboxed process execution with 16 KB output cap and intent-guided filtering.
  - `ctx_batch`: Batched command execution with unified FTS5 indexing.
  - `ctx_index`: Explicit indexing of files, URLs, and strings.
  - `ctx_search`: BM25+RRF snippet retrieval.
  - `ctx_resume`: Journal events and compact state blocks (<= 2048 B) across compaction.
  - `ctx_stats`: ASCII-rendered performance and token savings metrics.
  - `ctx_doctor`: Diagnostic health checks for Node, SQLite, and runtimes.
  - `ctx_purge`: Transactional data purging and database vacuuming.
- Automatic tool output interception (`lib/interceptor.js`) via DSH `tools/post-execute` lifecycle waterfall.
- Web UI settings page and metrics dashboard (`client.js`) injecting into `settings.section`.
- Vector SVG icon (`icon.svg`).
- English and Chinese i18n locales (`locale/en.json`, `locale/zh.json`).
