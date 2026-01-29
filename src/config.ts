import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { Config, ConfigSchema } from "./types.js";

const CONFIG_DIR = join(homedir(), ".cc-approve");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

let cachedConfig: Config | null = null;

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}

export function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function loadConfig(): Config {
  if (cachedConfig) {
    return cachedConfig;
  }

  ensureConfigDir();

  if (!existsSync(CONFIG_FILE)) {
    const defaultConfig = ConfigSchema.parse({});
    saveConfig(defaultConfig);
    cachedConfig = defaultConfig;
    return defaultConfig;
  }

  try {
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    cachedConfig = ConfigSchema.parse(parsed);
    return cachedConfig;
  } catch (error) {
    // If config is corrupted, use defaults
    const defaultConfig = ConfigSchema.parse({});
    cachedConfig = defaultConfig;
    return defaultConfig;
  }
}

export function saveConfig(config: Config): void {
  ensureConfigDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  cachedConfig = config;
}

export function updateConfig(updates: Partial<Config>): Config {
  const current = loadConfig();
  const updated = ConfigSchema.parse({ ...current, ...updates });
  saveConfig(updated);
  return updated;
}

export function clearConfigCache(): void {
  cachedConfig = null;
}

export function getApiKey(): string | undefined {
  const config = loadConfig();

  // Check config first, then environment variables
  if (config.llm.apiKey) {
    return config.llm.apiKey;
  }

  // Check common environment variables
  return (
    process.env.OPENAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.LLM_API_KEY
  );
}
