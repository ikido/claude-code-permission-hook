import { createHash } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getConfigDir, loadConfig, ensureConfigDir } from "./config.js";
import { CacheEntry, CacheFile, CacheFileSchema } from "./types.js";

const CACHE_FILE = "approval_cache.json";

function getCachePath(): string {
  return join(getConfigDir(), CACHE_FILE);
}

function generateCacheKey(
  toolName: string,
  toolInput: Record<string, unknown>,
  projectRoot?: string
): string {
  const data = JSON.stringify({
    toolName,
    toolInput,
    projectRoot: projectRoot || "",
  });
  return createHash("sha256").update(data).digest("hex");
}

function loadCache(): CacheFile {
  const cachePath = getCachePath();
  if (!existsSync(cachePath)) {
    return {};
  }

  try {
    const raw = readFileSync(cachePath, "utf-8");
    const parsed = JSON.parse(raw);
    return CacheFileSchema.parse(parsed);
  } catch {
    // Corrupted cache, return empty
    return {};
  }
}

function saveCache(cache: CacheFile): void {
  ensureConfigDir();
  const cachePath = getCachePath();
  writeFileSync(cachePath, JSON.stringify(cache, null, 2));
}

export function getCachedDecision(
  toolName: string,
  toolInput: Record<string, unknown>,
  projectRoot?: string
): CacheEntry | null {
  const config = loadConfig();
  if (!config.cache.enabled) {
    return null;
  }

  const key = generateCacheKey(toolName, toolInput, projectRoot);
  const cache = loadCache();
  const entry = cache[key];

  if (!entry) {
    return null;
  }

  // Check TTL
  const ttlMs = config.cache.ttlHours * 60 * 60 * 1000;
  const age = Date.now() - entry.timestamp;

  if (age > ttlMs) {
    // Expired, remove it
    delete cache[key];
    saveCache(cache);
    return null;
  }

  return entry;
}

export function setCachedDecision(
  toolName: string,
  toolInput: Record<string, unknown>,
  decision: "allow" | "deny",
  reason: string,
  projectRoot?: string
): void {
  const config = loadConfig();
  if (!config.cache.enabled) {
    return;
  }

  const key = generateCacheKey(toolName, toolInput, projectRoot);
  const cache = loadCache();

  const entry: CacheEntry = {
    key,
    decision,
    reason,
    timestamp: Date.now(),
    toolName,
    toolInput,
    projectRoot,
  };

  cache[key] = entry;
  saveCache(cache);
}

export function clearCache(): number {
  const cache = loadCache();
  const count = Object.keys(cache).length;
  saveCache({});
  return count;
}

export function clearCacheByDecision(decision: "allow" | "deny"): number {
  const cache = loadCache();
  let removed = 0;
  for (const [key, entry] of Object.entries(cache)) {
    if (entry.decision === decision) {
      delete cache[key];
      removed++;
    }
  }
  if (removed > 0) {
    saveCache(cache);
  }
  return removed;
}

export function clearCacheByKey(hashKey: string): boolean {
  const cache = loadCache();
  if (cache[hashKey]) {
    delete cache[hashKey];
    saveCache(cache);
    return true;
  }
  return false;
}

export function clearCacheByGrep(substring: string): number {
  const cache = loadCache();
  const lowerSub = substring.toLowerCase();
  let removed = 0;

  for (const [key, entry] of Object.entries(cache)) {
    const searchable = [
      entry.toolName,
      entry.reason,
      entry.projectRoot || "",
      JSON.stringify(entry.toolInput || {}),
    ]
      .join(" ")
      .toLowerCase();

    if (searchable.includes(lowerSub)) {
      delete cache[key];
      removed++;
    }
  }

  if (removed > 0) {
    saveCache(cache);
  }
  return removed;
}

export function listCacheEntries(projectRoot?: string): CacheEntry[] {
  const cache = loadCache();
  let entries = Object.values(cache);

  if (projectRoot) {
    entries = entries.filter((e) => e.projectRoot === projectRoot);
  }

  // Sort by timestamp descending (most recent first)
  entries.sort((a, b) => b.timestamp - a.timestamp);

  return entries;
}

export function getCacheStats(): {
  entries: number;
  oldestTimestamp?: number;
} {
  const cache = loadCache();
  const entries = Object.values(cache);

  if (entries.length === 0) {
    return { entries: 0 };
  }

  const timestamps = entries.map((e) => e.timestamp);

  return {
    entries: entries.length,
    oldestTimestamp: Math.min(...timestamps),
  };
}
