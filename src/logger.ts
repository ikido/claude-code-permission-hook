import { appendFileSync, existsSync, statSync, readFileSync } from "fs";
import { join } from "path";
import { getConfigDir, loadConfig, ensureConfigDir } from "./config.js";
import { LogEntry } from "./types.js";

const LOG_FILE = "approval.jsonl";

function getLogPath(): string {
  return join(getConfigDir(), LOG_FILE);
}

export function logDecision(entry: Omit<LogEntry, "timestamp">): void {
  const config = loadConfig();
  if (!config.logging.enabled) {
    return;
  }

  ensureConfigDir();

  const fullEntry = {
    ...entry,
    timestamp: new Date().toISOString(),
  };

  const line = JSON.stringify(fullEntry) + "\n";
  appendFileSync(getLogPath(), line);
}

export function getLogPath_(): string {
  return getLogPath();
}

export function logExists(): boolean {
  return existsSync(getLogPath());
}

export function getLogStats(): { entries: number; sizeBytes: number } | null {
  const logPath = getLogPath();
  if (!existsSync(logPath)) {
    return null;
  }

  try {
    const stat = statSync(logPath);
    const content = readFileSync(logPath, "utf-8");
    const entries = content.trim().split("\n").filter(Boolean).length;

    return {
      entries,
      sizeBytes: stat.size,
    };
  } catch {
    return null;
  }
}
