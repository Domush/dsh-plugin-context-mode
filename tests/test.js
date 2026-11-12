import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { ContextModeStore } from "../lib/store.js";
import { executeCode, runProcess } from "../lib/executor.js";
import { createTools } from "../lib/tools.js";
import { interceptToolResult, extractResultText } from "../lib/interceptor.js";

test("ContextModeStore - initialization, FTS5 schema, and indexing", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctxm-test-"));
  const dbPath = path.join(tmpDir, "test.db");
  const store = new ContextModeStore({ dbPath });

  try {
    const doc = store.doctor();
    assert.equal(doc.status, "HEALTHY");
    assert.equal(doc.allOk, true);

    // Index content
    const sampleText = `
      function calculateOrbitalVelocity(mass, radius) {
        const G = 6.67430e-11;
        return Math.sqrt((G * mass) / radius);
      }
      export default calculateOrbitalVelocity;
    `;

    const indexRes = store.indexContent({
      sessionId: "session-1",
      worktree: tmpDir,
      agent: "lead",
      kind: "content",
      label: "orbital.js",
      content: sampleText
    });

    assert.ok(indexRes.sourceId);
    assert.equal(indexRes.chunkCount >= 1, true);
    assert.equal(indexRes.bytesTotal, Buffer.byteLength(sampleText, "utf8"));

    // BM25 / RRF Search: Porter search
    const searchRes = store.search({
      queries: ["calculateOrbitalVelocity"],
      sessionId: "session-1"
    });
    assert.ok(searchRes.hits.length >= 1);
    assert.ok(searchRes.hits[0].snippet.includes("calculateOrbitalVelocity"));

    // Trigram search: symbol substring
    const triRes = store.search({
      queries: ["6.67430e-11"],
      sessionId: "session-1"
    });
    assert.ok(triRes.hits.length >= 1);
    assert.ok(triRes.hits[0].snippet.includes("6.67430e-11"));

    // Journal events
    store.recordEvent({
      sessionId: "session-1",
      worktree: tmpDir,
      agent: "lead",
      kind: "cmd",
      tool: "read",
      ok: 1,
      bytes: 10000,
      sandboxBytes: 10000,
      returnedBytes: 800
    });

    const events = store.getEvents({ sessionId: "session-1" });
    assert.equal(events.length, 1);
    assert.equal(events[0].tool, "read");

    // Stats
    const stats = store.getStats({ sessionId: "session-1" });
    assert.ok(stats.rawBytes >= 10000);
    assert.equal(stats.returnedBytes, 800);
    assert.ok(stats.keptOutBytes >= 9200);
    assert.ok(stats.tokensSaved >= 2300);
    assert.ok(parseFloat(stats.compressionRatio) >= 90.0);

    // Resume block (<= 2048 B)
    const block = store.generateResumeBlock({ sessionId: "session-1" });
    assert.ok(block.includes("Context Mode Session State"));
    assert.ok(Buffer.byteLength(block, "utf8") <= 2048);

    // Purge
    const purgeRes = store.purge({ sessionId: "session-1" });
    assert.equal(purgeRes.ok, true);

    const afterPurgeStats = store.getStats({ sessionId: "session-1" });
    assert.equal(afterPurgeStats.rawBytes, 0);
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Executor - executes nodejs and shell commands", async () => {
  const nodeRes = await executeCode({
    language: "nodejs",
    code: "console.log(JSON.stringify({ calculated: 42 * 2 }));"
  });

  assert.equal(nodeRes.ok, true);
  assert.equal(nodeRes.exitCode, 0);
  assert.ok(nodeRes.stdout.includes('{"calculated":84}'));

  const shellRes = await executeCode({
    language: "shell",
    code: process.platform === "win32" ? "echo hello_shell" : "echo hello_shell"
  });

  assert.equal(shellRes.ok, true);
  assert.ok(shellRes.stdout.includes("hello_shell"));
});

test("Tools - ctx_* tools handlers", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctxm-tools-"));
  const dbPath = path.join(tmpDir, "tools.db");
  const store = new ContextModeStore({ dbPath });

  const getCwd = () => tmpDir;
  const getSessionId = () => "test-session";
  const getTurn = () => 1;

  const tools = createTools({ store, getCwd, getSessionId, getTurn });
  const toolMap = new Map(tools.map(t => [t.name, t]));

  try {
    // 1. ctx_doctor
    const docTool = toolMap.get("ctx_doctor");
    const docOut = await docTool.execute({}, {});
    assert.equal(docOut.all_ok, true);
    assert.ok(docOut.report.includes("HEALTHY"));

    // 2. ctx_index
    const testFile = path.join(tmpDir, "data.txt");
    fs.writeFileSync(testFile, "DeepSeek Harness native plugin for Context Mode with SQLite FTS5.");

    const indexTool = toolMap.get("ctx_index");
    const idxOut = await indexTool.execute({ path: "data.txt" }, {});
    assert.equal(idxOut.ok, true);
    assert.ok(idxOut.source_id);

    // 3. ctx_search
    const searchTool = toolMap.get("ctx_search");
    const searchOut = await searchTool.execute({ queries: ["DeepSeek Harness"] }, {});
    assert.ok(searchOut.total_matches >= 1);
    assert.ok(searchOut.summary.includes("Context Mode Search Results"));

    // 4. ctx_execute (small output)
    const execTool = toolMap.get("ctx_execute");
    const smallOut = await execTool.execute({
      language: "nodejs",
      code: "console.log('short output');"
    }, {});
    assert.equal(smallOut.ok, true);
    assert.ok(smallOut.output.includes("short output"));

    // 5. ctx_execute (oversized output > 16KB cap)
    const bigOut = await execTool.execute({
      language: "nodejs",
      code: "console.log('LINE_DATA_'.repeat(2500));" // ~25KB
    }, {});
    assert.equal(bigOut.ok, true);
    assert.ok(bigOut.raw_bytes > 16384);
    assert.ok(bigOut.returned_bytes < bigOut.raw_bytes);
    assert.ok(bigOut.output.includes("Context Mode: Full output indexed into SQLite FTS5"));

    // 6. ctx_batch
    const batchTool = toolMap.get("ctx_batch");
    const batchOut = await batchTool.execute({
      commands: [
        process.platform === "win32" ? "echo batch_alpha" : "echo batch_alpha",
        process.platform === "win32" ? "echo batch_beta" : "echo batch_beta"
      ]
    }, {});
    assert.equal(batchOut.ok, true);
    assert.equal(batchOut.total_commands, 2);
    assert.ok(batchOut.output.includes("batch_alpha"));

    // 7. ctx_stats
    const statsTool = toolMap.get("ctx_stats");
    const statsOut = await statsTool.execute({}, {});
    assert.ok(statsOut.raw_bytes > 0);
    assert.ok(statsOut.kept_out_bytes > 0);
    assert.ok(statsOut.report.includes("Context Mode Performance"));

    // 8. ctx_resume
    const resumeTool = toolMap.get("ctx_resume");
    const resOut = await resumeTool.execute({}, {});
    assert.ok(resOut.state_block.includes("Context Mode Session State"));

    // 9. ctx_purge
    const purgeTool = toolMap.get("ctx_purge");
    const purgeOut = await purgeTool.execute({ all: true }, {});
    assert.equal(purgeOut.ok, true);
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Interceptor - intercepts outputs exceeding replaceTriggerBytes", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctxm-inter-"));
  const dbPath = path.join(tmpDir, "inter.db");
  const store = new ContextModeStore({ dbPath });

  const config = {
    autoIntercept: true,
    replaceTriggerBytes: 1000 // Small threshold for testing
  };

  const getCwd = () => tmpDir;
  const getSessionId = () => "session-inter";
  const getTurn = () => 1;

  try {
    // Under threshold -> null (no replacement)
    const smallExec = { name: "read", arguments: { path: "small.txt" } };
    const smallRes = { content: [{ type: "text", text: "small content" }] };
    const smallIntercept = interceptToolResult({
      exec: smallExec,
      result: smallRes,
      store,
      config,
      getCwd,
      getSessionId,
      getTurn
    });
    assert.equal(smallIntercept, null);

    // Over threshold -> replaced & indexed
    const largeText = "CRITICAL_LOG_ENTRY_".repeat(200); // ~3800 bytes
    const largeExec = { name: "read", arguments: { path: "huge.log" } };
    const largeRes = { content: [{ type: "text", text: largeText }] };

    const largeIntercept = interceptToolResult({
      exec: largeExec,
      result: largeRes,
      store,
      config,
      getCwd,
      getSessionId,
      getTurn
    });

    assert.ok(largeIntercept);
    assert.ok(largeIntercept.rawBytes > 1000);
    assert.ok(largeIntercept.returnedBytes < largeIntercept.rawBytes);
    assert.ok(largeIntercept.replacementText.includes("Context Mode: Output from \"read\" was"));
    assert.ok(largeIntercept.replacementText.includes("Full output safely indexed into SQLite FTS5"));

    // Verify search works on the intercepted output
    const searchRes = store.search({
      queries: ["CRITICAL_LOG_ENTRY_"],
      sourceId: largeIntercept.sourceId
    });
    assert.ok(searchRes.hits.length >= 1);
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
