import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const OUTPUT_CAP = 16384; // 16 KB
export const DEFAULT_TIMEOUT_MS = 30000; // 30s

/** Determine best shell for platform */
export function getDefaultShell() {
  if (process.platform === "win32") {
    return process.env.COMSPEC || "powershell.exe";
  }
  return process.env.SHELL || "/bin/sh";
}

/** Check if PowerShell is available */
export function hasPwsh() {
  try {
    const isWin = process.platform === "win32";
    return isWin;
  } catch {
    return false;
  }
}

/** Run a process and capture stdout / stderr with time and byte bounding */
export function runProcess({ cmd, args = [], cwd, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = 10 * 1024 * 1024, env = process.env, stdinData = null }) {
  return new Promise((resolve) => {
    let stdoutBuffer = [];
    let stderrBuffer = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let finished = false;

    const child = spawn(cmd, args, {
      cwd: cwd || process.cwd(),
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // kill failed
      }
    }, timeoutMs);

    if (stdinData && child.stdin) {
      try {
        child.stdin.end(stdinData);
      } catch {
        // stdin write failed
      }
    } else if (child.stdin) {
      try {
        child.stdin.end();
      } catch {
        // ignore
      }
    }

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes <= maxBytes) {
        stdoutBuffer.push(chunk);
      }
    });

    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes <= maxBytes) {
        stderrBuffer.push(chunk);
      }
    });

    const onFinish = (exitCode, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      const stdout = Buffer.concat(stdoutBuffer).toString("utf8");
      const stderr = Buffer.concat(stderrBuffer).toString("utf8");
      const rawBytes = stdoutBytes + stderrBytes;

      resolve({
        ok: exitCode === 0 && !timedOut,
        exitCode: timedOut ? 124 : (exitCode ?? (signal ? 1 : 0)),
        signal,
        timedOut,
        stdout,
        stderr,
        rawBytes
      });
    };

    child.on("error", (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: String(err && err.message ? err.message : err),
        rawBytes: 0
      });
    });

    child.on("close", (code, sig) => onFinish(code, sig));
    child.on("exit", (code, sig) => onFinish(code, sig));
  });
}

/** Execute code in specified runtime (nodejs, python, shell, pwsh, cmd) */
export async function executeCode({ language = "shell", code = "", file = "", args = [], cwd, timeoutMs = DEFAULT_TIMEOUT_MS, env = {} }) {
  const normLang = String(language || "shell").toLowerCase().trim();
  const workdir = cwd || process.cwd();

  // 1. Node.js
  if (normLang === "nodejs" || normLang === "node" || normLang === "javascript" || normLang === "js") {
    if (file) {
      const scriptPath = path.isAbsolute(file) ? file : path.resolve(workdir, file);
      return runProcess({
        cmd: process.execPath,
        args: [scriptPath, ...args],
        cwd: workdir,
        timeoutMs,
        env
      });
    }
    return runProcess({
      cmd: process.execPath,
      args: ["-e", code, "--", ...args],
      cwd: workdir,
      timeoutMs,
      env
    });
  }

  // 2. Python
  if (normLang === "python" || normLang === "python3" || normLang === "py") {
    const pythonBin = process.platform === "win32" ? "python" : "python3";
    if (file) {
      const scriptPath = path.isAbsolute(file) ? file : path.resolve(workdir, file);
      return runProcess({
        cmd: pythonBin,
        args: [scriptPath, ...args],
        cwd: workdir,
        timeoutMs,
        env
      });
    }
    return runProcess({
      cmd: pythonBin,
      args: ["-c", code, ...args],
      cwd: workdir,
      timeoutMs,
      env
    });
  }

  // 3. PowerShell
  if (normLang === "pwsh" || normLang === "powershell") {
    const isWin = process.platform === "win32";
    const bin = "powershell.exe";
    if (file) {
      const scriptPath = path.isAbsolute(file) ? file : path.resolve(workdir, file);
      return runProcess({
        cmd: bin,
        args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args],
        cwd: workdir,
        timeoutMs,
        env
      });
    }
    return runProcess({
      cmd: bin,
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", code],
      cwd: workdir,
      timeoutMs,
      env
    });
  }

  // 4. Windows CMD
  if (normLang === "cmd" || normLang === "bat") {
    return runProcess({
      cmd: "cmd.exe",
      args: ["/d", "/s", "/c", code || (file ? `call "${file}"` : "")],
      cwd: workdir,
      timeoutMs,
      env
    });
  }

  // 5. Default Shell (bash / sh on Unix, powershell on Windows)
  if (process.platform === "win32") {
    return runProcess({
      cmd: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", code || (file ? `& "${file}"` : "")],
      cwd: workdir,
      timeoutMs,
      env
    });
  } else {
    const shell = process.env.SHELL || "/bin/sh";
    return runProcess({
      cmd: shell,
      args: ["-c", code || (file ? `sh "${file}"` : "")],
      cwd: workdir,
      timeoutMs,
      env
    });
  }
}
