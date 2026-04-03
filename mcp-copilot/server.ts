#!/usr/bin/env bun
/**
 * MCP server wrapping GitHub Copilot CLI.
 *
 * Exposes tools that let any Claude session run Copilot tasks on-demand:
 *   - copilot_run:  Execute a coding task via Copilot CLI
 *   - copilot_ask:  Ask Copilot a question about code (read-only)
 *   - copilot_list: List recent Copilot sessions
 *
 * Config (env):
 *   COPILOT_BIN — path to copilot binary (default: auto-detect)
 *   COPILOT_DEFAULT_WORKDIR — default working directory (default: /root)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawnSync } from "child_process";
import { existsSync } from "fs";

// ── config ──────────────────────────────────────────────────────────────────

function findCopilot(): string {
  const explicit = process.env.COPILOT_BIN;
  if (explicit && existsSync(explicit)) return explicit;

  // Try common locations
  const candidates = [
    "/usr/bin/copilot",
    "/usr/local/bin/copilot",
    `${process.env.HOME}/.nvm/versions/node/v22.22.0/bin/copilot`,
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  // Fallback to PATH
  const which = spawnSync("which", ["copilot"], { encoding: "utf8" });
  if (which.status === 0) return which.stdout.trim();

  throw new Error("copilot binary not found — set COPILOT_BIN env var");
}

const COPILOT_BIN = findCopilot();
const DEFAULT_WORKDIR = process.env.COPILOT_DEFAULT_WORKDIR ?? "/root";
const MAX_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

process.stderr.write(`mcp-copilot: using ${COPILOT_BIN}\n`);

// ── helpers ─────────────────────────────────────────────────────────────────

interface CopilotResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runCopilot(
  prompt: string,
  workdir: string,
  allowAll: boolean,
  timeoutMs: number
): CopilotResult {
  const args: string[] = [];

  // Non-interactive prompt mode
  args.push("-p", prompt);

  // Permission flags
  if (allowAll) {
    args.push("--allow-all");
  } else {
    // Read-only: only allow read tools
    args.push("--allow-tool", "read", "--allow-tool", "shell(cat:*)", "--allow-tool", "shell(ls:*)", "--allow-tool", "shell(git log:*)");
  }

  const result = spawnSync(COPILOT_BIN, args, {
    cwd: workdir,
    encoding: "utf8",
    timeout: timeoutMs,
    env: {
      ...process.env,
      // Ensure copilot doesn't try interactive input
      CI: "1",
    },
    maxBuffer: 10 * 1024 * 1024, // 10MB
  });

  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function extractCopilotOutput(result: CopilotResult): string {
  // Copilot outputs the response to stdout in -p mode
  let output = result.stdout.trim();

  // If stdout is empty, check stderr for useful info
  if (!output && result.stderr) {
    output = result.stderr.trim();
  }

  // Truncate very long output
  if (output.length > 8000) {
    output = output.slice(0, 7500) + "\n\n... [truncated, full output was " + output.length + " chars]";
  }

  return output || "(no output)";
}

// ── MCP server ──────────────────────────────────────────────────────────────

const server = new Server(
  { name: "mcp-copilot", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "copilot_run",
      description:
        "Execute a coding task using GitHub Copilot CLI. Copilot can read/write files, " +
        "run shell commands, and make code changes. Use for tasks like refactoring, " +
        "adding features, fixing bugs, running tests, etc.",
      inputSchema: {
        type: "object" as const,
        properties: {
          prompt: {
            type: "string",
            description: "The task description for Copilot to execute",
          },
          workdir: {
            type: "string",
            description: `Working directory for Copilot (default: ${DEFAULT_WORKDIR})`,
          },
          timeout_seconds: {
            type: "number",
            description: "Max execution time in seconds (default: 120, max: 300)",
          },
        },
        required: ["prompt"],
      },
    },
    {
      name: "copilot_ask",
      description:
        "Ask GitHub Copilot a question about code. Read-only — Copilot can read files " +
        "and explore the codebase but won't make changes. Use for code review, " +
        "understanding, searching, etc.",
      inputSchema: {
        type: "object" as const,
        properties: {
          question: {
            type: "string",
            description: "The question to ask Copilot about the code",
          },
          workdir: {
            type: "string",
            description: `Working directory context (default: ${DEFAULT_WORKDIR})`,
          },
          timeout_seconds: {
            type: "number",
            description: "Max execution time in seconds (default: 60, max: 300)",
          },
        },
        required: ["question"],
      },
    },
    {
      name: "copilot_list_sessions",
      description: "List recent Copilot CLI sessions",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "copilot_run": {
        const prompt = args?.prompt as string;
        const workdir = (args?.workdir as string) || DEFAULT_WORKDIR;
        const timeoutSec = Math.min((args?.timeout_seconds as number) || 120, 300);

        if (!prompt) {
          return { content: [{ type: "text", text: "Error: prompt is required" }] };
        }

        if (!existsSync(workdir)) {
          return {
            content: [{ type: "text", text: `Error: workdir does not exist: ${workdir}` }],
          };
        }

        process.stderr.write(`copilot_run: ${workdir} — ${prompt.slice(0, 80)}...\n`);
        const result = runCopilot(prompt, workdir, true, timeoutSec * 1000);
        const output = extractCopilotOutput(result);

        return {
          content: [
            {
              type: "text",
              text: `**Copilot run** (exit ${result.exitCode}):\n\n${output}`,
            },
          ],
        };
      }

      case "copilot_ask": {
        const question = args?.question as string;
        const workdir = (args?.workdir as string) || DEFAULT_WORKDIR;
        const timeoutSec = Math.min((args?.timeout_seconds as number) || 60, 300);

        if (!question) {
          return { content: [{ type: "text", text: "Error: question is required" }] };
        }

        if (!existsSync(workdir)) {
          return {
            content: [{ type: "text", text: `Error: workdir does not exist: ${workdir}` }],
          };
        }

        process.stderr.write(`copilot_ask: ${workdir} — ${question.slice(0, 80)}...\n`);
        const result = runCopilot(question, workdir, false, timeoutSec * 1000);
        const output = extractCopilotOutput(result);

        return {
          content: [
            {
              type: "text",
              text: `**Copilot answer**:\n\n${output}`,
            },
          ],
        };
      }

      case "copilot_list_sessions": {
        const result = spawnSync(COPILOT_BIN, ["session", "list"], {
          encoding: "utf8",
          timeout: 10_000,
        });
        const output = (result.stdout || result.stderr || "(no sessions)").trim();
        return {
          content: [{ type: "text", text: output }],
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
        };
    }
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
    };
  }
});

// ── start ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("mcp-copilot: server running on stdio\n");
