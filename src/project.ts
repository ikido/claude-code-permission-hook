import { existsSync } from "fs";
import { dirname, join } from "path";

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
