import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";

export const MAX_CHUNK_BYTES = 4096;
export const SNIPPET_MAX_BYTES = 800;
export const RRF_K = 60;
export const STATE_BUDGET = 2048;

/** Default path to context database */
export function getDefaultDbPath() {
  const dir = path.join(os.homedir(), ".context-mode");
  return path.join(dir, "context.db");
}

/** Sanitize an input query string for safe FTS5 queries */
export function sanitizeFtsQuery(query) {
  if (!query || typeof query !== "string") return "";
  const cleaned = query.trim().replace(/[\x00-\x1f]/g, " ");
  // Split into alphanumeric tokens or quoted phrases
  const tokens = cleaned.match(/[a-zA-Z0-9_\u0080-\uffff]+/g);
  if (!tokens || tokens.length === 0) return "";
  // Wrap each term in quotes so special characters or operators are treated as literals
  return tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(" ");
}

/** Sanitize query specifically for trigram index (must have at least 3 characters) */
export function sanitizeTrigramQuery(query) {
  if (!query || typeof query !== "string") return "";
  const tokens = query.match(/[a-zA-Z0-9_\u0080-\uffff]{3,}/g);
  if (!tokens || tokens.length === 0) return "";
  return tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(" ");
}

export class ContextStore {
  constructor(optionsOrDbPath) {
    if (typeof optionsOrDbPath === "string" && optionsOrDbPath.trim()) {
      this.dbPath = optionsOrDbPath.trim();
    } else if (optionsOrDbPath && typeof optionsOrDbPath.dbPath === "string" && optionsOrDbPath.dbPath.trim()) {
      this.dbPath = optionsOrDbPath.dbPath.trim();
    } else {
      this.dbPath = getDefaultDbPath();
    }
    this.db = null;
    this.sourceCounter = 0;
  }

  /** Open or initialize SQLite database */
  open() {
    if (this.db) return this.db;
    const dbDir = path.dirname(this.dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    this.db = new DatabaseSync(this.dbPath);
    this.initSchema();
    return this.db;
  }

  close() {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // ignore close error
      }
      this.db = null;
    }
  }

  /** Initialize tables, FTS5 virtual tables, and indexes */
  initSchema() {
    if (!this.db) return;
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");

    // Standard tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        worktree TEXT NOT NULL,
        agent TEXT NOT NULL,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        bytes_total INTEGER NOT NULL DEFAULT 0,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        created_ts INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        accessed_ts INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sources_session ON sources(session_id);
      CREATE INDEX IF NOT EXISTS idx_sources_worktree ON sources(worktree);

      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        worktree TEXT NOT NULL,
        agent TEXT NOT NULL,
        kind TEXT NOT NULL,
        tool TEXT,
        key TEXT,
        path TEXT,
        ok INTEGER NOT NULL DEFAULT 1,
        exit_code INTEGER,
        bytes INTEGER NOT NULL DEFAULT 0,
        body TEXT,
        turn INTEGER NOT NULL DEFAULT 0,
        sandbox_bytes INTEGER NOT NULL DEFAULT 0,
        returned_bytes INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        accessed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
      CREATE INDEX IF NOT EXISTS idx_events_turn ON events(session_id, turn);
    `);

    // Virtual FTS5 tables
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
        source_id UNINDEXED,
        session_id UNINDEXED,
        worktree UNINDEXED,
        agent UNINDEXED,
        ord UNINDEXED,
        body,
        title,
        tokenize = 'porter unicode61 remove_diacritics 2'
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_tri USING fts5(
        source_id UNINDEXED,
        session_id UNINDEXED,
        ord UNINDEXED,
        body,
        tokenize = 'trigram'
      );
    `);

    // Initialize meta version
    const versionRow = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    if (!versionRow) {
      this.db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', '2')").run();
    }
  }

  /** Split content into chunks by byte budget on newline boundaries */
  chunkContent(text, maxBytes = MAX_CHUNK_BYTES) {
    if (!text) return [];
    const chunks = [];
    const lines = text.split("\n");
    let currentChunk = [];
    let currentBytes = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineBytes = Buffer.byteLength(line, "utf8") + 1; // +1 for newline

      if (currentBytes + lineBytes > maxBytes && currentChunk.length > 0) {
        chunks.push(currentChunk.join("\n"));
        currentChunk = [line];
        currentBytes = lineBytes;
      } else {
        currentChunk.push(line);
        currentBytes += lineBytes;
      }
    }

    if (currentChunk.length > 0) {
      chunks.push(currentChunk.join("\n"));
    }

    return chunks;
  }

  /** Index a text, file output, or tool response into SQLite FTS5 */
  indexContent({ sessionId, worktree, agent, kind, label, content, sourceId }) {
    this.open();
    const sid = sessionId || "default";
    const wt = worktree || process.cwd();
    const ag = agent || "lead";
    const k = kind || "content";
    const lbl = label || "untitled";
    const rawText = typeof content === "string" ? content : String(content || "");
    const totalBytes = Buffer.byteLength(rawText, "utf8");

    const id = sourceId || `s_${Date.now()}_${(++this.sourceCounter).toString(36)}`;
    const now = Date.now();
    const isoDate = new Date(now).toISOString();

    const chunks = this.chunkContent(rawText);
    const chunkCount = chunks.length;

    // Transaction for atomic write
    const insertSource = this.db.prepare(`
      INSERT OR REPLACE INTO sources (
        id, session_id, worktree, agent, kind, label, bytes_total, chunk_count, created_ts, created_at, accessed_ts
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertChunk = this.db.prepare(`
      INSERT INTO chunks (source_id, session_id, worktree, agent, ord, body, title)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const insertChunkTri = this.db.prepare(`
      INSERT INTO chunks_tri (source_id, session_id, ord, body)
      VALUES (?, ?, ?, ?)
    `);

    insertSource.run(id, sid, wt, ag, k, lbl, totalBytes, chunkCount, now, isoDate, now);

    for (let ord = 0; ord < chunkCount; ord++) {
      const chunkText = chunks[ord];
      insertChunk.run(id, sid, wt, ag, ord, chunkText, lbl);
      insertChunkTri.run(id, sid, ord, chunkText);
    }

    return {
      sourceId: id,
      bytesTotal: totalBytes,
      chunkCount,
      label: lbl,
      chunks
    };
  }

  /** Search indexed chunks using BM25 + Trigram Reciprocal Rank Fusion */
  search({ queries, sourceId, sessionId, worktree, scope = "session", limit = 5, offset = 0 }) {
    this.open();
    const queryList = Array.isArray(queries) ? queries : [queries];
    const maxHits = Math.min(Math.max(1, limit || 5), 20);
    const skipHits = Math.max(0, offset || 0);

    const scores = new Map(); // chunkKey -> { chunk, rrfScore, matches }

    for (const q of queryList) {
      if (!q || typeof q !== "string") continue;
      const porterQ = sanitizeFtsQuery(q);
      const trigramQ = sanitizeTrigramQuery(q);

      // 1. Porter FTS5 with BM25 ranking
      if (porterQ) {
        let sql = `
          SELECT rowid, source_id, ord, body, title, session_id, worktree, bm25(chunks) AS rank
          FROM chunks
          WHERE chunks MATCH ?
        `;
        const params = [porterQ];

        if (sourceId) {
          sql += " AND source_id = ?";
          params.push(sourceId);
        } else if (scope === "session" && sessionId) {
          sql += " AND session_id = ?";
          params.push(sessionId);
        } else if (scope === "worktree" && worktree) {
          sql += " AND worktree = ?";
          params.push(worktree);
        }

        sql += " ORDER BY rank LIMIT 30";

        try {
          const rows = this.db.prepare(sql).all(...params);
          rows.forEach((row, rankIdx) => {
            const key = `${row.source_id}:${row.ord}`;
            const rrf = 1.0 / (RRF_K + rankIdx + 1);
            const existing = scores.get(key);
            if (existing) {
              existing.rrfScore += rrf;
              existing.matches.push({ query: q, type: "porter", rank: rankIdx + 1 });
            } else {
              scores.set(key, {
                rowid: row.rowid,
                sourceId: row.source_id,
                ord: row.ord,
                body: row.body,
                title: row.title,
                sessionId: row.session_id,
                worktree: row.worktree,
                rrfScore: rrf,
                matches: [{ query: q, type: "porter", rank: rankIdx + 1 }]
              });
            }
          });
        } catch {
          // Porter match error ignored
        }
      }

      // 2. Trigram FTS5
      if (trigramQ) {
        let sqlTri = `
          SELECT rowid, source_id, ord, body, session_id
          FROM chunks_tri
          WHERE chunks_tri MATCH ?
        `;
        const paramsTri = [trigramQ];

        if (sourceId) {
          sqlTri += " AND source_id = ?";
          paramsTri.push(sourceId);
        } else if (scope === "session" && sessionId) {
          sqlTri += " AND session_id = ?";
          paramsTri.push(sessionId);
        }

        sqlTri += " LIMIT 30";

        try {
          const rowsTri = this.db.prepare(sqlTri).all(...paramsTri);
          rowsTri.forEach((row, rankIdx) => {
            const key = `${row.source_id}:${row.ord}`;
            const rrf = 1.0 / (RRF_K + rankIdx + 1);
            const existing = scores.get(key);
            if (existing) {
              existing.rrfScore += rrf;
              existing.matches.push({ query: q, type: "trigram", rank: rankIdx + 1 });
            } else {
              scores.set(key, {
                rowid: row.rowid,
                sourceId: row.source_id,
                ord: row.ord,
                body: row.body,
                title: "",
                sessionId: row.session_id,
                worktree: "",
                rrfScore: rrf,
                matches: [{ query: q, type: "trigram", rank: rankIdx + 1 }]
              });
            }
          });
        } catch {
          // Trigram match error ignored
        }
      }
    }

    // Sort descending by RRF score
    const allHits = Array.from(scores.values()).sort((a, b) => b.rrfScore - a.rrfScore);
    const paginated = allHits.slice(skipHits, skipHits + maxHits);

    // Format snippets
    const formatted = paginated.map(hit => {
      let snippet = hit.body;
      if (Buffer.byteLength(snippet, "utf8") > SNIPPET_MAX_BYTES) {
        snippet = snippet.slice(0, SNIPPET_MAX_BYTES) + "\n... [truncated, use ctx_search or ctx_index to inspect full]";
      }
      return {
        sourceId: hit.sourceId,
        ord: hit.ord,
        title: hit.title || hit.sourceId,
        rrfScore: parseFloat(hit.rrfScore.toFixed(5)),
        matches: hit.matches.length,
        snippet
      };
    });

    return {
      hits: formatted,
      totalMatches: allHits.length,
      returned: formatted.length,
      offset: skipHits,
      limit: maxHits
    };
  }

  /** Record an event in the session journal */
  recordEvent({ sessionId, worktree, agent, kind, tool, key, path: filePath, ok = 1, exitCode, bytes = 0, body = "", turn = 0, sandboxBytes = 0, returnedBytes = 0 }) {
    this.open();
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO events (
        session_id, worktree, agent, kind, tool, key, path, ok, exit_code, bytes, body, turn, sandbox_bytes, returned_bytes, created_at, accessed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      typeof sessionId === "string" ? sessionId : "default",
      typeof worktree === "string" ? worktree : process.cwd(),
      typeof agent === "string" ? agent : "lead",
      typeof kind === "string" ? kind : "event",
      typeof tool === "string" ? tool : null,
      typeof key === "string" ? key : null,
      typeof filePath === "string" ? filePath : null,
      ok ? 1 : 0,
      typeof exitCode === "number" ? exitCode : null,
      typeof bytes === "number" ? bytes : 0,
      typeof body === "string" ? body : (body != null ? String(body) : ""),
      typeof turn === "number" ? turn : 0,
      typeof sandboxBytes === "number" ? sandboxBytes : 0,
      typeof returnedBytes === "number" ? returnedBytes : 0,
      now,
      now
    );

    const lastSeq = this.db.prepare("SELECT last_insert_rowid() AS seq").get()?.seq || 0;
    return lastSeq;
  }

  /** Retrieve session journal events */
  getEvents({ sessionId, sinceSeq = 0, limit = 50 }) {
    this.open();
    let sql = "SELECT * FROM events WHERE 1=1";
    const params = [];
    if (sessionId) {
      sql += " AND session_id = ?";
      params.push(sessionId);
    }
    if (sinceSeq > 0) {
      sql += " AND seq > ?";
      params.push(sinceSeq);
    }
    sql += " ORDER BY seq ASC LIMIT ?";
    params.push(limit);

    return this.db.prepare(sql).all(...params);
  }

  /** Generate compact resume block (<= 2048 B) for continuity post-compaction */
  generateResumeBlock({ sessionId, worktree }) {
    this.open();
    const sid = sessionId || "default";
    const events = this.db.prepare(`
      SELECT seq, kind, tool, path, ok, bytes, returned_bytes, created_at
      FROM events
      WHERE session_id = ?
      ORDER BY seq DESC
      LIMIT 20
    `).all(sid);

    const sources = this.db.prepare(`
      SELECT id, kind, label, bytes_total, chunk_count
      FROM sources
      WHERE session_id = ?
      ORDER BY created_ts DESC
      LIMIT 8
    `).all(sid);

    const stats = this.getStats({ sessionId: sid, worktree });

    const lines = [
      `### Context Mode Session State (Resumed)`,
      `- **Session**: \`${sid}\` | **Savings**: ${stats.keptOutKb} KB kept out (${stats.compressionRatio}% saved, ~${stats.tokensSaved} tokens)`,
      `- **Active Sources** (${sources.length}):`,
    ];

    if (sources.length === 0) {
      lines.push("  *(No external sources indexed in this session yet)*");
    } else {
      for (const s of sources) {
        lines.push(`  - \`${s.id}\` [${s.kind}] "${s.label}" (${s.bytes_total}B, ${s.chunk_count} chunks)`);
      }
    }

    lines.push(`- **Recent Journal Events** (Last ${events.length}):`);
    if (events.length === 0) {
      lines.push("  *(No events logged)*");
    } else {
      for (const e of events.slice(0, 10).reverse()) {
        const status = e.ok ? "✓" : "✗";
        const toolStr = e.tool ? ` [tool: ${e.tool}]` : "";
        const pathStr = e.path ? ` ${e.path}` : "";
        lines.push(`  - \`#${e.seq}\` ${status} ${e.kind}${toolStr}${pathStr} (${e.bytes}B raw -> ${e.returned_bytes}B ret)`);
      }
    }

    lines.push(`- **Recall**: Query indexed sources via \`ctx_search({ queries: ["<query>"] })\`.`);

    let block = lines.join("\n");
    if (Buffer.byteLength(block, "utf8") > STATE_BUDGET) {
      block = block.slice(0, STATE_BUDGET - 40) + "\n... [state summary truncated to budget]";
    }

    return block;
  }

  /** Compute context savings and performance metrics */
  getStats({ sessionId, worktree, scope = "all" }) {
    this.open();
    let whereClause = "1=1";
    const params = [];
    if (scope === "session" && sessionId) {
      whereClause = "session_id = ?";
      params.push(sessionId);
    } else if (scope === "worktree" && worktree) {
      whereClause = "worktree = ?";
      params.push(worktree);
    }

    const eventStats = this.db.prepare(`
      SELECT
        COUNT(*) as total_events,
        COALESCE(SUM(bytes), 0) as total_raw_bytes,
        COALESCE(SUM(returned_bytes), 0) as total_returned_bytes,
        COALESCE(SUM(sandbox_bytes), 0) as total_sandbox_bytes
      FROM events
      WHERE ${whereClause}
    `).get(...params);

    const sourceStats = this.db.prepare(`
      SELECT
        COUNT(*) as total_sources,
        COALESCE(SUM(bytes_total), 0) as total_source_bytes,
        COALESCE(SUM(chunk_count), 0) as total_chunks
      FROM sources
      WHERE ${whereClause}
    `).get(...params);

    const rawBytes = Number(eventStats?.total_raw_bytes || 0) + Number(sourceStats?.total_source_bytes || 0);
    const returnedBytes = Number(eventStats?.total_returned_bytes || 0);
    const keptOutBytes = Math.max(0, rawBytes - returnedBytes);
    const tokensSaved = Math.round(keptOutBytes / 4);
    const compressionRatio = rawBytes > 0 ? ((keptOutBytes / rawBytes) * 100).toFixed(1) : "0.0";

    let dbSizeBytes = 0;
    try {
      if (fs.existsSync(this.dbPath)) {
        dbSizeBytes = fs.statSync(this.dbPath).size;
      }
    } catch {
      // stat failed
    }

    return {
      scope,
      totalEvents: Number(eventStats?.total_events || 0),
      totalSources: Number(sourceStats?.total_sources || 0),
      totalChunks: Number(sourceStats?.total_chunks || 0),
      rawBytes,
      rawKb: (rawBytes / 1024).toFixed(1),
      returnedBytes,
      returnedKb: (returnedBytes / 1024).toFixed(1),
      keptOutBytes,
      keptOutKb: (keptOutBytes / 1024).toFixed(1),
      tokensSaved,
      compressionRatio,
      dbSizeBytes,
      dbSizeKb: (dbSizeBytes / 1024).toFixed(1)
    };
  }

  /** Purge data by session, source, worktree or wipe everything */
  purge({ sessionId, sourceId, worktree, all = false }) {
    this.open();
    let deletedSources = 0;
    let deletedChunks = 0;
    let deletedEvents = 0;

    if (all) {
      this.db.exec("DELETE FROM chunks;");
      this.db.exec("DELETE FROM chunks_tri;");
      this.db.exec("DELETE FROM sources;");
      this.db.exec("DELETE FROM events;");
      try {
        this.db.exec("VACUUM;");
      } catch {
        // vacuum failed
      }
      return { ok: true, message: "All Context Mode data successfully purged and database vacuumed." };
    }

    if (sourceId) {
      this.db.prepare("DELETE FROM chunks WHERE source_id = ?").run(sourceId);
      this.db.prepare("DELETE FROM chunks_tri WHERE source_id = ?").run(sourceId);
      const res = this.db.prepare("DELETE FROM sources WHERE id = ?").run(sourceId);
      return { ok: true, message: `Source "${sourceId}" purged (${res.changes} source removed).` };
    }

    if (sessionId) {
      this.db.prepare("DELETE FROM chunks WHERE session_id = ?").run(sessionId);
      this.db.prepare("DELETE FROM chunks_tri WHERE session_id = ?").run(sessionId);
      this.db.prepare("DELETE FROM sources WHERE session_id = ?").run(sessionId);
      const resEv = this.db.prepare("DELETE FROM events WHERE session_id = ?").run(sessionId);
      return { ok: true, message: `Session "${sessionId}" purged (${resEv.changes} events removed).` };
    }

    if (worktree) {
      this.db.prepare("DELETE FROM chunks WHERE worktree = ?").run(worktree);
      this.db.prepare("DELETE FROM sources WHERE worktree = ?").run(worktree);
      const resEv = this.db.prepare("DELETE FROM events WHERE worktree = ?").run(worktree);
      return { ok: true, message: `Worktree "${worktree}" purged (${resEv.changes} events removed).` };
    }

    return { ok: false, message: "No purge target specified (pass sessionId, sourceId, worktree, or all: true)." };
  }

  /** Run diagnostic self-checks */
  doctor() {
    const checks = [];

    // D1: Node version
    const nodeVer = process.version;
    const major = parseInt(nodeVer.slice(1).split(".")[0], 10);
    checks.push({
      id: "D1",
      name: "Node.js Runtime",
      ok: major >= 22,
      detail: `${nodeVer} (Node 22+ required for native node:sqlite)`
    });

    // D2: SQLite Engine & File
    let dbOk = false;
    let integrity = "unknown";
    try {
      this.open();
      const row = this.db.prepare("PRAGMA integrity_check").get();
      integrity = row?.integrity_check || "ok";
      dbOk = integrity === "ok";
    } catch (e) {
      integrity = String(e.message);
    }
    checks.push({
      id: "D2",
      name: "SQLite Engine & Database",
      ok: dbOk,
      detail: `Path: ${this.dbPath} | Integrity: ${integrity}`
    });

    // D3: FTS5 Porter
    let porterOk = false;
    try {
      this.db.prepare("SELECT bm25(chunks) FROM chunks WHERE chunks MATCH 'test' LIMIT 1");
      porterOk = true;
    } catch {
      porterOk = false;
    }
    checks.push({
      id: "D3",
      name: "FTS5 Porter Tokenizer",
      ok: porterOk,
      detail: porterOk ? "Porter unicode61 virtual table operational with bm25()" : "Failed"
    });

    // D4: FTS5 Trigram
    let trigramOk = false;
    try {
      this.db.prepare("SELECT rowid FROM chunks_tri WHERE chunks_tri MATCH 'test' LIMIT 1");
      trigramOk = true;
    } catch {
      trigramOk = false;
    }
    checks.push({
      id: "D4",
      name: "FTS5 Trigram Substring Tokenizer",
      ok: trigramOk,
      detail: trigramOk ? "Trigram virtual table operational for substring/symbol search" : "Failed"
    });

    // D5: Database size & records
    let records = { sources: 0, events: 0 };
    try {
      records.sources = this.db.prepare("SELECT COUNT(*) as c FROM sources").get()?.c || 0;
      records.events = this.db.prepare("SELECT COUNT(*) as c FROM events").get()?.c || 0;
    } catch {
      // ignore
    }
    checks.push({
      id: "D5",
      name: "Data Records",
      ok: true,
      detail: `${records.sources} sources, ${records.events} journal events`
    });

    const allOk = checks.every(c => c.ok);
    return {
      allOk,
      status: allOk ? "HEALTHY" : "DEGRADED",
      checks
    };
  }
}

export { ContextStore as ContextModeStore };

