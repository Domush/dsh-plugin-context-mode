window.__ModuleLoader__.load({
  id: "dsh-plugin-context-mode",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;

    const CSS_STYLES = `
      .ctxm-container {
        display: flex;
        flex-direction: column;
        gap: 16px;
        color: var(--dsw-alias-label-primary, #ffffff);
        font-family: inherit;
        padding: 4px 0;
      }
      .ctxm-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        padding-bottom: 12px;
        border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.1));
      }
      .ctxm-title-area {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .ctxm-title-row {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .ctxm-title {
        font-size: 18px;
        font-weight: 600;
        margin: 0;
        color: var(--dsw-alias-label-primary, #ffffff);
      }
      .ctxm-badge {
        font-size: 11px;
        font-weight: 500;
        padding: 2px 8px;
        border-radius: 12px;
        background: rgba(16, 185, 129, 0.15);
        color: #34d399;
        border: 1px solid rgba(16, 185, 129, 0.3);
      }
      .ctxm-subtitle {
        font-size: 13px;
        color: var(--dsw-alias-label-secondary, rgba(255, 255, 255, 0.6));
        margin: 0;
        line-height: 1.4;
      }
      .ctxm-cards {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 12px;
      }
      .ctxm-card {
        background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.04));
        border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.1));
        border-radius: 8px;
        padding: 12px 14px;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .ctxm-card-label {
        font-size: 12px;
        color: var(--dsw-alias-label-secondary, rgba(255, 255, 255, 0.6));
      }
      .ctxm-card-val {
        font-size: 20px;
        font-weight: 700;
        color: var(--dsw-alias-label-primary, #ffffff);
      }
      .ctxm-card-val.highlight {
        color: #38bdf8;
      }
      .ctxm-card-val.success {
        color: #34d399;
      }
      .ctxm-progress-container {
        display: flex;
        flex-direction: column;
        gap: 6px;
        background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.04));
        border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.1));
        border-radius: 8px;
        padding: 12px 14px;
      }
      .ctxm-progress-header {
        display: flex;
        justify-content: space-between;
        font-size: 13px;
        font-weight: 500;
      }
      .ctxm-progress-bar-bg {
        height: 10px;
        border-radius: 5px;
        background: rgba(255, 255, 255, 0.1);
        overflow: hidden;
      }
      .ctxm-progress-bar-fill {
        height: 100%;
        background: linear-gradient(90deg, #0284c7, #34d399);
        border-radius: 5px;
        transition: width 0.4s ease;
      }
      .ctxm-section-title {
        font-size: 14px;
        font-weight: 600;
        margin-top: 8px;
        margin-bottom: 4px;
        color: var(--dsw-alias-label-primary, #ffffff);
      }
      .ctxm-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
        background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.03));
        border-radius: 6px;
        overflow: hidden;
      }
      .ctxm-table th, .ctxm-table td {
        padding: 8px 12px;
        text-align: left;
        border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      }
      .ctxm-table th {
        background: rgba(255, 255, 255, 0.05);
        color: var(--dsw-alias-label-secondary, rgba(255, 255, 255, 0.7));
        font-weight: 500;
      }
      .ctxm-btn {
        height: 30px;
        padding: 0 12px;
        border-radius: 4px;
        font-size: 12px;
        border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.15));
        background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.06));
        color: var(--dsw-alias-label-primary, #ffffff);
        cursor: pointer;
        transition: all 0.2s;
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .ctxm-btn:hover {
        background: rgba(255, 255, 255, 0.12);
        border-color: rgba(255, 255, 255, 0.3);
      }
      .ctxm-btn.danger:hover {
        background: rgba(239, 68, 68, 0.2);
        border-color: rgba(239, 68, 68, 0.4);
        color: #f87171;
      }
      .ctxm-actions {
        display: flex;
        gap: 8px;
        margin-top: 8px;
      }
    `;

    function ContextModeSettingsSection() {
      const [stats, setStats] = useState(null);
      const [doctor, setDoctor] = useState(null);
      const [loading, setLoading] = useState(true);
      const [purging, setPurging] = useState(false);
      const [error, setError] = useState(null);

      const loadData = useCallback(async () => {
        try {
          setLoading(true);
          const [statsRes, docRes] = await Promise.all([
            fetch("/api/context-mode?action=stats").then(r => r.json()),
            fetch("/api/context-mode?action=doctor").then(r => r.json())
          ]);
          if (statsRes.ok) setStats(statsRes.stats);
          if (docRes.ok) setDoctor(docRes.doctor);
        } catch (err) {
          setError(String(err?.message || err));
        } finally {
          setLoading(false);
        }
      }, []);

      useEffect(() => {
        loadData();
      }, [loadData]);

      const handlePurge = async () => {
        if (!confirm("Are you sure you want to clean up Context Mode indexes? This will wipe temporary session chunks and vacuum the database.")) {
          return;
        }
        try {
          setPurging(true);
          await fetch("/api/context-mode?action=purge", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ all: true })
          });
          await loadData();
        } catch (err) {
          alert("Purge failed: " + err.message);
        } finally {
          setPurging(false);
        }
      };

      const ratio = stats && stats.rawBytes > 0 ? (stats.keptOutBytes / stats.rawBytes) : 0;
      const percent = (ratio * 100).toFixed(1);

      return h(
        "div",
        { className: "ctxm-container" },
        h("style", null, CSS_STYLES),

        // Header
        h(
          "div",
          { className: "ctxm-header" },
          h(
            "div",
            { className: "ctxm-title-area" },
            h(
              "div",
              { className: "ctxm-title-row" },
              h("h2", { className: "ctxm-title" }, "Context Mode"),
              h("span", { className: "ctxm-badge" }, "SQLite FTS5 Active")
            ),
            h(
              "p",
              { className: "ctxm-subtitle" },
              "Local high-performance context protection engine (mksglu/context-mode). Indexes large tool outputs into SQLite FTS5 with BM25+RRF ranking."
            )
          ),
          h(
            "button",
            { className: "ctxm-btn", onClick: loadData, disabled: loading },
            loading ? "Refreshing..." : "Refresh"
          )
        ),

        error && h("div", { style: { color: "#f87171", fontSize: "13px" } }, `Error: ${error}`),

        // Metrics Cards
        stats && h(
          "div",
          { className: "ctxm-cards" },
          h(
            "div",
            { className: "ctxm-card" },
            h("div", { className: "ctxm-card-label" }, "Data Intercepted"),
            h("div", { className: "ctxm-card-val" }, `${stats.rawKb} KB`)
          ),
          h(
            "div",
            { className: "ctxm-card" },
            h("div", { className: "ctxm-card-label" }, "Kept Out of Context"),
            h("div", { className: "ctxm-card-val highlight" }, `${stats.keptOutKb} KB`)
          ),
          h(
            "div",
            { className: "ctxm-card" },
            h("div", { className: "ctxm-card-label" }, "Tokens Saved"),
            h("div", { className: "ctxm-card-val success" }, `~${stats.tokensSaved.toLocaleString()}`)
          ),
          h(
            "div",
            { className: "ctxm-card" },
            h("div", { className: "ctxm-card-label" }, "Indexed Sources"),
            h("div", { className: "ctxm-card-val" }, `${stats.totalSources} (${stats.totalChunks} chunks)`)
          )
        ),

        // Progress Bar
        stats && h(
          "div",
          { className: "ctxm-progress-container" },
          h(
            "div",
            { className: "ctxm-progress-header" },
            h("span", null, "Context Reduction Ratio"),
            h("span", { style: { color: "#34d399" } }, `${percent}% Kept Out`)
          ),
          h(
            "div",
            { className: "ctxm-progress-bar-bg" },
            h("div", {
              className: "ctxm-progress-bar-fill",
              style: { width: `${Math.min(100, Math.max(0, percent))}%` }
            })
          )
        ),

        // Doctor / Diagnostic Checks
        doctor && h(
          "div",
          null,
          h("div", { className: "ctxm-section-title" }, `Health Diagnostics [${doctor.status}]`),
          h(
            "table",
            { className: "ctxm-table" },
            h(
              "thead",
              null,
              h(
                "tr",
                null,
                h("th", { style: { width: "60px" } }, "Check"),
                h("th", { style: { width: "200px" } }, "Component"),
                h("th", { style: { width: "90px" } }, "Status"),
                h("th", null, "Details")
              )
            ),
            h(
              "tbody",
              null,
              doctor.checks.map(c =>
                h(
                  "tr",
                  { key: c.id },
                  h("td", { style: { fontFamily: "monospace" } }, c.id),
                  h("td", null, c.name),
                  h(
                    "td",
                    { style: { color: c.ok ? "#34d399" : "#f87171", fontWeight: 600 } },
                    c.ok ? "PASS" : "FAIL"
                  ),
                  h("td", { style: { color: "rgba(255, 255, 255, 0.7)" } }, c.detail)
                )
              )
            )
          )
        ),

        // Actions
        h(
          "div",
          { className: "ctxm-actions" },
          h(
            "button",
            {
              className: "ctxm-btn danger",
              onClick: handlePurge,
              disabled: purging
            },
            purging ? "Purging..." : "Purge All Indexes & Vacuum DB"
          )
        )
      );
    }

    function ContextModeSectionIcon() {
      return h(
        "svg",
        {
          width: "16",
          height: "16",
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: "2",
          strokeLinecap: "round",
          strokeLinejoin: "round"
        },
        h("ellipse", { cx: "12", cy: "5", rx: "8", ry: "3" }),
        h("path", { d: "M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5" }),
        h("path", { d: "M4 11v6c0 1.66 3.58 3 8 3 1.15 0 2.25-.09 3.24-.26" }),
        h("circle", { cx: "16.5", cy: "16.5", r: "3.5" }),
        h("line", { x1: "19", y1: "19", x2: "22", y2: "22" })
      );
    }

    return {
      inject: ["slots"],
      apply(ctx) {
        ctx.slots.inject("settings.section", () =>
          ctx.slots.register(
            {
              name: "settings.section",
              id: "context-mode",
              order: 30,
              label: "Context Mode"
            },
            ContextModeSettingsSection
          )
        );

        ctx.slots.inject("settings.section.icon", () =>
          ctx.slots.register(
            {
              name: "settings.section.icon",
              id: "context-mode",
              order: 30
            },
            ContextModeSectionIcon
          )
        );
      }
    };
  }
});
