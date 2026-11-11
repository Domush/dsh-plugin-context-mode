import path from "node:path";
import { formatBytes } from "./tools.js";

export const DEFAULT_REPLACE_TRIGGER_BYTES = 4096; // 4 KB
const HEAD_PREVIEW_BYTES = 1200;
const TAIL_PREVIEW_BYTES = 300;

// Internal tools to never intercept
const EXCLUDED_TOOLS = new Set([
  "ctx_execute",
  "ctx_batch",
  "ctx_index",
  "ctx_search",
  "ctx_resume",
  "ctx_stats",
  "ctx_doctor",
  "ctx_purge",
  "compress",
  "decompress",
  "search_context",
  "acp_status",
  "todo_write",
  "ask_user_question",
  "read_image",
  "image_generate",
  "video_generate",
  "plugin_manager",
  "schedule_create",
  "schedule_edit",
  "schedule_list",
  "schedule_view"
]);

/** Extract plain text string from any tool result representation */
export function extractResultText(result) {
  if (!result) return "";
  if (typeof result === "string") return result;

  // Array of content parts: [{ type: 'text', text: '...' }]
  if (Array.isArray(result.content)) {
    return result.content
      .map(part => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  if (typeof result.content === "string") {
    return result.content;
  }

  if (typeof result.output === "string") {
    return result.output;
  }

  if (typeof result.value === "string") {
    return result.value;
  }

  if (typeof result.text === "string") {
    return result.text;
  }

  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/** In-flight sequence generator */
let interceptSeq = 0;

/** Handle post-execution tool interception to prevent context bloat */
export function interceptToolResult({ exec, result, store, config, getCwd, getSessionId, getTurn }) {
  if (!config.autoIntercept) return null;
  if (result?.isError) return null;
  if (Array.isArray(result?.content) && result.content.some(part => part && part.type === "image")) return null;

  const toolName = exec?.name || "";
  if (EXCLUDED_TOOLS.has(toolName)) return null;

  const rawText = extractResultText(result);
  const rawBytes = Buffer.byteLength(rawText, "utf8");
  const triggerBytes = config.replaceTriggerBytes || DEFAULT_REPLACE_TRIGGER_BYTES;

  if (rawBytes <= triggerBytes) {
    // Normal size, do not replace
    return null;
  }

  // Intercept and index into SQLite FTS5
  const cwd = getCwd(exec);
  const sessionId = getSessionId(exec);
  const turn = getTurn(exec);
  const seq = ++interceptSeq;
  const sourceId = `tool_${toolName}_s${seq}_${Date.now().toString(36)}`;

  const indexRes = store.indexContent({
    sessionId,
    worktree: cwd,
    agent: exec?.agent?.name || "lead",
    kind: "tool_output",
    label: `${toolName}:${seq}`,
    content: rawText,
    sourceId
  });

  // Generate preview
  const head = rawText.slice(0, HEAD_PREVIEW_BYTES);
  const tail = rawText.slice(Math.max(0, rawText.length - TAIL_PREVIEW_BYTES));
  const omittedBytes = rawBytes - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8");

  const replacementLines = [
    `[Context Mode: Output from "${toolName}" was ${formatBytes(rawBytes)} (exceeded ${formatBytes(triggerBytes)} context threshold).]`,
    `[Full output safely indexed into SQLite FTS5 as source "${sourceId}" (${indexRes.chunkCount} chunks).]`,
    "",
    "--- Output Preview (Head) ---",
    head,
    "",
    `... [${formatBytes(omittedBytes)} omitted to protect context window] ...`,
    "",
    "--- Output Preview (Tail) ---",
    tail,
    "",
    `[Inspect any section with zero context pollution: ctx_search({ queries: ["<keyword>"], source: "${sourceId}" }) or ctx_resume()]`
  ];

  const replacementText = replacementLines.join("\n");
  const returnedBytes = Buffer.byteLength(replacementText, "utf8");

  store.recordEvent({
    sessionId,
    worktree: cwd,
    agent: exec?.agent?.name || "lead",
    kind: "output_replaced",
    tool: toolName,
    key: sourceId,
    path: exec?.arguments?.file_path || exec?.arguments?.path || null,
    ok: 1,
    bytes: rawBytes,
    body: replacementText.slice(0, 500),
    turn,
    sandboxBytes: rawBytes,
    returnedBytes
  });

  return {
    sourceId,
    rawBytes,
    returnedBytes,
    replacementText
  };
}

/** Authoritative System Prompt Section for Context Mode */
export const CONTEXT_MODE_SYSTEM_PROMPT = `
# Context Mode: High-Efficiency Context & FTS5 Indexing Active
This session is equipped with native **Context Mode** (https://github.com/mksglu/context-mode), a local offline SQLite FTS5 context optimization engine that protects the context window from bloat, degradation, and context limits.

### Native Context Mode Tools
1. \`ctx_execute\`: Execute Node.js, Python, or shell code with output bounding (16 KB cap). If output exceeds 16 KB or 'intent' is provided, full output is indexed into SQLite FTS5 and only relevant excerpts are returned.
2. \`ctx_batch\`: Run multiple shell commands in batch, indexing all outputs and returning matched snippets.
3. \`ctx_index\`: Explicitly index local files, raw text, or web URLs into SQLite FTS5 chunks for BM25+RRF semantic retrieval without pasting large files into context.
4. \`ctx_search\`: Query indexed chunks across sessions or worktrees using BM25 and Trigram Reciprocal Rank Fusion (RRF). Returns ranked snippets bounded to 800 bytes.
5. \`ctx_resume\`: Retrieve compact session state block (<= 2048 B) or journal events after context compaction to maintain continuity without re-reading files.
6. \`ctx_stats\`: View real-time analytics on data intercepted, kept-out bytes, and estimated token savings.
7. \`ctx_doctor\`: Run health diagnostics verifying Node.js, SQLite FTS5 tokenizers, and script runtimes.
8. \`ctx_purge\`: Clean up indexed sources or wipe Context Mode tables.

### Automatic Output Protection
Any standard tool output exceeding the configured threshold (default 4 KB) is automatically intercepted and indexed into SQLite FTS5, with a preview and search handle returned. Use \`ctx_search\` with the provided \`source\` identifier to inspect specific sections.
`.trim();
