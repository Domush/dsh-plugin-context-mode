import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { executeCode, runProcess, OUTPUT_CAP } from "./executor.js";
import { SNIPPET_MAX_BYTES, STATE_BUDGET } from "./store.js";

const EXEC_PREVIEW_BYTES = 4096;

/** Fetch URL text content */
function fetchUrlText(urlStr, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    try {
      const parsed = new URL(urlStr);
      const client = parsed.protocol === "https:" ? https : http;
      const req = client.get(parsed, { timeout: timeoutMs }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return fetchUrlText(res.headers.location, timeoutMs).then(resolve, reject);
        }
        if (res.statusCode && res.statusCode >= 400) {
          return reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage}`));
        }
        const chunks = [];
        let total = 0;
        res.on("data", (c) => {
          total += c.byteLength;
          if (total <= 10 * 1024 * 1024) { // 10MB limit
            chunks.push(c);
          }
        });
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      });
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Request timed out"));
      });
    } catch (e) {
      reject(e);
    }
  });
}

/** Render helper for ASCII bar chart */
function renderBar(ratio, width = 24) {
  const filled = Math.min(width, Math.max(0, Math.round(ratio * width)));
  const empty = width - filled;
  return `[${"=".repeat(filled)}${" ".repeat(empty)}]`;
}

/** Format size nicely */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Build tools registry bound to store and active context */
export function createTools({ store, getCwd, getSessionId, getTurn }) {
  // 1. ctx_execute
  const ctxExecute = {
    name: "ctx_execute",
    description: "Execute Node.js, Python, or shell code with output bounding (16 KB cap). Outputs exceeding the cap are automatically indexed into SQLite FTS5; provide 'intent' to retrieve only the most relevant excerpts.",
    parameters: {
      type: "object",
      properties: {
        language: {
          type: "string",
          description: "Execution language or shell: 'nodejs', 'python', 'shell' (default), 'pwsh', or 'cmd'.",
          enum: ["nodejs", "python", "shell", "pwsh", "cmd"]
        },
        code: {
          type: "string",
          description: "Source code or command string to execute."
        },
        file: {
          type: "string",
          description: "Optional script file path to execute."
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Optional arguments to pass to the script."
        },
        intent: {
          type: "string",
          description: "Optional search query to filter and extract relevant output sections if output is large."
        },
        timeout_ms: {
          type: "number",
          description: "Execution timeout in milliseconds (default 30,000)."
        }
      },
      required: []
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          exit_code: { type: "number" },
          timed_out: { type: "boolean" },
          raw_bytes: { type: "number" },
          returned_bytes: { type: "number" },
          source_id: { type: "string" },
          output: { type: "string" }
        },
        required: ["ok", "exit_code", "raw_bytes", "returned_bytes", "output"]
      },
      render(args, value) {
        return [{ type: "text", text: value.output }];
      }
    },
    async execute(args, exec) {
      const cwd = getCwd(exec);
      const sessionId = getSessionId(exec);
      const turn = getTurn(exec);

      const res = await executeCode({
        language: args?.language || "shell",
        code: args?.code || "",
        file: args?.file || "",
        args: args?.args || [],
        cwd,
        timeoutMs: args?.timeout_ms
      });

      const fullOutput = res.stdout + (res.stderr ? (res.stdout ? "\n" : "") + res.stderr : "");
      const rawBytes = res.rawBytes || Buffer.byteLength(fullOutput, "utf8");
      const exceedsCap = rawBytes > OUTPUT_CAP;

      let sourceId = "";
      let returnedText = fullOutput;

      if (exceedsCap || args?.intent) {
        // Index full output into SQLite FTS5
        const label = `exec:${args?.language || "shell"}:${path.basename(args?.file || "snippet")}`;
        const indexRes = store.indexContent({
          sessionId,
          worktree: cwd,
          agent: exec?.agent?.name || "lead",
          kind: "exec",
          label,
          content: fullOutput
        });
        sourceId = indexRes.sourceId;

        const lines = [
          `[ctx_execute: completed (exit ${res.exitCode}, total output: ${formatBytes(rawBytes)})]`,
        ];

        if (args?.intent) {
          // Intent-guided retrieval
          const searchRes = store.search({
            queries: [args.intent],
            sourceId,
            sessionId,
            limit: 4
          });

          lines.push(`[Matched ${searchRes.totalMatches} excerpt(s) for intent "${args.intent}":]`, "");
          for (const hit of searchRes.hits) {
            lines.push(`--- Excerpt (rank: ${hit.rrfScore}) ---`, hit.snippet, "");
          }
        } else {
          // Preview head + pointer
          const preview = fullOutput.slice(0, EXEC_PREVIEW_BYTES);
          lines.push(
            `[Output exceeded 16 KB cap. Showing preview (${formatBytes(EXEC_PREVIEW_BYTES)} of ${formatBytes(rawBytes)}):]`,
            "",
            preview,
            "",
            `... [${formatBytes(rawBytes - EXEC_PREVIEW_BYTES)} truncated]`,
          );
        }

        lines.push(
          "",
          `[Context Mode: Full output indexed into SQLite FTS5 as source "${sourceId}". Use ctx_search({ queries: ["<query>"], source: "${sourceId}" }) to retrieve specific details.]`
        );
        returnedText = lines.join("\n");
      }

      const returnedBytes = Buffer.byteLength(returnedText, "utf8");

      store.recordEvent({
        sessionId,
        worktree: cwd,
        agent: exec?.agent?.name || "lead",
        kind: "cmd",
        tool: "ctx_execute",
        key: args?.language || "shell",
        path: args?.file || null,
        ok: res.ok ? 1 : 0,
        exitCode: res.exitCode,
        bytes: rawBytes,
        body: fullOutput.slice(0, 1000),
        turn,
        sandboxBytes: rawBytes,
        returnedBytes
      });

      return {
        ok: res.ok,
        exit_code: res.exitCode,
        timed_out: res.timedOut,
        raw_bytes: rawBytes,
        returned_bytes: returnedBytes,
        ...(sourceId ? { source_id: sourceId } : {}),
        output: returnedText
      };
    }
  };

  // 2. ctx_batch
  const ctxBatch = {
    name: "ctx_batch",
    description: "Execute multiple shell commands in batch, concatenate and index their outputs into SQLite FTS5, and optionally search matching sections across all outputs.",
    parameters: {
      type: "object",
      properties: {
        commands: {
          type: "array",
          items: { type: "string" },
          description: "List of shell commands to execute."
        },
        queries: {
          type: "array",
          items: { type: "string" },
          description: "Optional search queries to match and extract from the batched outputs."
        },
        stop_on_error: {
          type: "boolean",
          description: "Whether to abort subsequent commands if one fails (default false)."
        }
      },
      required: ["commands"]
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          total_commands: { type: "number" },
          source_id: { type: "string" },
          raw_bytes: { type: "number" },
          returned_bytes: { type: "number" },
          output: { type: "string" }
        },
        required: ["ok", "total_commands", "raw_bytes", "returned_bytes", "output"]
      },
      render(args, value) {
        return [{ type: "text", text: value.output }];
      }
    },
    async execute(args, exec) {
      const cwd = getCwd(exec);
      const sessionId = getSessionId(exec);
      const turn = getTurn(exec);
      const commands = Array.isArray(args?.commands) ? args.commands : [];

      if (commands.length === 0) {
        return {
          ok: false,
          total_commands: 0,
          raw_bytes: 0,
          returned_bytes: 0,
          output: "Error: No commands provided to ctx_batch."
        };
      }

      const outputParts = [];
      let allOk = true;

      for (let i = 0; i < commands.length; i++) {
        const cmdStr = commands[i];
        const res = await executeCode({ language: "shell", code: cmdStr, cwd });
        const cmdOutput = res.stdout + (res.stderr ? (res.stdout ? "\n" : "") + res.stderr : "");
        const partHeader = `=== [#${i + 1}] ${cmdStr} (exit ${res.exitCode}, ${formatBytes(res.rawBytes)}) ===`;
        outputParts.push(`${partHeader}\n${cmdOutput}`);

        if (!res.ok) {
          allOk = false;
          if (args?.stop_on_error) {
            outputParts.push(`\n[ctx_batch stopped early on command error]`);
            break;
          }
        }
      }

      const fullBatchText = outputParts.join("\n\n");
      const totalRawBytes = Buffer.byteLength(fullBatchText, "utf8");

      // Index into SQLite FTS5
      const indexRes = store.indexContent({
        sessionId,
        worktree: cwd,
        agent: exec?.agent?.name || "lead",
        kind: "batch",
        label: `batch:${commands.length}_cmds`,
        content: fullBatchText
      });

      const sourceId = indexRes.sourceId;
      let returnedText = fullBatchText;

      if (Array.isArray(args?.queries) && args.queries.length > 0) {
        const searchRes = store.search({
          queries: args.queries,
          sourceId,
          sessionId,
          limit: 6
        });

        const lines = [
          `[ctx_batch: executed ${commands.length} commands, total output ${formatBytes(totalRawBytes)}]`,
          `[Matched ${searchRes.totalMatches} excerpt(s) across commands for queries: ${args.queries.join(", ")}]`,
          ""
        ];

        for (const hit of searchRes.hits) {
          lines.push(`--- Snippet (score: ${hit.rrfScore}) ---`, hit.snippet, "");
        }
        lines.push(`[Indexed as "${sourceId}". Use ctx_search({ queries: [...], source: "${sourceId}" }) for more.]`);
        returnedText = lines.join("\n");
      } else if (totalRawBytes > OUTPUT_CAP) {
        const preview = fullBatchText.slice(0, EXEC_PREVIEW_BYTES);
        returnedText = [
          `[ctx_batch: executed ${commands.length} commands, total output ${formatBytes(totalRawBytes)}]`,
          `[Preview (${formatBytes(EXEC_PREVIEW_BYTES)} of ${formatBytes(totalRawBytes)}):]`,
          "",
          preview,
          "",
          `... [${formatBytes(totalRawBytes - EXEC_PREVIEW_BYTES)} truncated]`,
          `[Context Mode: Full output indexed into SQLite FTS5 as source "${sourceId}". Query with ctx_search.]`
        ].join("\n");
      }

      const returnedBytes = Buffer.byteLength(returnedText, "utf8");

      store.recordEvent({
        sessionId,
        worktree: cwd,
        agent: exec?.agent?.name || "lead",
        kind: "cmd",
        tool: "ctx_batch",
        key: `${commands.length}_cmds`,
        ok: allOk ? 1 : 0,
        bytes: totalRawBytes,
        turn,
        sandboxBytes: totalRawBytes,
        returnedBytes
      });

      return {
        ok: allOk,
        total_commands: commands.length,
        source_id: sourceId,
        raw_bytes: totalRawBytes,
        returned_bytes: returnedBytes,
        output: returnedText
      };
    }
  };

  // 3. ctx_index
  const ctxIndex = {
    name: "ctx_index",
    description: "Explicitly index a file path, raw text content, or web URL into SQLite FTS5 chunks for fast BM25+RRF semantic retrieval without filling the context window.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Local file path to read and index into SQLite FTS5."
        },
        content: {
          type: "string",
          description: "Raw text content string to index directly."
        },
        url: {
          type: "string",
          description: "Web URL (HTTP/HTTPS) to fetch and index."
        },
        source: {
          type: "string",
          description: "Optional custom identifier or title label for this source."
        }
      },
      required: []
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          source_id: { type: "string" },
          label: { type: "string" },
          bytes_total: { type: "number" },
          chunk_count: { type: "number" },
          message: { type: "string" }
        },
        required: ["ok", "source_id", "label", "bytes_total", "chunk_count", "message"]
      },
      render(args, value) {
        return [{ type: "text", text: value.message }];
      }
    },
    async execute(args, exec) {
      const cwd = getCwd(exec);
      const sessionId = getSessionId(exec);
      const turn = getTurn(exec);

      let textContent = "";
      let kind = "content";
      let label = args?.source || "manual_index";

      if (args?.path) {
        const filePath = path.isAbsolute(args.path) ? args.path : path.resolve(cwd, args.path);
        if (!fs.existsSync(filePath)) {
          throw new Error(`File not found: ${args.path}`);
        }
        textContent = fs.readFileSync(filePath, "utf8");
        kind = "path";
        label = args?.source || path.relative(cwd, filePath).replace(/\\/g, "/");
      } else if (args?.url) {
        textContent = await fetchUrlText(args.url);
        kind = "url";
        label = args?.source || args.url;
      } else if (args?.content) {
        textContent = String(args.content);
        kind = "content";
        label = args?.source || "raw_content";
      } else {
        throw new Error("Must provide 'path', 'url', or 'content' to ctx_index.");
      }

      const res = store.indexContent({
        sessionId,
        worktree: cwd,
        agent: exec?.agent?.name || "lead",
        kind,
        label,
        content: textContent,
        sourceId: args?.source
      });

      store.recordEvent({
        sessionId,
        worktree: cwd,
        agent: exec?.agent?.name || "lead",
        kind: "index",
        tool: "ctx_index",
        key: res.sourceId,
        path: args?.path || null,
        ok: 1,
        bytes: res.bytesTotal,
        turn,
        returnedBytes: 120
      });

      const msg = `Indexed "${label}" (${formatBytes(res.bytesTotal)}, ${res.chunkCount} chunks) into SQLite FTS5 as source "${res.sourceId}". Query using ctx_search({ queries: ["<query>"], source: "${res.sourceId}" }).`;

      return {
        ok: true,
        source_id: res.sourceId,
        label: res.label,
        bytes_total: res.bytesTotal,
        chunk_count: res.chunkCount,
        message: msg
      };
    }
  };

  // 4. ctx_search
  const ctxSearch = {
    name: "ctx_search",
    description: "Query indexed chunks in SQLite FTS5 using BM25 and Trigram Reciprocal Rank Fusion (RRF). Returns ranked snippets bounded to 800 bytes per chunk.",
    parameters: {
      type: "object",
      properties: {
        queries: {
          type: "array",
          items: { type: "string" },
          description: "Search queries, keywords, or code symbols."
        },
        source: {
          type: "string",
          description: "Optional source identifier to restrict the search."
        },
        scope: {
          type: "string",
          description: "Search scope: 'session' (current session, default), 'worktree' (workspace), or 'all'.",
          enum: ["session", "worktree", "all"]
        },
        limit: {
          type: "number",
          description: "Max number of snippets to return (1-20, default 5)."
        },
        offset: {
          type: "number",
          description: "Pagination offset (default 0)."
        }
      },
      required: ["queries"]
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          total_matches: { type: "number" },
          returned: { type: "number" },
          offset: { type: "number" },
          hits: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                source_id: { type: "string" },
                ord: { type: "number" },
                title: { type: "string" },
                score: { type: "number" },
                snippet: { type: "string" }
              },
              required: ["source_id", "ord", "title", "score", "snippet"]
            }
          },
          summary: { type: "string" }
        },
        required: ["total_matches", "returned", "offset", "hits", "summary"]
      },
      render(args, value) {
        return [{ type: "text", text: value.summary }];
      }
    },
    async execute(args, exec) {
      const cwd = getCwd(exec);
      const sessionId = getSessionId(exec);

      const queries = Array.isArray(args?.queries) ? args.queries : (args?.queries ? [String(args.queries)] : []);
      if (queries.length === 0) {
        throw new Error("Missing 'queries' array for ctx_search.");
      }

      const res = store.search({
        queries,
        sourceId: args?.source,
        sessionId,
        worktree: cwd,
        scope: args?.scope || "session",
        limit: args?.limit || 5,
        offset: args?.offset || 0
      });

      const lines = [
        `# Context Mode Search Results (${res.totalMatches} matches found, returning ${res.returned} snippets):`,
        ""
      ];

      for (let i = 0; i < res.hits.length; i++) {
        const hit = res.hits[i];
        lines.push(
          `### [Match #${res.offset + i + 1}] Source: \`${hit.sourceId}\` (chunk #${hit.ord}, RRF: ${hit.rrfScore})`,
          "```",
          hit.snippet,
          "```",
          ""
        );
      }

      if (res.totalMatches > res.offset + res.returned) {
        lines.push(`*(Call ctx_search with offset: ${res.offset + res.returned} to view next results)*`);
      }

      const summaryText = lines.join("\n");

      return {
        total_matches: res.totalMatches,
        returned: res.returned,
        offset: res.offset,
        hits: res.hits.map(h => ({
          source_id: h.sourceId,
          ord: h.ord,
          title: h.title,
          score: h.rrfScore,
          snippet: h.snippet
        })),
        summary: summaryText
      };
    }
  };

  // 5. ctx_resume
  const ctxResume = {
    name: "ctx_resume",
    description: "Retrieve session state block (<= 2048 B) or journal events to recover context continuity after compaction or across subagent boundaries.",
    parameters: {
      type: "object",
      properties: {
        seq: {
          type: "number",
          description: "Optional sequence number to retrieve events after."
        },
        limit: {
          type: "number",
          description: "Max journal events to retrieve (default 20)."
        }
      },
      required: []
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          session_id: { type: "string" },
          event_count: { type: "number" },
          state_block: { type: "string" }
        },
        required: ["session_id", "event_count", "state_block"]
      },
      render(args, value) {
        return [{ type: "text", text: value.state_block }];
      }
    },
    async execute(args, exec) {
      const cwd = getCwd(exec);
      const sessionId = getSessionId(exec);

      if (args?.seq !== undefined && args.seq >= 0) {
        const events = store.getEvents({
          sessionId,
          sinceSeq: args.seq,
          limit: args?.limit || 20
        });

        const lines = [`# Journal Events since #${args.seq} (${events.length} records):`];
        for (const e of events) {
          lines.push(`- \`#${e.seq}\` [${e.kind}] tool: ${e.tool || "none"} (${e.bytes}B raw -> ${e.returned_bytes}B ret) ok: ${e.ok}`);
        }

        return {
          session_id: sessionId,
          event_count: events.length,
          state_block: lines.join("\n")
        };
      }

      const stateBlock = store.generateResumeBlock({ sessionId, worktree: cwd });
      return {
        session_id: sessionId,
        event_count: 0,
        state_block: stateBlock
      };
    }
  };

  // 6. ctx_stats
  const ctxStats = {
    name: "ctx_stats",
    description: "Report Context Mode savings: raw bytes produced, bytes returned to context, kept-out bytes, and estimated token savings.",
    parameters: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          description: "Statistics scope: 'session' (current session), 'worktree' (workspace), or 'all' (default).",
          enum: ["session", "worktree", "all"]
        }
      },
      required: []
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          scope: { type: "string" },
          raw_bytes: { type: "number" },
          returned_bytes: { type: "number" },
          kept_out_bytes: { type: "number" },
          tokens_saved: { type: "number" },
          compression_ratio: { type: "string" },
          db_size_bytes: { type: "number" },
          report: { type: "string" }
        },
        required: ["scope", "raw_bytes", "returned_bytes", "kept_out_bytes", "tokens_saved", "compression_ratio", "report"]
      },
      render(args, value) {
        return [{ type: "text", text: value.report }];
      }
    },
    async execute(args, exec) {
      const cwd = getCwd(exec);
      const sessionId = getSessionId(exec);
      const scope = args?.scope || "all";

      const stats = store.getStats({ sessionId, worktree: cwd, scope });
      const savingsRatio = stats.rawBytes > 0 ? (stats.keptOutBytes / stats.rawBytes) : 0;
      const bar = renderBar(savingsRatio, 24);

      const reportLines = [
        `# Context Mode Performance & Savings (${stats.scope.toUpperCase()})`,
        "",
        `| Metric | Value |`,
        `| :--- | :--- |`,
        `| **Raw Data Intercepted** | ${stats.rawKb} KB (${stats.rawBytes.toLocaleString()} B) |`,
        `| **Sent to Context Window** | ${stats.returnedKb} KB (${stats.returnedBytes.toLocaleString()} B) |`,
        `| **Kept Out of Context** | **${stats.keptOutKb} KB** (${stats.keptOutBytes.toLocaleString()} B) |`,
        `| **Estimated Tokens Saved** | **~${stats.tokensSaved.toLocaleString()} tokens** |`,
        `| **Context Reduction Ratio** | **${stats.compressionRatio}%** |`,
        `| **Indexed Sources** | ${stats.totalSources} (${stats.totalChunks} chunks) |`,
        `| **Journal Events** | ${stats.totalEvents} |`,
        `| **SQLite DB Size** | ${stats.dbSizeKb} KB |`,
        "",
        `Savings: ${bar} ${stats.compressionRatio}% kept out of context window.`
      ];

      return {
        scope: stats.scope,
        raw_bytes: stats.rawBytes,
        returned_bytes: stats.returnedBytes,
        kept_out_bytes: stats.keptOutBytes,
        tokens_saved: stats.tokensSaved,
        compression_ratio: stats.compressionRatio,
        db_size_bytes: stats.dbSizeBytes,
        report: reportLines.join("\n")
      };
    }
  };

  // 7. ctx_doctor
  const ctxDoctor = {
    name: "ctx_doctor",
    description: "Run health diagnostics on Context Mode: verify Node.js runtime, SQLite FTS5 Porter/Trigram tokenizers, database integrity, and available script runtimes.",
    parameters: {
      type: "object",
      properties: {},
      required: []
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: { type: "string" },
          all_ok: { type: "boolean" },
          report: { type: "string" }
        },
        required: ["status", "all_ok", "report"]
      },
      render(args, value) {
        return [{ type: "text", text: value.report }];
      }
    },
    async execute(args, exec) {
      const doc = store.doctor();

      // Check external runtimes
      const pyCheck = await runProcess({ cmd: process.platform === "win32" ? "python" : "python3", args: ["--version"], timeoutMs: 3000 });
      doc.checks.push({
        id: "D6",
        name: "Python Environment",
        ok: pyCheck.ok,
        detail: pyCheck.ok ? (pyCheck.stdout || pyCheck.stderr).trim() : "Python not found in PATH"
      });

      const pwshCheck = await runProcess({ cmd: "powershell.exe", args: ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], timeoutMs: 3000 });
      doc.checks.push({
        id: "D7",
        name: "PowerShell Shell",
        ok: pwshCheck.ok,
        detail: pwshCheck.ok ? `PowerShell v${pwshCheck.stdout.trim()}` : "PowerShell not available"
      });

      const lines = [
        `# Context Mode Diagnostic Report [${doc.status}]`,
        ""
      ];

      for (const c of doc.checks) {
        const icon = c.ok ? "✓ PASS" : "✗ FAIL";
        lines.push(`- **[${c.id}] ${c.name}**: ${icon} — ${c.detail}`);
      }

      return {
        status: doc.status,
        all_ok: doc.allOk,
        report: lines.join("\n")
      };
    }
  };

  // 8. ctx_purge
  const ctxPurge = {
    name: "ctx_purge",
    description: "Purge indexed data from SQLite FTS5 storage by session ID, source identifier, worktree, or wipe all records.",
    parameters: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Optional session ID whose indexed chunks and events to purge."
        },
        source: {
          type: "string",
          description: "Optional source identifier to purge."
        },
        worktree: {
          type: "string",
          description: "Optional worktree path to purge."
        },
        all: {
          type: "boolean",
          description: "Wipe all Context Mode tables and vacuum database (default false)."
        }
      },
      required: []
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          message: { type: "string" }
        },
        required: ["ok", "message"]
      },
      render(args, value) {
        return [{ type: "text", text: value.message }];
      }
    },
    async execute(args, exec) {
      const sessionId = args?.session_id || (args?.all || args?.source || args?.worktree ? null : getSessionId(exec));
      const res = store.purge({
        sessionId,
        sourceId: args?.source,
        worktree: args?.worktree,
        all: args?.all
      });
      return res;
    }
  };

  return [
    ctxExecute,
    ctxBatch,
    ctxIndex,
    ctxSearch,
    ctxResume,
    ctxStats,
    ctxDoctor,
    ctxPurge
  ];
}
