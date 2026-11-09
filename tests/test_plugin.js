import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { apply, name, inject } from "../index.js";

test("dsh-plugin-context-mode index.js lifecycle", async () => {
  assert.equal(name, "dsh-plugin-context-mode");
  assert.ok(inject.includes("systemPrompt"));
  assert.ok(inject.includes("tools"));
  assert.ok(inject.includes("workingDirectory"));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctxm-plugin-"));
  const dbPath = path.join(tmpDir, "plugin.db");

  const registeredTools = [];
  const systemPromptSections = [];
  const eventHandlers = new Map();

  const mockCtx = {
    tools: {
      register(tool) {
        registeredTools.push(tool);
      }
    },
    systemPrompt: {
      section(sec) {
        systemPromptSections.push(sec);
      }
    },
    workingDirectory: {
      get() {
        return tmpDir;
      }
    },
    on(event, handler) {
      if (!eventHandlers.has(event)) eventHandlers.set(event, []);
      eventHandlers.get(event).push(handler);
    },
    effect(fn) {
      fn();
    },
    webServer: {
      register(route) {
        // mock web route
      }
    }
  };

  try {
    apply(mockCtx, {
      enabled: true,
      autoIntercept: true,
      replaceTriggerBytes: 2000,
      injectSystemPrompt: true,
      dbPath
    });

    // Verify 8 tools registered
    assert.equal(registeredTools.length, 8);
    const toolNames = registeredTools.map(t => t.name);
    assert.ok(toolNames.includes("ctx_execute"));
    assert.ok(toolNames.includes("ctx_batch"));
    assert.ok(toolNames.includes("ctx_index"));
    assert.ok(toolNames.includes("ctx_search"));
    assert.ok(toolNames.includes("ctx_resume"));
    assert.ok(toolNames.includes("ctx_stats"));
    assert.ok(toolNames.includes("ctx_doctor"));
    assert.ok(toolNames.includes("ctx_purge"));

    // Verify system prompt registered
    assert.equal(systemPromptSections.length, 1);
    assert.equal(systemPromptSections[0].name, "context-mode");
    assert.equal(systemPromptSections[0].interpolate, false);
    const promptText = typeof systemPromptSections[0].text === "function"
      ? systemPromptSections[0].text()
      : systemPromptSections[0].text;
    assert.ok(typeof promptText === "string");
    assert.ok(promptText.includes("Context Mode"));

    // Verify post-execute hook registered
    assert.ok(eventHandlers.has("tools/post-execute"));

    // Test post-execute waterfall with large output
    const postExecuteHandlers = eventHandlers.get("tools/post-execute");
    const handler = postExecuteHandlers[0];

    const largeResult = {
      content: [{ type: "text", text: "SAMPLE_LOG_LINE_".repeat(200) }] // ~3200 bytes > 2000
    };
    const mockExec = {
      name: "pwsh",
      workspaceDir: tmpDir,
      arguments: { command: "Get-Process" }
    };

    const next = async () => ({ kind: "accept" });
    const finalDecision = await handler(mockExec, largeResult, next);

    assert.equal(finalDecision.kind, "accept");
    assert.ok(finalDecision.content[0].text.includes("Context Mode: Output from \"pwsh\" was"));
  } finally {
    const disposeHandlers = eventHandlers.get("dispose") || [];
    for (const h of disposeHandlers) h();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
