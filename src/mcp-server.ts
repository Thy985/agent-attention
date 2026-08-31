/**
 * Agent Attention MCP Server — @modelcontextprotocol/sdk
 *
 * Exposes the local state.json as read-only tools (plus mark-all-read as
 * write) so any dsh / Claude Code / Codex session that mounts this MCP
 * server can query attention events without hitting the CLI.
 *
 * Transport: stdio (default for dsh-mcp-client).
 *
 * Tool contract:
 *   - attention__get_events      list recent events (unreadCount + events)
 *   - attention__clear_events    mark all events read (equivalent to daemon-cli mark-all-read)
 *   - attention__agents          list registered agents from agents.json
 *   - attention__state           raw state read (diagnostic)
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import * as path from 'path';
import * as os from 'os';
import { readState, clearUnread } from './state';
import { readRegistry } from './registry';
import { log } from './logging';

// ── paths ──────────────────────────────────────────────────────────────────

function stateDir(): string {
  return process.env.AGENT_ATTENTION_STATE_DIR
    ?? path.join(os.homedir(), '.agent-attention');
}

function statePath(): string {
  return path.join(stateDir(), 'state.json');
}

function registryPath(): string {
  return path.join(stateDir(), 'agents.json');
}

// ── tool schemas ────────────────────────────────────────────────────────────

const GET_EVENTS_TOOL: Tool = {
  name: 'attention__get_events',
  description:
    'List recent Agent Attention events. Returns unreadCount plus the last N events ' +
    '(default 20). Use unreadOnly=true to surface only unread items.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      limit: {
        type: 'number' as const,
        description: 'Max events to return (default 20, max 200).',
        minimum: 1,
        maximum: 200,
      },
      unreadOnly: {
        type: 'boolean' as const,
        description: 'When true, return only unread events.',
      },
      agentId: {
        type: 'string' as const,
        description: 'Optional filter by agent_id.',
      },
    },
    required: [] as string[],
  },
};

const CLEAR_EVENTS_TOOL: Tool = {
  name: 'attention__clear_events',
  description:
    'Mark all events as read (equivalent to `agent-attention mark-all-read`). ' +
    'Returns the number of events that were cleared.',
  inputSchema: {
    type: 'object' as const,
    properties: {} as Record<string, never>,
    required: [] as string[],
  },
};

const AGENTS_TOOL: Tool = {
  name: 'attention__agents',
  description:
    'List registered agents from agents.json. Each entry includes id, name, ' +
    'binary, integration mode, and last_seen_at epoch ms.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      agentId: {
        type: 'string' as const,
        description: 'Optional: filter to one agent by id.',
      },
    },
    required: [] as string[],
  },
};

const STATE_TOOL: Tool = {
  name: 'attention__state',
  description:
    'Diagnostic: return the full raw state object from state.json. ' +
    'Useful for debugging; prefer get_events for normal consumption.',
  inputSchema: {
    type: 'object' as const,
    properties: {} as Record<string, never>,
    required: [] as string[],
  },
};

const TOOLS = [GET_EVENTS_TOOL, CLEAR_EVENTS_TOOL, AGENTS_TOOL, STATE_TOOL] as const;

// ── handlers ────────────────────────────────────────────────────────────────

async function handleGetEvents(args: {
  limit?: number;
  unreadOnly?: boolean;
  agentId?: string;
}): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const limit = Math.min(Math.max(Number(args.limit ?? 20), 1), 200);
  const sp = statePath();
  const state = readState(sp);

  let events = state.events;
  if (args.unreadOnly) {
    events = events.filter((e) => !e.read);
  }
  if (args.agentId) {
    events = events.filter((e) => e.agent_id === args.agentId);
  }
  events = events.slice(-limit);

  const payload = {
    unreadCount: state.unreadCount,
    totalEvents: state.events.length,
    returned: events.length,
    events,
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

async function handleClearEvents(): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const sp = statePath();
  const before = readState(sp);
  clearUnread(sp);
  const after = readState(sp);
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            cleared: before.unreadCount,
            remaining: after.unreadCount,
            totalEvents: after.events.length,
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function handleAgents(args: { agentId?: string }): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const registry = readRegistry();
  let agents = registry.agents;
  if (args.agentId) {
    agents = agents.filter((a) => a.agent_id === args.agentId);
  }
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ count: agents.length, agents }, null, 2),
      },
    ],
  };
}

async function handleState(): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const sp = statePath();
  const state = readState(sp);
  return {
    content: [{ type: 'text', text: JSON.stringify(state, null, 2) }],
  };
}

const HANDLERS: Record<string, (args: unknown) => Promise<{ content: Array<{ type: 'text'; text: string }> }>> = {
  'attention__get_events': (args: unknown) => handleGetEvents(args as { limit?: number; unreadOnly?: boolean; agentId?: string }),
  'attention__clear_events': () => handleClearEvents(),
  'attention__agents': (args: unknown) => handleAgents(args as { agentId?: string }),
  'attention__state': () => handleState(),
};

// ── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const server = new Server(
    {
      name: 'agent-attention-mcp',
      version: '0.2.0',
    },
    {
      capabilities: { tools: {} },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const handler = HANDLERS[request.params.name];
    if (!handler) {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }
    try {
      return await handler(request.params.arguments ?? {});
    } catch (err) {
      log({
        component: 'mcp',
        level: 'ERROR',
        event: 'tool_error',
        message: `tool ${request.params.name} failed: ${(err as Error).message}`,
      });
      throw err;
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main();
