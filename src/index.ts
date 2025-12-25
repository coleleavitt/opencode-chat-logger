import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ChatLoggerDb, type Sector } from "./db";
import { createEmbeddingProvider, type EmbeddingProvider } from "./embedding";
import {
  classifySector,
  classifyFromToolCall,
  getSectorDecayRate,
  estimateInitialSalience,
} from "./sectors";
import {
  searchMemories,
  reinforceRetrievedMemories,
  formatMemoriesForContext,
} from "./scoring";
import { createWaypointsForMemory } from "./graph";

// ============================================================================
// Configuration
// ============================================================================

interface ChatLoggerConfig {
  logDir?: string;
  retentionDays?: number;
  enableEventLog?: boolean;
  maxToolOutputLength?: number;
}

const DEFAULT_CONFIG: Required<ChatLoggerConfig> = {
  logDir: path.join(os.homedir(), ".local", "share", "opencode", "chat-logs"),
  retentionDays: 30,
  enableEventLog: true,
  maxToolOutputLength: 10000,
};

function getUserConfigDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support");
  }
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
}

function loadConfig(directory: string): Required<ChatLoggerConfig> {
  const userConfigPath = path.join(
    getUserConfigDir(),
    "opencode",
    "chat-logger.json",
  );
  const projectConfigPath = path.join(
    directory,
    ".opencode",
    "chat-logger.json",
  );

  let config: ChatLoggerConfig = {};

  // Load user config
  if (fs.existsSync(userConfigPath)) {
    try {
      const content = fs.readFileSync(userConfigPath, "utf-8");
      config = { ...config, ...JSON.parse(content) };
    } catch (e) {
      // Invalid config, use defaults
    }
  }

  // Override with project config
  if (fs.existsSync(projectConfigPath)) {
    try {
      const content = fs.readFileSync(projectConfigPath, "utf-8");
      config = { ...config, ...JSON.parse(content) };
    } catch (e) {
      // Invalid config, use defaults
    }
  }

  return { ...DEFAULT_CONFIG, ...config };
}

// ============================================================================
// Session Metadata Types
// ============================================================================

interface SessionMetadata {
  sessionID: string;
  directory?: string;
  projectID?: string;
  title?: string;
  version?: string;
  createdAt: string;
  lastUpdated: string;
  lastAgent?: string;
  lastModel?: string;
  messageCount: number;
}

// ============================================================================
// Log Rotation
// ============================================================================

function cleanupOldSessions(sessionsDir: string, retentionDays: number): void {
  if (!fs.existsSync(sessionsDir) || retentionDays <= 0) return;

  const cutoffTime = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  try {
    const sessions = fs.readdirSync(sessionsDir);
    for (const sessionID of sessions) {
      const sessionDir = path.join(sessionsDir, sessionID);
      const metadataFile = path.join(sessionDir, "metadata.json");

      if (!fs.statSync(sessionDir).isDirectory()) continue;

      let shouldDelete = false;

      if (fs.existsSync(metadataFile)) {
        try {
          const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf-8"));
          const lastUpdated = new Date(
            metadata.lastUpdated || metadata.createdAt,
          ).getTime();
          shouldDelete = lastUpdated < cutoffTime;
        } catch {
          // Can't parse metadata, check dir mtime
          shouldDelete = fs.statSync(sessionDir).mtimeMs < cutoffTime;
        }
      } else {
        // No metadata, use directory mtime
        shouldDelete = fs.statSync(sessionDir).mtimeMs < cutoffTime;
      }

      if (shouldDelete) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    }
  } catch (e) {
    // Cleanup failed silently
  }
}

function cleanupOldEventLogs(eventsDir: string, retentionDays: number): void {
  if (!fs.existsSync(eventsDir) || retentionDays <= 0) return;

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
  const cutoffStr = cutoffDate.toISOString().slice(0, 10);

  try {
    const files = fs.readdirSync(eventsDir);
    for (const file of files) {
      if (file.endsWith(".jsonl") && file < cutoffStr) {
        fs.unlinkSync(path.join(eventsDir, file));
      }
    }
  } catch (e) {
    // Cleanup failed silently
  }
}

// ============================================================================
// Search Functionality
// ============================================================================

interface SearchResult {
  sessionID: string;
  metadata: SessionMetadata;
  matches: Array<{
    file: string;
    line: number;
    content: string;
  }>;
}

function searchSessions(
  sessionsDir: string,
  query: string,
  options: { limit?: number; startDate?: string; endDate?: string } = {},
): SearchResult[] {
  const results: SearchResult[] = [];
  const limit = options.limit || 20;
  const queryLower = query.toLowerCase();

  if (!fs.existsSync(sessionsDir)) return results;

  const sessions = fs.readdirSync(sessionsDir);

  for (const sessionID of sessions) {
    if (results.length >= limit) break;

    const sessionDir = path.join(sessionsDir, sessionID);
    if (!fs.statSync(sessionDir).isDirectory()) continue;

    const metadataFile = path.join(sessionDir, "metadata.json");
    if (!fs.existsSync(metadataFile)) continue;

    let metadata: SessionMetadata;
    try {
      metadata = JSON.parse(fs.readFileSync(metadataFile, "utf-8"));
    } catch {
      continue;
    }

    // Date filtering
    if (options.startDate && metadata.createdAt < options.startDate) continue;
    if (options.endDate && metadata.createdAt > options.endDate) continue;

    const matches: SearchResult["matches"] = [];

    // Search messages
    const messagesFile = path.join(sessionDir, "messages.jsonl");
    if (fs.existsSync(messagesFile)) {
      const lines = fs.readFileSync(messagesFile, "utf-8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;

        try {
          const msg = JSON.parse(line);
          const content =
            typeof msg.content === "string"
              ? msg.content
              : JSON.stringify(msg.content);
          if (content.toLowerCase().includes(queryLower)) {
            matches.push({
              file: "messages.jsonl",
              line: i + 1,
              content:
                content.substring(0, 200) + (content.length > 200 ? "..." : ""),
            });
          }
        } catch {}
      }
    }

    // Search metadata
    const metadataStr = JSON.stringify(metadata).toLowerCase();
    if (metadataStr.includes(queryLower)) {
      matches.push({
        file: "metadata.json",
        line: 1,
        content: `Title: ${metadata.title || "untitled"}, Directory: ${metadata.directory || "unknown"}`,
      });
    }

    if (matches.length > 0) {
      results.push({ sessionID, metadata, matches });
    }
  }

  return results;
}

// ============================================================================
// Export Functionality
// ============================================================================

function exportSessionToMarkdown(
  sessionsDir: string,
  sessionID: string,
): string {
  const sessionDir = path.join(sessionsDir, sessionID);
  if (!fs.existsSync(sessionDir)) {
    return `Session ${sessionID} not found.`;
  }

  const metadataFile = path.join(sessionDir, "metadata.json");
  const messagesFile = path.join(sessionDir, "messages.jsonl");

  let output = "";

  // Metadata header
  if (fs.existsSync(metadataFile)) {
    try {
      const metadata: SessionMetadata = JSON.parse(
        fs.readFileSync(metadataFile, "utf-8"),
      );
      output += `# Session: ${metadata.title || sessionID}\n\n`;
      output += `- **Directory**: ${metadata.directory || "unknown"}\n`;
      output += `- **Created**: ${metadata.createdAt}\n`;
      output += `- **Last Updated**: ${metadata.lastUpdated}\n`;
      output += `- **Messages**: ${metadata.messageCount}\n`;
      output += `- **Agent**: ${metadata.lastAgent || "unknown"}\n`;
      output += `- **Model**: ${metadata.lastModel || "unknown"}\n`;
      output += "\n---\n\n";
    } catch {
      output += `# Session: ${sessionID}\n\n---\n\n`;
    }
  }

  // Messages
  if (fs.existsSync(messagesFile)) {
    const lines = fs.readFileSync(messagesFile, "utf-8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const msg = JSON.parse(line);
        const role = msg.role || "unknown";
        const content =
          typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content, null, 2);
        const timestamp = msg._timestamp
          ? `_${new Date(msg._timestamp).toLocaleString()}_`
          : "";

        output += `## ${role.charAt(0).toUpperCase() + role.slice(1)} ${timestamp}\n\n`;
        output += `${content}\n\n`;
      } catch {}
    }
  }

  return output;
}

function listSessions(
  sessionsDir: string,
  limit: number = 50,
): SessionMetadata[] {
  if (!fs.existsSync(sessionsDir)) return [];

  const sessions: SessionMetadata[] = [];
  const dirs = fs.readdirSync(sessionsDir);

  for (const sessionID of dirs) {
    const sessionDir = path.join(sessionsDir, sessionID);
    if (!fs.statSync(sessionDir).isDirectory()) continue;

    const metadataFile = path.join(sessionDir, "metadata.json");
    if (fs.existsSync(metadataFile)) {
      try {
        const metadata: SessionMetadata = JSON.parse(
          fs.readFileSync(metadataFile, "utf-8"),
        );
        sessions.push(metadata);
      } catch {}
    }
  }

  // Sort by lastUpdated descending
  sessions.sort(
    (a, b) =>
      new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime(),
  );

  return sessions.slice(0, limit);
}

// ============================================================================
// Plugin
// ============================================================================

const chatLogger: Plugin = async (input: PluginInput): Promise<Hooks> => {
  const config = loadConfig(input.directory);
  const { logDir, retentionDays, enableEventLog, maxToolOutputLength } = config;

  const sessionsDir = path.join(logDir, "sessions");
  const eventsDir = path.join(logDir, "events");

  const sessionMetadataCache = new Map<string, SessionMetadata>();

  const db = new ChatLoggerDb(logDir);

  let embedder: EmbeddingProvider | null = null;
  const getEmbedder = async (): Promise<EmbeddingProvider> => {
    if (!embedder) {
      embedder = await createEmbeddingProvider("ollama");
    }
    return embedder;
  };

  const createMemoryFromContent = async (
    sessionId: string,
    content: string,
    metadata?: {
      isUserMessage?: boolean;
      hasCodeBlock?: boolean;
      toolCount?: number;
    },
  ): Promise<string | null> => {
    if (content.length < 50) return null;

    const classification = classifySector(content);
    const salience = estimateInitialSalience(
      content,
      classification.sector,
      metadata,
    );
    const decayRate = getSectorDecayRate(classification.sector);

    const memoryId = crypto.randomUUID();

    db.insertMemory({
      id: memoryId,
      session_id: sessionId,
      content: content.substring(0, 2000),
      sector: classification.sector,
      salience,
      decay_lambda: decayRate,
      metadata_json: JSON.stringify({
        confidence: classification.confidence,
        secondarySectors: classification.secondarySectors,
      }),
    });

    try {
      const emb = await getEmbedder();
      const vector = await emb.embed(content.substring(0, 1000));
      db.insertMemoryVector(memoryId, classification.sector, vector);

      await createWaypointsForMemory(db, memoryId);
    } catch {}

    return memoryId;
  };

  const ensureDirs = () => {
    for (const dir of [logDir, sessionsDir, eventsDir]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  };

  const getDateString = () => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  };

  const appendJsonl = (filepath: string, data: object) => {
    ensureDirs();
    const dir = path.dirname(filepath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const line =
      JSON.stringify({ ...data, _timestamp: new Date().toISOString() }) + "\n";
    fs.appendFileSync(filepath, line);
  };

  const writeJson = (filepath: string, data: object) => {
    ensureDirs();
    const dir = path.dirname(filepath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
  };

  const readJson = (filepath: string): Record<string, unknown> => {
    if (fs.existsSync(filepath)) {
      return JSON.parse(fs.readFileSync(filepath, "utf-8"));
    }
    return {};
  };

  const ensureSessionDir = (sessionID: string) => {
    const sessionDir = path.join(sessionsDir, sessionID);
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }
    return sessionDir;
  };

  const updateSessionMetadata = (
    sessionID: string,
    updates: Partial<SessionMetadata>,
  ) => {
    const sessionDir = ensureSessionDir(sessionID);
    const metadataFile = path.join(sessionDir, "metadata.json");

    let metadata =
      sessionMetadataCache.get(sessionID) ||
      (readJson(metadataFile) as unknown as SessionMetadata);
    const now = new Date().toISOString();

    metadata = {
      ...metadata,
      ...updates,
      sessionID,
      lastUpdated: now,
      createdAt: metadata.createdAt || now,
      messageCount: metadata.messageCount || 0,
    };

    sessionMetadataCache.set(sessionID, metadata);
    writeJson(metadataFile, metadata);
    return metadata;
  };

  return {
    // Tools for searching and exporting
    tool: {
      chat_log_search: tool({
        description:
          'Search past chat sessions using full-text search (FTS5). Supports boolean operators (AND, OR, NOT), phrase matching ("exact phrase"), and prefix matching (term*).',
        args: {
          query: tool.schema
            .string()
            .describe(
              "FTS5 search query. Examples: 'rust async', 'error AND database', '\"exact phrase\"', 'react*'",
            ),
          limit: tool.schema
            .number()
            .optional()
            .describe("Maximum results to return (default: 50)"),
          session_id: tool.schema
            .string()
            .optional()
            .describe("Limit search to a specific session"),
          start_date: tool.schema
            .string()
            .optional()
            .describe("Filter sessions after this date (ISO format)"),
          end_date: tool.schema
            .string()
            .optional()
            .describe("Filter sessions before this date (ISO format)"),
        },
        async execute(args) {
          try {
            const results = db.searchMessages(args.query, {
              limit: args.limit,
              sessionId: args.session_id,
              startDate: args.start_date,
              endDate: args.end_date,
            });

            if (results.length === 0) {
              return `No messages found matching "${args.query}"`;
            }

            let output = `Found ${results.length} message(s) matching "${args.query}":\n\n`;

            const bySession = new Map<string, typeof results>();
            for (const result of results) {
              const existing = bySession.get(result.session_id) || [];
              existing.push(result);
              bySession.set(result.session_id, existing);
            }

            for (const [sessionId, messages] of bySession) {
              const first = messages[0];
              output += `## Session: ${first.session_title || sessionId}\n`;
              output += `- ID: ${sessionId}\n`;
              output += `- Directory: ${first.session_directory || "unknown"}\n`;
              output += `- Created: ${first.session_created_at}\n`;
              output += `- Matching messages: ${messages.length}\n\n`;

              for (const msg of messages.slice(0, 5)) {
                output += `### ${msg.role} (rank: ${msg.rank.toFixed(2)})\n`;
                output += `${msg.snippet.replace(/>>>/g, "**").replace(/<<</g, "**")}\n\n`;
              }
            }

            return output;
          } catch (e) {
            const fallbackResults = searchSessions(sessionsDir, args.query, {
              limit: args.limit,
              startDate: args.start_date,
              endDate: args.end_date,
            });

            if (fallbackResults.length === 0) {
              return `No sessions found matching "${args.query}"`;
            }

            let output = `Found ${fallbackResults.length} session(s) matching "${args.query}" (fallback search):\n\n`;
            for (const result of fallbackResults) {
              output += `## Session: ${result.metadata.title || result.sessionID}\n`;
              output += `- ID: ${result.sessionID}\n`;
              output += `- Directory: ${result.metadata.directory || "unknown"}\n`;
              output += `- Created: ${result.metadata.createdAt}\n`;
              output += `- Messages: ${result.metadata.messageCount}\n`;
              output += `- Matches: ${result.matches.length}\n`;
              for (const match of result.matches.slice(0, 3)) {
                output += `  - ${match.file}:${match.line}: ${match.content}\n`;
              }
              output += "\n";
            }

            return output;
          }
        },
      }),

      chat_log_export: tool({
        description:
          "Export a chat session to markdown format for reading or archival.",
        args: {
          session_id: tool.schema.string().describe("Session ID to export"),
        },
        async execute(args) {
          return exportSessionToMarkdown(sessionsDir, args.session_id);
        },
      }),

      chat_log_list: tool({
        description: "List recent chat sessions with their metadata.",
        args: {
          limit: tool.schema
            .number()
            .optional()
            .describe("Maximum sessions to return (default: 50)"),
          directory: tool.schema
            .string()
            .optional()
            .describe("Filter by project directory"),
        },
        async execute(args) {
          const dbSessions = db.listSessions({
            limit: args.limit || 50,
            directory: args.directory,
          });

          if (dbSessions.length > 0) {
            let output = `Found ${dbSessions.length} session(s):\n\n`;
            for (const session of dbSessions) {
              output += `- **${session.title || session.id}**\n`;
              output += `  - ID: ${session.id}\n`;
              output += `  - Directory: ${session.directory || "unknown"}\n`;
              output += `  - Last Updated: ${session.updated_at}\n`;
              output += `  - Messages: ${session.message_count}\n\n`;
            }
            return output;
          }

          const sessions = listSessions(sessionsDir, args.limit || 50);

          if (sessions.length === 0) {
            return "No chat sessions found.";
          }

          let output = `Found ${sessions.length} session(s):\n\n`;
          for (const session of sessions) {
            output += `- **${session.title || session.sessionID}**\n`;
            output += `  - ID: ${session.sessionID}\n`;
            output += `  - Directory: ${session.directory || "unknown"}\n`;
            output += `  - Last Updated: ${session.lastUpdated}\n`;
            output += `  - Messages: ${session.messageCount}\n\n`;
          }

          return output;
        },
      }),

      chat_log_cleanup: tool({
        description:
          "Manually trigger cleanup of old chat sessions based on retention policy.",
        args: {
          days: tool.schema
            .number()
            .optional()
            .describe(
              "Delete sessions older than N days (default: config value)",
            ),
        },
        async execute(args) {
          const days = args.days || retentionDays;
          cleanupOldSessions(sessionsDir, days);
          cleanupOldEventLogs(eventsDir, days);
          return `Cleanup completed. Removed sessions older than ${days} days.`;
        },
      }),

      chat_log_stats: tool({
        description: "Get statistics about the chat log database.",
        args: {},
        async execute() {
          const stats = db.getStats();
          const dbPath = path.join(logDir, "chat-logs.db");
          const dbSize = fs.existsSync(dbPath)
            ? (fs.statSync(dbPath).size / 1024 / 1024).toFixed(2) + " MB"
            : "unknown";

          return (
            `## Chat Log Statistics\n\n` +
            `- **Sessions**: ${stats.sessions}\n` +
            `- **Messages**: ${stats.messages}\n` +
            `- **Tool Calls**: ${stats.toolCalls}\n` +
            `- **Memories**: ${stats.memories}\n` +
            `- **Waypoints**: ${stats.waypoints}\n` +
            `- **Database Size**: ${dbSize}\n` +
            `- **Log Directory**: ${logDir}\n`
          );
        },
      }),

      chat_log_session: tool({
        description:
          "Get detailed information about a specific session including all messages.",
        args: {
          session_id: tool.schema.string().describe("Session ID to retrieve"),
          include_tools: tool.schema
            .boolean()
            .optional()
            .describe("Include tool calls (default: false)"),
        },
        async execute(args) {
          const session = db.getSession(args.session_id);
          if (!session) {
            return `Session ${args.session_id} not found.`;
          }

          const messages = db.getSessionMessages(args.session_id);

          let output = `## Session: ${session.title || session.id}\n\n`;
          output += `- **ID**: ${session.id}\n`;
          output += `- **Directory**: ${session.directory || "unknown"}\n`;
          output += `- **Created**: ${session.created_at}\n`;
          output += `- **Updated**: ${session.updated_at}\n`;
          output += `- **Messages**: ${session.message_count}\n`;
          output += `- **Agent**: ${session.last_agent || "unknown"}\n`;
          output += `- **Model**: ${session.last_model || "unknown"}\n\n`;
          output += `---\n\n`;

          for (const msg of messages) {
            output += `### ${msg.role.charAt(0).toUpperCase() + msg.role.slice(1)}\n`;
            output += `_${msg.created_at}_\n\n`;
            output += `${msg.content.substring(0, 2000)}${msg.content.length > 2000 ? "..." : ""}\n\n`;
          }

          if (args.include_tools) {
            const toolCalls = db.getSessionToolCalls(args.session_id);
            if (toolCalls.length > 0) {
              output += `---\n\n## Tool Calls (${toolCalls.length})\n\n`;
              for (const tc of toolCalls) {
                output += `- **${tc.tool}** (${tc.phase}) - ${tc.created_at}\n`;
              }
            }
          }

          return output;
        },
      }),

      chat_log_embedding_status: tool({
        description:
          "Check the status of message embeddings for semantic search.",
        args: {},
        async execute() {
          const stats = db.getStats();
          const withoutEmbeddings = db.getMessagesWithoutEmbeddings(1);
          const hasUnembedded = withoutEmbeddings.length > 0;

          return (
            `## Embedding Status\n\n` +
            `- **Total Messages**: ${stats.messages}\n` +
            `- **Pending Embeddings**: ${hasUnembedded ? "Yes (run embedding generation)" : "All messages embedded"}\n\n` +
            `_Note: Embedding generation is not yet implemented. The schema is ready for future integration with Ollama or OpenAI embeddings._`
          );
        },
      }),

      chat_log_tool_stats: tool({
        description:
          "Analyze tool usage patterns across sessions. Shows most used tools, success rates, and trends.",
        args: {
          days: tool.schema
            .number()
            .optional()
            .describe("Look back N days (default: 30)"),
          tool_name: tool.schema
            .string()
            .optional()
            .describe("Filter to specific tool"),
          top: tool.schema
            .number()
            .optional()
            .describe("Show top N tools (default: 20)"),
        },
        async execute(args) {
          const days = args.days || 30;
          const top = args.top || 20;
          const cutoff = new Date(
            Date.now() - days * 24 * 60 * 60 * 1000,
          ).toISOString();

          try {
            let sql = `
              SELECT 
                tool,
                COUNT(*) as total_calls,
                SUM(CASE WHEN phase = 'after' THEN 1 ELSE 0 END) as completed,
                COUNT(DISTINCT session_id) as sessions_used
              FROM tool_calls
              WHERE created_at > ?
            `;
            const params: (string | number)[] = [cutoff];

            if (args.tool_name) {
              sql += ` AND tool LIKE ?`;
              params.push(`%${args.tool_name}%`);
            }

            sql += ` GROUP BY tool ORDER BY total_calls DESC LIMIT ?`;
            params.push(top);

            const stmt = db["db"].prepare(sql);
            const results = stmt.all(...params) as Array<{
              tool: string;
              total_calls: number;
              completed: number;
              sessions_used: number;
            }>;

            if (results.length === 0) {
              return `No tool usage found in the last ${days} days.`;
            }

            let output = `## Tool Usage Statistics (last ${days} days)\n\n`;
            output += `| Tool | Calls | Completed | Sessions | Rate |\n`;
            output += `|------|-------|-----------|----------|------|\n`;

            for (const r of results) {
              const rate =
                r.total_calls > 0
                  ? ((r.completed / (r.total_calls / 2)) * 100).toFixed(0)
                  : "0";
              output += `| ${r.tool} | ${r.total_calls} | ${r.completed} | ${r.sessions_used} | ${rate}% |\n`;
            }

            const totalCalls = results.reduce(
              (sum, r) => sum + r.total_calls,
              0,
            );
            output += `\n**Total**: ${totalCalls} tool calls across ${results.length} unique tools`;

            return output;
          } catch (e) {
            return `Error analyzing tool stats: ${e}`;
          }
        },
      }),

      chat_log_decisions: tool({
        description:
          "Find past file changes and decisions. Useful for understanding why code was changed.",
        args: {
          file_pattern: tool.schema
            .string()
            .describe(
              "File path pattern to search for (e.g., 'src/auth', '.tsx')",
            ),
          days: tool.schema
            .number()
            .optional()
            .describe("Look back N days (default: 30)"),
          limit: tool.schema
            .number()
            .optional()
            .describe("Max results (default: 20)"),
        },
        async execute(args) {
          const days = args.days || 30;
          const limit = args.limit || 20;
          const cutoff = new Date(
            Date.now() - days * 24 * 60 * 60 * 1000,
          ).toISOString();

          try {
            const sql = `
              SELECT 
                tc.tool,
                tc.args_json,
                tc.title,
                tc.created_at,
                s.title as session_title,
                s.directory
              FROM tool_calls tc
              JOIN sessions s ON tc.session_id = s.id
              WHERE tc.tool IN ('edit', 'write', 'Edit', 'Write')
                AND tc.args_json LIKE ?
                AND tc.created_at > ?
                AND tc.phase = 'after'
              ORDER BY tc.created_at DESC
              LIMIT ?
            `;

            const stmt = db["db"].prepare(sql);
            const results = stmt.all(
              `%${args.file_pattern}%`,
              cutoff,
              limit,
            ) as Array<{
              tool: string;
              args_json: string | null;
              title: string | null;
              created_at: string;
              session_title: string | null;
              directory: string | null;
            }>;

            if (results.length === 0) {
              return `No file changes found matching "${args.file_pattern}" in the last ${days} days.`;
            }

            let output = `## File Changes Matching "${args.file_pattern}" (last ${days} days)\n\n`;

            for (const r of results) {
              let filePath = "unknown";
              try {
                const parsed = JSON.parse(r.args_json || "{}");
                filePath = parsed.filePath || parsed.path || "unknown";
              } catch {
                // ignore parse errors
              }

              output += `### ${r.created_at}\n`;
              output += `- **File**: \`${filePath}\`\n`;
              output += `- **Tool**: ${r.tool}\n`;
              output += `- **Session**: ${r.session_title || "untitled"}\n`;
              if (r.title) output += `- **Action**: ${r.title}\n`;
              output += `\n`;
            }

            return output;
          } catch (e) {
            return `Error searching decisions: ${e}`;
          }
        },
      }),

      chat_log_workflow: tool({
        description:
          "Analyze workflow patterns - common tool sequences, session durations, productivity metrics.",
        args: {
          days: tool.schema
            .number()
            .optional()
            .describe("Look back N days (default: 7)"),
        },
        async execute(args) {
          const days = args.days || 7;
          const cutoff = new Date(
            Date.now() - days * 24 * 60 * 60 * 1000,
          ).toISOString();

          try {
            const sessionsSql = `
              SELECT 
                id,
                title,
                directory,
                message_count,
                created_at,
                updated_at
              FROM sessions
              WHERE created_at > ?
              ORDER BY created_at DESC
            `;
            const sessions = db["db"]
              .prepare(sessionsSql)
              .all(cutoff) as Array<{
              id: string;
              title: string | null;
              directory: string | null;
              message_count: number;
              created_at: string;
              updated_at: string;
            }>;

            const toolsSql = `
              SELECT tool, COUNT(*) as count
              FROM tool_calls
              WHERE created_at > ?
              GROUP BY tool
              ORDER BY count DESC
              LIMIT 10
            `;
            const topTools = db["db"].prepare(toolsSql).all(cutoff) as Array<{
              tool: string;
              count: number;
            }>;

            const projectsSql = `
              SELECT directory, COUNT(*) as sessions, SUM(message_count) as messages
              FROM sessions
              WHERE created_at > ? AND directory IS NOT NULL
              GROUP BY directory
              ORDER BY sessions DESC
              LIMIT 5
            `;
            const topProjects = db["db"]
              .prepare(projectsSql)
              .all(cutoff) as Array<{
              directory: string;
              sessions: number;
              messages: number;
            }>;

            let output = `## Workflow Analysis (last ${days} days)\n\n`;

            output += `### Overview\n`;
            output += `- **Sessions**: ${sessions.length}\n`;
            output += `- **Total Messages**: ${sessions.reduce((sum, s) => sum + s.message_count, 0)}\n`;
            output += `- **Avg Messages/Session**: ${sessions.length > 0 ? (sessions.reduce((sum, s) => sum + s.message_count, 0) / sessions.length).toFixed(1) : 0}\n\n`;

            if (topTools.length > 0) {
              output += `### Top Tools\n`;
              for (const t of topTools) {
                output += `- ${t.tool}: ${t.count}\n`;
              }
              output += `\n`;
            }

            if (topProjects.length > 0) {
              output += `### Most Active Projects\n`;
              for (const p of topProjects) {
                const name = p.directory.split("/").pop() || p.directory;
                output += `- **${name}**: ${p.sessions} sessions, ${p.messages} messages\n`;
              }
              output += `\n`;
            }

            if (sessions.length > 0) {
              output += `### Recent Sessions\n`;
              for (const s of sessions.slice(0, 10)) {
                const project = s.directory?.split("/").pop() || "unknown";
                output += `- ${s.title || "untitled"} (${project}) - ${s.message_count} msgs\n`;
              }
            }

            return output;
          } catch (e) {
            return `Error analyzing workflow: ${e}`;
          }
        },
      }),

      chat_log_context: tool({
        description:
          "Get relevant context from past sessions for the current task. Searches for similar work.",
        args: {
          topic: tool.schema
            .string()
            .describe("Topic or task to find context for"),
          limit: tool.schema
            .number()
            .optional()
            .describe("Max relevant sessions (default: 5)"),
        },
        async execute(args) {
          const limit = args.limit || 5;

          try {
            const results = db.searchMessages(args.topic, { limit: limit * 3 });

            if (results.length === 0) {
              return `No relevant context found for "${args.topic}"`;
            }

            const sessionMap = new Map<
              string,
              {
                title: string | null;
                directory: string | null;
                created: string;
                snippets: string[];
              }
            >();

            for (const r of results) {
              if (!sessionMap.has(r.session_id)) {
                sessionMap.set(r.session_id, {
                  title: r.session_title,
                  directory: r.session_directory,
                  created: r.session_created_at,
                  snippets: [],
                });
              }
              const session = sessionMap.get(r.session_id)!;
              if (session.snippets.length < 3) {
                session.snippets.push(
                  r.snippet.replace(/>>>/g, "**").replace(/<<</g, "**"),
                );
              }
            }

            let output = `## Relevant Context for "${args.topic}"\n\n`;

            let count = 0;
            for (const [sessionId, data] of sessionMap) {
              if (count >= limit) break;
              count++;

              output += `### ${data.title || sessionId}\n`;
              output += `_${data.directory || "unknown"} - ${data.created}_\n\n`;
              for (const snippet of data.snippets) {
                output += `> ${snippet.slice(0, 300)}...\n\n`;
              }
            }

            output += `\n_Use \`chat_log_session session_id="<id>"\` to read full session._`;

            return output;
          } catch (e) {
            return `Error finding context: ${e}`;
          }
        },
      }),
    },

    config: async (cfg) => {
      const projectSessions = db.listSessions({
        directory: input.directory,
        limit: 10,
      });

      if (projectSessions.length === 0) return;

      const totalMessages = projectSessions.reduce(
        (sum, s) => sum + s.message_count,
        0,
      );
      const lastSession = projectSessions[0];
      const lastDate = lastSession?.updated_at
        ? new Date(lastSession.updated_at).toLocaleDateString()
        : "unknown";

      const memoryHint = `
[Project Memory]
You have ${projectSessions.length} past session(s) in this project directory (${totalMessages} total messages).
Most recent: "${lastSession?.title || "untitled"}" on ${lastDate}.
Use \`chat_log_search\` to recall previous work, decisions, or code patterns discussed.
Use \`chat_log_list directory="${input.directory}"\` to see all sessions for this project.
`;

      type AgentConfig = { prompt?: string };
      const agents = cfg.agent as Record<string, AgentConfig> | undefined;

      if (agents) {
        for (const agentName of Object.keys(agents)) {
          const agent = agents[agentName];
          if (agent && typeof agent.prompt === "string") {
            agent.prompt = agent.prompt + memoryHint;
          }
        }
      }
    },

    event: async ({ event }) => {
      // Log all events to daily file if enabled
      if (enableEventLog) {
        const eventFile = path.join(eventsDir, `${getDateString()}.jsonl`);
        appendJsonl(eventFile, {
          type: event.type,
          properties: event.properties,
        });
      }

      const props = event.properties as Record<string, unknown> | undefined;
      const info = props?.info as Record<string, unknown> | undefined;

      if (event.type === "session.created" && info?.id) {
        const sessionId = info.id as string;
        updateSessionMetadata(sessionId, {
          directory: info.directory as string | undefined,
          projectID: info.projectID as string | undefined,
          title: info.title as string | undefined,
          version: info.version as string | undefined,
        });
        db.upsertSession({
          id: sessionId,
          directory: info.directory as string | undefined,
          project_id: info.projectID as string | undefined,
          title: info.title as string | undefined,
          version: info.version as string | undefined,
        });
      }

      if (event.type === "session.updated" && info?.id) {
        const sessionId = info.id as string;
        updateSessionMetadata(sessionId, {
          title: info.title as string | undefined,
        });
        db.upsertSession({
          id: sessionId,
          title: info.title as string | undefined,
        });
      }
    },

    "chat.message": async (input, output) => {
      const { sessionID, agent, model, messageID } = input;
      const { message, parts } = output;
      const sessionDir = ensureSessionDir(sessionID);

      const contentStr = parts
        .filter((p) => p.type === "text" && "text" in p)
        .map((p) => (p as { text: string }).text)
        .join("\n");

      const modelStr = model
        ? `${model.providerID}/${model.modelID}`
        : undefined;

      appendJsonl(path.join(sessionDir, "messages.jsonl"), {
        messageID,
        agent,
        model: modelStr,
        role: message.role,
        content: contentStr,
        parts,
      });

      const cached = sessionMetadataCache.get(sessionID);
      updateSessionMetadata(sessionID, {
        lastAgent: agent,
        lastModel: modelStr,
        messageCount: (cached?.messageCount || 0) + 1,
      });

      db.insertMessage({
        id: messageID ?? crypto.randomUUID(),
        session_id: sessionID,
        role: message.role || "unknown",
        content: contentStr || "",
        agent: agent ?? null,
        model: modelStr ?? null,
        parts_json: parts ? JSON.stringify(parts) : null,
        embedding: null,
      });
      db.upsertSession({
        id: sessionID,
        last_agent: agent,
        last_model: modelStr,
      });
      db.incrementMessageCount(sessionID);

      if (message.role === "user" && contentStr.length > 100) {
        const toolCount = parts.filter((p) => p.type === "tool").length;
        createMemoryFromContent(sessionID, contentStr, {
          isUserMessage: true,
          hasCodeBlock: contentStr.includes("```"),
          toolCount,
        }).catch(() => {});
      }
    },

    "tool.execute.before": async (input, output) => {
      const { tool: toolName, sessionID, callID } = input;
      const { args } = output;
      const sessionDir = ensureSessionDir(sessionID);

      appendJsonl(path.join(sessionDir, "tools.jsonl"), {
        phase: "before",
        callID,
        tool: toolName,
        args,
      });

      db.insertToolCall({
        session_id: sessionID,
        call_id: callID,
        tool: toolName,
        phase: "before",
        args_json: args ? JSON.stringify(args) : null,
        output: null,
        title: null,
        metadata_json: null,
      });
    },

    "tool.execute.after": async (input, output) => {
      const { tool: toolName, sessionID, callID } = input;
      const { title, output: toolOutput, metadata } = output;
      const sessionDir = ensureSessionDir(sessionID);

      const truncatedOutput = toolOutput?.substring(0, maxToolOutputLength);

      appendJsonl(path.join(sessionDir, "tools.jsonl"), {
        phase: "after",
        callID,
        tool: toolName,
        title,
        output: truncatedOutput,
        metadata,
      });

      db.insertToolCall({
        session_id: sessionID,
        call_id: callID,
        tool: toolName,
        phase: "after",
        args_json: null,
        output: truncatedOutput ?? null,
        title: title ?? null,
        metadata_json: metadata ? JSON.stringify(metadata) : null,
      });
    },

    "experimental.session.compacting": async (input, output) => {
      const { sessionID } = input;

      try {
        const session = db.getSession(sessionID);
        if (!session) return;

        const messages = db.getSessionMessages(sessionID);
        const recentContent = messages
          .slice(-10)
          .map((m) => m.content)
          .join("\n");

        if (recentContent.length < 100) return;

        const emb = await getEmbedder();
        const relevantMemories = await searchMemories(db, emb, recentContent, {
          limit: 5,
          minSimilarity: 0.4,
          minSalience: 0.05,
        });

        if (relevantMemories.length === 0) return;

        reinforceRetrievedMemories(db, relevantMemories, 0.1);

        const contextStr = formatMemoriesForContext(relevantMemories, 3000);

        output.context.push(
          "## Relevant Context from Past Sessions\n\n" +
            "The following memories from previous sessions may be relevant:\n\n" +
            contextStr,
        );

        const sessionSummary = messages
          .filter((m) => m.role === "user")
          .slice(-5)
          .map((m) => m.content.substring(0, 200))
          .join(" | ");

        if (sessionSummary.length > 100) {
          await createMemoryFromContent(sessionID, sessionSummary, {
            isUserMessage: true,
            hasCodeBlock: sessionSummary.includes("```"),
          });
        }

        db.updateSessionSummary(
          sessionID,
          `Session with ${messages.length} messages. Topics: ${relevantMemories.map((m) => m.memory.sector).join(", ")}`,
        );
      } catch {}
    },
  };
};

export default chatLogger;
