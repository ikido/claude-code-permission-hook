import { loadConfig } from "./config.js";

export interface FastDecisionResult {
  decision: "allow" | "deny" | "passthrough" | "llm";
  reason?: string;
}

// Tools that are always safe to auto-approve
const INSTANT_ALLOW_TOOLS = new Set([
  // Read-only tools
  "Read",
  "Glob",
  "Grep",
  "LS",
  "WebFetch",
  "WebSearch",
  "NotebookRead",
  "BashOutput",
  // Safe write/interaction tools
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "TodoWrite",
  "Task",
]);

// Tools that should ALWAYS passthrough to native dialog (user must see and respond)
const INSTANT_PASSTHROUGH_TOOLS = new Set([
  "AskUserQuestion", // User MUST see questions and provide their answer
]);

// Patterns that should fast-allow for common dev workflows
const FAST_ALLOW_BASH_PATTERNS = [
  // Sourcing .env files + database CLI with read-only SQL (SELECT, EXPLAIN, DESCRIBE, SHOW)
  // e.g. source .env && psql "$DATABASE_URL" -c "SELECT ..."
  /source\s+\S*\.env\b.*\b(psql|mysql|sqlite3|mongosh)\b.*\b(SELECT|EXPLAIN|DESCRIBE|SHOW)\b/i,
  /\.\s+\S*\.env\b.*\b(psql|mysql|sqlite3|mongosh)\b.*\b(SELECT|EXPLAIN|DESCRIBE|SHOW)\b/i,
  // Direct database CLI with read-only SQL (no .env sourcing needed)
  /\b(psql|mysql|sqlite3|mongosh)\b.*-[ce]\s+["']?\s*(SELECT|EXPLAIN|DESCRIBE|SHOW)\b/i,
];

// Patterns that should ALWAYS be denied - system destruction
const INSTANT_DENY_BASH_PATTERNS = [
  // Unix/Linux system root destruction
  /^rm\s+(-[rf]+\s+)*\/$/,
  /^rm\s+(-[rf]+\s+)*\/usr\b/,
  /^rm\s+(-[rf]+\s+)*\/etc\b/,
  /^rm\s+(-[rf]+\s+)*\/bin\b/,
  /^rm\s+(-[rf]+\s+)*\/sbin\b/,
  /^rm\s+(-[rf]+\s+)*\/boot\b/,
  /^rm\s+(-[rf]+\s+)*\/var\b/,
  /^rm\s+(-[rf]+\s+)*\/home\b/,
  /^rm\s+(-[rf]+\s+)*~\/?$/,
  /^rm\s+(-[rf]+\s+)*\$HOME\/?$/,
  // Windows system destruction
  /^(rmdir|rd)\s+\/s\s+\/q\s+[A-Z]:\\$/i,
  /^del\s+(\/[fqs]\s+)+[A-Z]:\\$/i,
  /^del\s+(\/[fqs]\s+)+[A-Z]:\\Windows/i,
  /^del\s+(\/[fqs]\s+)+[A-Z]:\\System32/i,
  // Disk formatting
  /^mkfs\b/,
  /^fdisk\s+.*--delete/,
  /^dd\s+.*of=\/dev\/(sd[a-z]|nvme|hd[a-z])$/,
  /^format\s+[A-Z]:/i,
  // Protected git operations
  /^git\s+push\s+(-f|--force)\s+(origin\s+)?(main|master|production|staging|develop)\b/i,
  /^git\s+push\s+--force\s+(origin\s+)?(main|master|production|staging|develop)\b/i,
  /^git\s+push\s+.*--force-with-lease\s+.*\b(main|master|production)\b/i,
  // Fork bombs and malicious patterns
  /:\(\)\{\s*:\|:&\s*\};:/,
  /\bfork\s*\(\s*\)\s*while/i,
  // Credential theft attempts
  /curl.*\|.*sh.*password/i,
  /wget.*-O.*-.*\|.*bash/,
  /curl.*\/etc\/passwd/,
  /curl.*\/etc\/shadow/,
  // PowerShell destructive
  /Remove-Item\s+.*-Recurse.*[A-Z]:\\$/i,
  /Remove-Item\s+.*-Recurse.*\$env:SystemRoot/i,
];

export function checkFastDecision(
  toolName: string,
  toolInput: Record<string, unknown>
): FastDecisionResult {
  const config = loadConfig();

  // Check custom deny patterns first
  for (const pattern of config.customDenyPatterns) {
    const regex = new RegExp(pattern);
    if (regex.test(toolName) || regex.test(JSON.stringify(toolInput))) {
      return {
        decision: "deny",
        reason: `Blocked by custom deny pattern: ${pattern}`,
      };
    }
  }

  // Check instant deny patterns for Bash commands
  if (toolName === "Bash") {
    const command = toolInput.command as string;
    if (command) {
      for (const pattern of INSTANT_DENY_BASH_PATTERNS) {
        if (pattern.test(command)) {
          return {
            decision: "deny",
            reason: `Blocked destructive command pattern: ${pattern.source}`,
          };
        }
      }

      // Check fast-allow patterns for common dev workflows
      for (const pattern of FAST_ALLOW_BASH_PATTERNS) {
        if (pattern.test(command)) {
          return {
            decision: "allow",
            reason: `Allowed common dev workflow: ${pattern.source}`,
          };
        }
      }
    }
  }

  // Check custom allow patterns
  for (const pattern of config.customAllowPatterns) {
    const regex = new RegExp(pattern);
    if (regex.test(toolName)) {
      return {
        decision: "allow",
        reason: `Allowed by custom pattern: ${pattern}`,
      };
    }
  }

  // Check custom passthrough patterns
  for (const pattern of config.customPassthroughPatterns) {
    const regex = new RegExp(pattern);
    if (regex.test(toolName) || regex.test(JSON.stringify(toolInput))) {
      return {
        decision: "passthrough",
        reason: `Passthrough by custom pattern: ${pattern}`,
      };
    }
  }

  // Check instant passthrough tools (user MUST see and respond to these)
  if (INSTANT_PASSTHROUGH_TOOLS.has(toolName)) {
    return {
      decision: "passthrough",
      reason: `Tool '${toolName}' requires user interaction - showing native dialog`,
    };
  }

  // Check instant allow tools
  if (INSTANT_ALLOW_TOOLS.has(toolName)) {
    return {
      decision: "allow",
      reason: `Tool '${toolName}' is in instant-allow list`,
    };
  }

  // Check MCP tools (generally safe)
  if (toolName.startsWith("mcp__")) {
    return {
      decision: "allow",
      reason: "MCP tools are auto-approved",
    };
  }

  // Needs LLM analysis
  return {
    decision: "llm",
    reason: "Requires LLM analysis",
  };
}
