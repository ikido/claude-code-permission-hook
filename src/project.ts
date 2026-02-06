import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";

/**
 * Read trusted paths from .claude/settings.json and .claude/settings.local.json.
 * Looks for ccApprove.trustedPaths array in both files, merges them.
 */
export function getTrustedPaths(projectRoot: string): string[] {
  const trustedPaths: string[] = [];
  const settingsFiles = [
    join(projectRoot, ".claude", "settings.json"),
    join(projectRoot, ".claude", "settings.local.json"),
  ];

  for (const settingsPath of settingsFiles) {
    if (existsSync(settingsPath)) {
      try {
        const content = readFileSync(settingsPath, "utf-8");
        const settings = JSON.parse(content);
        const paths = settings?.ccApprove?.trustedPaths;
        if (Array.isArray(paths)) {
          for (const p of paths) {
            if (typeof p === "string" && !trustedPaths.includes(p)) {
              trustedPaths.push(p);
            }
          }
        }
      } catch {
        // Ignore parse errors
      }
    }
  }

  return trustedPaths;
}

/**
 * Read project-specific LLM instructions from .cc-approve.md in the project root.
 * Returns the file content if it exists, or null otherwise.
 */
export function getProjectInstructions(projectRoot: string): string | null {
  const instructionsPath = join(projectRoot, ".cc-approve.md");
  if (existsSync(instructionsPath)) {
    try {
      const content = readFileSync(instructionsPath, "utf-8").trim();
      return content || null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Resolve the project root by walking up from the given cwd.
 * Looks for .git directory first, then .claude directory, falls back to cwd.
 */
export function resolveProjectRoot(cwd: string): string {
  let current = cwd;

  // Walk up looking for .git
  while (true) {
    if (existsSync(join(current, ".git"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  // Second pass: walk up looking for .claude directory
  current = cwd;
  while (true) {
    if (existsSync(join(current, ".claude"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  // Fallback: return cwd as-is
  return cwd;
}
