# Claude Code Auto-Approval Hook

## The Problem

When using Claude Code, every potentially impactful operation (shell commands, file writes, git operations) triggers a manual confirmation dialog. In practice, developers approve 95%+ of these requests without reading them, which defeats the purpose while slowing down the workflow significantly.

## The Solution

[claude-code-permission-hook](https://github.com/malcomsonbrothers/claude-code-permission-hook) is a Claude Code hook that intercepts `PermissionRequest` events and automatically approves or denies them using a three-tier decision engine:

1. **Fast rules** — hardcoded regex patterns for instant allow/deny (no latency)
2. **Cache** — previously seen requests are replayed from a local cache (7-day TTL)
3. **LLM fallback** — ambiguous requests are evaluated by a local language model

The hook supports **any OpenAI-compatible API** as the LLM backend. This means you can use:
- **LM Studio** (local, free, private) — what we use
- **Ollama** (local, free, private)
- **OpenRouter** (cloud, paid)
- **OpenAI API** (cloud, paid)
- Any other OpenAI-compatible endpoint

In our setup we use **LM Studio** with **qwen3-coder-30b** running entirely on-device. No data leaves your machine.

---

## Architecture

```
Claude Code
    │
    ▼
PermissionRequest hook fires
    │
    ▼
cc-approve permission (reads stdin)
    │
    ├─► Tier 1: Fast Rules (regex patterns, instant)
    │     ├─ customDenyPatterns     →  DENY
    │     ├─ INSTANT_DENY (Bash)   →  DENY
    │     ├─ customAllowPatterns    →  ALLOW
    │     ├─ customPassthroughPatterns → PASSTHROUGH (ask user)
    │     ├─ INSTANT_PASSTHROUGH    →  PASSTHROUGH (ask user)
    │     ├─ Config protection      →  PASSTHROUGH (Write/Edit to ~/.cc-approve/)
    │     ├─ INSTANT_ALLOW (tools)  →  ALLOW
    │     └─ mcp__* tools           →  ALLOW
    │
    ├─► Tier 2: Cache (SHA-256 of tool+input+project, 7-day TTL)
    │     └─ cache hit              →  replay cached decision
    │
    └─► Tier 3: LLM (local qwen3-coder-30b via LM Studio)
          ├─ success                →  ALLOW or DENY (+ cache result)
          └─ error/timeout          →  conservative DENY
```

**PASSTHROUGH** means the hook does nothing and Claude Code shows the native confirmation dialog to the user. This happens for `AskUserQuestion`, `ExitPlanMode`, and any file modification targeting `~/.cc-approve/`.

---

## Decision Rules in Detail

### Tier 1a: Instant DENY (Bash commands only)

These regex patterns block destructive commands **before** they reach the LLM:

| Category | Blocked Patterns |
|---|---|
| System root deletion | `rm -rf /`, `rm -rf /usr`, `/etc`, `/bin`, `/sbin`, `/boot`, `/var`, `/home`, `~/`, `$HOME` |
| Windows destruction | `rmdir /s /q C:\`, `del C:\Windows`, `del C:\System32` |
| Disk formatting | `mkfs`, `fdisk --delete`, `dd of=/dev/sdX`, `format C:` |
| Force push to protected branches | `git push --force origin main\|master\|production\|staging\|develop` |
| Fork bombs | `:(){ :\|:& };:` and similar |
| Credential exfiltration | `curl \| sh ... password`, `curl /etc/passwd`, `curl /etc/shadow`, `wget -O - \| bash` |
| PowerShell destructive | `Remove-Item -Recurse C:\`, `Remove-Item $env:SystemRoot` |

### Tier 1b: Instant ALLOW (by tool name)

These Claude Code tools are always approved without LLM evaluation:

| Category | Tools |
|---|---|
| Read-only | `Read`, `Glob`, `Grep`, `LS`, `WebFetch`, `WebSearch`, `NotebookRead`, `BashOutput` |
| File writing | `Write`, `Edit`, `MultiEdit`, `NotebookEdit` |
| Task management | `TodoWrite`, `Task`, `TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet`, `TaskStop`, `TaskOutput` |
| Claude Code internals | `EnterPlanMode`, `KillShell`, `Skill`, `MCPSearch`, `LSP`, `ListMcpResourcesTool`, `ReadMcpResourceTool` |
| **All MCP tools** | Any tool starting with `mcp__` |

### Tier 1c: Instant PASSTHROUGH (user must respond)

| Tool | Reason |
|---|---|
| `AskUserQuestion` | User must see the question and provide their answer |
| `ExitPlanMode` | User must review and approve the plan |
| `Write`/`Edit`/`MultiEdit` → `~/.cc-approve/*` | Prevents agent from modifying its own config (privilege escalation protection) |

### Tier 2: Cache

- Keyed by SHA-256 hash of `(toolName, toolInput, projectRoot)`
- TTL: 168 hours (7 days), configurable
- Only `allow` and `deny` decisions are cached; `passthrough` is never cached
- Clear with: `cc-approve clear-cache`
- Inspect with: `cc-approve cache`

### Tier 3: LLM Evaluation

When a request doesn't match any fast rule and isn't cached, it goes to the LLM. In practice, this is almost exclusively `Bash` commands.

The LLM receives a system prompt with these instructions:

**Always deny:**
- Destructive system commands
- Force push to protected branches (main, master, production, staging, develop)
- Credential/data exfiltration to external services
- Fork bombs, resource exhaustion
- Modifications to system files (/etc, /usr, /bin, etc.)

**Always allow:**
- File reads (any path, unless piped to exfiltration)
- Standard dev operations: npm, yarn, pnpm, git add/commit/push (non-force), build, test, lint
- File operations within the project root
- Test execution (pytest, jest, vitest, etc.)
- Package installation
- Network requests to localhost or well-known APIs
- SQL SELECT / read-only queries

**Nuanced cases (LLM uses judgment):**
- `git push --force` to feature branches → allow; to protected branches → deny
- `rm` within project → allow; outside project → deny
- `curl/wget` downloading → allow; posting secrets → deny
- SQL writes to local/dev DB → allow; to production → deny
- `source .env && psql "$DB_URL" -c "SELECT ..."` → allow (local tool usage, not exfiltration)

**Default behavior:** ALLOW for standard development operations. Only DENY genuinely dangerous commands.

**On LLM error** (timeout, invalid JSON, connection refused): **conservative DENY**.

**Project-specific instructions:** If a `.cc-approve.md` file exists in the project root, its content is appended to the LLM system prompt as a `PROJECT-SPECIFIC INSTRUCTIONS` section. This lets you customize LLM behavior per project without changing the global config. See [Per-Project LLM Instructions](#per-project-llm-instructions) below.

---

## Installation

### Prerequisites

- Node.js 18+
- Claude Code installed
- LM Studio installed (or any OpenAI-compatible LLM server)

### Step 1: Clone and build from source

```bash
git clone https://github.com/malcomsonbrothers/claude-code-permission-hook.git
cd claude-code-permission-hook
npm install
npm run build
npm install -g .
```

> We install from source (not npm) because we patch out `response_format: { type: "json_object" }` from `src/llm-client.ts` — LM Studio does not support this parameter. The model returns valid JSON without it thanks to the system prompt instructions.

### Step 2: Apply the LM Studio patch

In `src/llm-client.ts`, remove the `response_format` line:

```diff
       temperature: 0,
       max_tokens: 200,
-      response_format: { type: "json_object" },
     };
```

Then rebuild:

```bash
npm run build
npm install -g .
```

### Step 3: Configure for LM Studio

Create or edit `~/.cc-approve/config.json`:

```json
{
  "llm": {
    "provider": "openai",
    "model": "qwen/qwen3-coder-30b",
    "apiKey": "lm-studio",
    "baseUrl": "http://localhost:1234/v1"
  },
  "cache": {
    "enabled": true,
    "ttlHours": 168
  },
  "logging": {
    "enabled": true,
    "level": "info"
  },
  "autoUpdateSystemPrompt": true,
  "customAllowPatterns": [],
  "customDenyPatterns": [],
  "customPassthroughPatterns": []
}
```

Key fields:
- `provider`: `"openai"` — LM Studio exposes an OpenAI-compatible API
- `model`: must match exactly what LM Studio reports at `GET /v1/models`
- `apiKey`: `"lm-studio"` — dummy value, LM Studio doesn't require auth
- `baseUrl`: `"http://localhost:1234/v1"` — default LM Studio server port

### Step 4: Add the hook to Claude Code settings

Edit `~/.claude/settings.json` and add the `PermissionRequest` hook:

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "cc-approve permission"
          }
        ]
      }
    ]
  }
}
```

### Step 5: Start LM Studio server

1. Open LM Studio
2. Go to the **Developer** tab (left sidebar)
3. Load your model (e.g. `qwen3-coder-30b`)
4. Click **Start Server** (default port: 1234)

### Step 6: Verify

```bash
# Check configuration
cc-approve doctor

# Check LM Studio is responding
curl http://localhost:1234/v1/models

# Test a safe command
echo '{"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"git status"},"cwd":"/your/project"}' | cc-approve permission
# Expected: {"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}

# Test a dangerous command
echo '{"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"rm -rf /"},"cwd":"/your/project"}' | cc-approve permission
# Expected: {"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"..."}}}
```

---

## Using a Different Model

The hook works with any OpenAI-compatible endpoint. To switch models:

### LM Studio (local)

```json
{
  "llm": {
    "provider": "openai",
    "model": "qwen/qwen3-coder-30b",
    "apiKey": "lm-studio",
    "baseUrl": "http://localhost:1234/v1"
  }
}
```

### Ollama (local)

```json
{
  "llm": {
    "provider": "openai",
    "model": "llama3.1",
    "apiKey": "ollama",
    "baseUrl": "http://localhost:11434/v1"
  }
}
```

### OpenRouter (cloud)

```json
{
  "llm": {
    "provider": "openrouter",
    "model": "gpt-4o-mini",
    "apiKey": "sk-or-...",
    "baseUrl": "https://openrouter.ai/api/v1"
  }
}
```

### OpenAI (cloud)

```json
{
  "llm": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "apiKey": "sk-..."
  }
}
```

> **Note:** If your chosen model supports `response_format: { type: "json_object" }` (OpenAI, OpenRouter), you don't need the LM Studio patch. The stock code will work as-is.

---

## Logging and Monitoring

### Decision log

All decisions are appended to `~/.cc-approve/approval.jsonl`:

```json
{"toolName":"Bash","decision":"allow","reason":"...","decisionSource":"llm","sessionId":"...","projectRoot":"...","timestamp":"..."}
```

`decisionSource` values:
- `fast` — matched a hardcoded rule (instant)
- `cache` — replayed from cache
- `llm` — evaluated by the language model

### Cache inspection

```bash
# View cached decisions for current project
cc-approve cache

# Clear all cached decisions
cc-approve clear-cache
```

### Diagnostics

```bash
cc-approve doctor
```

Shows: provider, model, API key status, base URL, cache stats, hook installation status, connectivity.

---

## Customization

Add custom patterns in `~/.cc-approve/config.json`:

```json
{
  "customDenyPatterns": [
    "docker.*--privileged",
    "kubectl.*delete.*namespace"
  ],
  "customAllowPatterns": [
    "MyCustomTool"
  ],
  "customPassthroughPatterns": [
    "curl.*production\\.api"
  ]
}
```

- `customDenyPatterns` — regex; checked first, always block
- `customAllowPatterns` — regex; checked against tool name, always allow
- `customPassthroughPatterns` — regex; falls through to native Claude Code dialog (user decides)

---

## Per-Project LLM Instructions

Create a `.cc-approve.md` file in your project root to give the LLM additional context specific to that project. The content is appended to the system prompt when the LLM evaluates ambiguous commands.

**Example:** Your project deploys via SSH to a staging server. Without project instructions, the LLM might block SSH commands as "high-risk production access". Add a `.cc-approve.md`:

```markdown
Allow SSH commands to deploy@staging.example.com for deployment.
Allow rsync to staging.example.com.
Allow scp to deploy@staging.example.com.
```

The file is read on every LLM evaluation, so changes take effect immediately (no rebuild needed). Only the LLM tier sees these instructions — fast rules and cache are unaffected.

**Tips:**
- Be specific about hosts, users, and purposes — vague instructions ("allow all SSH") weaken security
- The file is checked into git, so the whole team shares the same policy
- Add it to code review — treat it like a security policy file

---

## Config Protection

The hook protects its own configuration from agent modification. If Claude Code tries to use `Write`, `Edit`, or `MultiEdit` on any file inside `~/.cc-approve/`, the request is **passed through** to the native Claude Code dialog instead of being auto-approved.

This prevents a privilege escalation scenario where an agent could:
1. Edit `~/.cc-approve/config.json`
2. Add a pattern to `customAllowPatterns` that matches its own future requests
3. Bypass all subsequent permission checks

With this protection, any modification to the config directory requires explicit user approval through the native dialog.

---

## Important Considerations

1. **`Write` and `Edit` are auto-allowed, except for `~/.cc-approve/`.** The hook does not inspect file paths for most write operations — Claude Code itself restricts where files can be written. The one exception is the hook's own config directory (`~/.cc-approve/`), which is protected from agent modification (passthrough to native dialog).

2. **All `mcp__*` tools are auto-allowed.** If you have MCP servers with potentially dangerous tools, consider adding them to `customPassthroughPatterns` or `customDenyPatterns`.

3. **LM Studio must be running.** If the server is down, all ambiguous Bash commands will be denied (conservative deny on error). Safe tools (Read, Write, Edit, etc.) still work because they're in the instant-allow list.

4. **The patch is required for LM Studio.** Stock `cc-approve` sends `response_format: { type: "json_object" }` which LM Studio rejects. Our fork removes this. If you update the upstream repo, re-apply the patch and rebuild.

5. **Cache is per-project and per-command.** The same `git status` command in two different projects gets two separate cache entries. Cache key is SHA-256 of `(toolName, toolInput, projectRoot)`.

6. **System prompt auto-updates.** When the package bumps `CURRENT_SYSTEM_PROMPT_VERSION`, the saved prompt is replaced with the new default and the cache is cleared. Disable with `"autoUpdateSystemPrompt": false`.
