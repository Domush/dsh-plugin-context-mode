import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { ContextModeStore } from "./lib/store.js";
import { createTools } from "./lib/tools.js";
import {
  interceptToolResult,
  extractResultText,
  CONTEXT_MODE_SYSTEM_PROMPT,
  DEFAULT_REPLACE_TRIGGER_BYTES
} from "./lib/interceptor.js";

export const name = "dsh-plugin-context-mode";

// Schemastery loader with fallback
let ConfigSchema = null;
try {
  const profileDir = process.env.DSH_PROFILE_DIR || path.join(os.homedir(), ".dsh", "profiles", "web");
  const req = createRequire(path.join(profileDir, "package.json"));
  const z = req("@deepseek-ai/schemastery");
  if (z && typeof z.object === "function") {
    ConfigSchema = z.object({
      enabled: z.boolean().default(true).description("Enable Context Mode context protection and SQLite FTS5 engine"),
      autoIntercept: z.boolean().default(true).description("Automatically intercept large tool outputs and index into SQLite FTS5"),
      replaceTriggerBytes: z.number().default(DEFAULT_REPLACE_TRIGGER_BYTES).description("Byte threshold to trigger output truncation & indexing (default 4096)"),
      injectSystemPrompt: z.boolean().default(true).description("Inject Context Mode instructions into system prompt"),
      dbPath: z.string().default("").description("Custom SQLite database file path (defaults to ~/.context-mode/context.db)")
    });
  }
} catch {
  // Plain config fallback
}

export const Config = ConfigSchema;

export const inject = ["systemPrompt", "tools", "workingDirectory", "agents", "webServer", "workspaceRegistry"];

/** Normalize config object */
function normalizeConfig(raw) {
  return {
    enabled: raw?.enabled !== false,
    autoIntercept: raw?.autoIntercept !== false,
    replaceTriggerBytes: typeof raw?.replaceTriggerBytes === "number" ? raw.replaceTriggerBytes : DEFAULT_REPLACE_TRIGGER_BYTES,
    injectSystemPrompt: raw?.injectSystemPrompt !== false,
    dbPath: typeof raw?.dbPath === "string" && raw.dbPath.trim() ? raw.dbPath.trim() : ""
  };
}

/** Helper to read request body */
async function readBoundedBody(req, limitBytes = 1024 * 1024) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.byteLength;
      if (total <= limitBytes) chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

/** Helper to send JSON response */
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(body, "utf8"));
  res.end(body);
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  if (!config.enabled) return;

  // Initialize SQLite FTS5 Store
  const store = new ContextModeStore({ dbPath: config.dbPath || undefined });

  // Context extraction helpers
  const getCwd = (exec) => {
    try {
      if (exec?.workspaceDir) return exec.workspaceDir;
      if (exec?.agent?.session && ctx.workingDirectory?.get) {
        return ctx.workingDirectory.get(exec.agent.session);
      }
      if (ctx.workingDirectory?.get) {
        return ctx.workingDirectory.get();
      }
    } catch {}
    return process.cwd();
  };

  const getSessionId = (exec) => {
    return exec?.agent?.session?.id || exec?.session?.id || exec?.sessionId || "default";
  };

  const getTurn = (exec) => {
    if (typeof exec?.turn === "number") return exec.turn;
    if (typeof exec?.agent?.currentTurn === "number") return exec.agent.currentTurn;
    return 0;
  };

  // 1. Register Native Context Mode Tools
  const tools = createTools({ store, getCwd, getSessionId, getTurn });
  for (const tool of tools) {
    ctx.tools.register(tool);
  }

  // 2. Inject System Prompt Guidelines
  if (config.injectSystemPrompt && ctx.systemPrompt?.section) {
    ctx.systemPrompt.section({
      name: "context-mode",
      order: 15,
      interpolate: false,
      text: CONTEXT_MODE_SYSTEM_PROMPT
    });
  }

  // 3. Post-execution Tool Interceptor
  if (config.autoIntercept) {
    // Intercept waterfall event before output enters conversation context
    ctx.on("tools/post-execute", async (exec, result, next) => {
      const decision = (typeof next === "function" ? await next() : null) ?? { kind: "accept" };
      if (!config.autoIntercept || decision?.kind === "block") {
        return decision;
      }

      try {
        const interception = interceptToolResult({
          exec,
          result,
          store,
          config,
          getCwd,
          getSessionId,
          getTurn
        });

        if (interception && interception.replacementText) {
          return {
            ...decision,
            kind: "accept",
            content: [{ type: "text", text: interception.replacementText }]
          };
        }
      } catch (err) {
        ctx.logger?.warn?.("[context-mode] intercept error:", err);
      }

      return decision;
    });

    // Also record standard tool executions for telemetry
    ctx.on("tools/result", (exec, result) => {
      try {
        if (!result?.isError && exec?.name && !exec.name.startsWith("ctx_")) {
          const rawText = extractResultText(result);
          const bytes = Buffer.byteLength(rawText, "utf8");
          store.recordEvent({
            sessionId: getSessionId(exec),
            worktree: getCwd(exec),
            agent: exec?.agent?.name || "lead",
            kind: "cmd",
            tool: exec.name,
            key: exec.name,
            path: exec?.arguments?.file_path || exec?.arguments?.path || null,
            ok: 1,
            bytes,
            turn: getTurn(exec),
            returnedBytes: bytes
          });
        }
      } catch {}
    });
  }

  // 4. REST API Endpoints for UI & Monitoring
  if (ctx.webServer) {
    ctx.effect(() => ctx.webServer.register({
      kind: "exact",
      path: "/api/context-mode",
      handler: async (req, res) => {
        try {
          const urlObj = new URL(String(req.url), "http://localhost");
          const action = urlObj.searchParams.get("action") || "stats";
          const scope = urlObj.searchParams.get("scope") || "all";
          const queryCwd = urlObj.searchParams.get("cwd") || process.cwd();

          if (req.method === "GET") {
            if (action === "doctor") {
              const doc = store.doctor();
              return sendJson(res, 200, { ok: true, doctor: doc });
            }

            if (action === "events") {
              const limit = Number(urlObj.searchParams.get("limit") || 50);
              const events = store.getEvents({ limit });
              return sendJson(res, 200, { ok: true, events });
            }

            // Default: stats
            const stats = store.getStats({ worktree: queryCwd, scope });
            return sendJson(res, 200, { ok: true, stats, config });
          }

          if (req.method === "POST") {
            const bodyText = await readBoundedBody(req);
            const body = bodyText ? JSON.parse(bodyText) : {};

            if (action === "purge") {
              const purgeRes = store.purge({
                sessionId: body.session_id,
                sourceId: body.source,
                worktree: body.worktree,
                all: body.all
              });
              return sendJson(res, 200, { ok: true, result: purgeRes });
            }

            return sendJson(res, 400, { ok: false, error: "Unknown POST action" });
          }

          res.statusCode = 405;
          res.setHeader("allow", "GET, POST");
          res.end();
        } catch (err) {
          sendJson(res, 500, { ok: false, error: String(err?.message || err) });
        }
      }
    }), "context-mode: /api/context-mode");
  }

  // Teardown
  ctx.on("dispose", () => {
    try {
      store.close();
    } catch {}
  });
}
