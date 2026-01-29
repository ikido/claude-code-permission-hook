import {
  PermissionRequestInputSchema,
  PermissionRequestOutput,
} from "./types.js";
import { checkFastDecision } from "./fast-decisions.js";
import { getCachedDecision, setCachedDecision } from "./cache.js";
import { queryLLM } from "./llm-client.js";
import { logDecision } from "./logger.js";
import { resolveProjectRoot } from "./project.js";

/**
 * Handle a permission request from Claude Code.
 * Returns PermissionRequestOutput for allow/deny, or null for passthrough.
 * Passthrough means: exit 0 with no output, letting Claude show its native dialog.
 */
export async function handlePermissionRequest(
  rawInput: unknown
): Promise<PermissionRequestOutput | null> {
  // Parse and validate input
  let input;
  try {
    input = PermissionRequestInputSchema.parse(rawInput);
  } catch (error) {
    // Invalid input, deny
    return createDenyResponse("Invalid permission request input");
  }

  const {
    tool_name: toolName,
    tool_input: toolInput,
    cwd,
    session_id: sessionId,
  } = input;

  // Resolve the project root from cwd (.git > .claude > cwd fallback)
  const projectRoot = cwd ? resolveProjectRoot(cwd) : undefined;

  // Tier 1: Check fast decisions (hardcoded patterns)
  const fastResult = checkFastDecision(toolName, toolInput);

  if (fastResult.decision === "allow") {
    logDecision({
      toolName,
      decision: "allow",
      reason: fastResult.reason || "Fast allow",
      decisionSource: "fast",
      sessionId,
      projectRoot,
    });
    return createAllowResponse();
  }

  if (fastResult.decision === "deny") {
    logDecision({
      toolName,
      decision: "deny",
      reason: fastResult.reason || "Fast deny",
      decisionSource: "fast",
      sessionId,
      projectRoot,
    });
    return createDenyResponse(
      fastResult.reason || "Blocked by security pattern"
    );
  }

  // Handle fast passthrough (e.g., AskUserQuestion - user must see and respond)
  if (fastResult.decision === "passthrough") {
    logDecision({
      toolName,
      decision: "passthrough",
      reason: fastResult.reason || "Fast passthrough",
      decisionSource: "fast",
      sessionId,
      projectRoot,
    });
    return null; // Signal passthrough - exit 0 with no output
  }

  // Tier 2: Check cache (note: passthrough decisions are never cached)
  const cached = getCachedDecision(toolName, toolInput, projectRoot);
  if (cached) {
    logDecision({
      toolName,
      decision: cached.decision,
      reason: `Cached: ${cached.reason}`,
      decisionSource: "cache",
      sessionId,
      projectRoot,
    });

    if (cached.decision === "allow") {
      return createAllowResponse();
    } else {
      return createDenyResponse(cached.reason);
    }
  }

  // Tier 3: Query LLM (returns allow/deny only - passthrough is handled by fast-decisions)
  const llmResult = await queryLLM(toolName, toolInput, projectRoot);

  // Cache the result
  setCachedDecision(
    toolName,
    toolInput,
    llmResult.decision,
    llmResult.reason,
    projectRoot
  );

  logDecision({
    toolName,
    decision: llmResult.decision,
    reason: llmResult.reason,
    decisionSource: "llm",
    sessionId,
    projectRoot,
  });

  if (llmResult.decision === "allow") {
    return createAllowResponse();
  } else {
    return createDenyResponse(llmResult.reason);
  }
}

function createAllowResponse(): PermissionRequestOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "allow",
      },
    },
  };
}

function createDenyResponse(message: string): PermissionRequestOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "deny",
        message,
      },
    },
  };
}
