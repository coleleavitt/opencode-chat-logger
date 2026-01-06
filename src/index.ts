import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ChatLoggerDb, type Sector } from "./db";
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
  type ToastCallback,
} from "./embedding";
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
import { createWaypointsForMemory, traverseFromMemory } from "./graph";
import { extractEntitiesAndRelations } from "./entities";
import {
  runConsolidationPass,
  runTierPromotion,
  runSessionEndConsolidation,
  getConsolidationStats,
} from "./consolidation";
import { extractFactsWithContext, checkFactSupersession } from "./facts";
import { extractAssistantText, isSubstantiveAssistantText } from "./assistant-text";

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
  const pluginDirectory = input.directory;

  const sessionsDir = path.join(logDir, "sessions");
  const eventsDir = path.join(logDir, "events");

  const sessionMetadataCache = new Map<string, SessionMetadata>();

  // Track current session for hooks that don't receive sessionID
  let currentSessionID: string | null = null;

  let activeMemoryCreations = 0;
  const MAX_CONCURRENT_MEMORY_CREATIONS = 3;
  const memoryQueue: Array<() => Promise<void>> = [];

  const processMemoryQueue = async () => {
    while (memoryQueue.length > 0 && activeMemoryCreations < MAX_CONCURRENT_MEMORY_CREATIONS) {
      const task = memoryQueue.shift();
      if (task) {
        activeMemoryCreations++;
        task().finally(() => {
          activeMemoryCreations--;
          processMemoryQueue();
        });
      }
    }
  };

  const queueMemoryCreation = (fn: () => Promise<void>) => {
    memoryQueue.push(fn);
    processMemoryQueue();
  };

  const db = new ChatLoggerDb(logDir);

  const showToast: ToastCallback = (message: string) => {
    input.client?.tui?.showToast?.({
      body: {
        message,
        variant: "warning",
        duration: 5000,
      },
    });
  };

  const workerPath = path.join(
    path.dirname(import.meta.path),
    "embed-worker.ts",
  );

  let embedder: EmbeddingProvider | null = null;
  const getEmbedder = async (): Promise<EmbeddingProvider> => {
    if (!embedder) {
      embedder = await createEmbeddingProvider({
        toast: showToast,
        workerPath,
      });
    }
    return embedder;
  };

  const SKIP_PATTERNS = [
    /^\[BACKGROUND TASK/i,
    /^\[search-mode\]/i,
    /^\[analyze-mode\]/i,
    /^┌──\[/,
    /^└─[❯>]/,
    /^Thinking:/i,
    /^→\s*(Read|Edit|Write|Glob|Grep)/i,
  ];

  const NOISE_PATTERNS = [
    /\[BACKGROUND TASK COMPLETED\][^\n]*/g,
    /^Thinking:.*$/gm,
    /^→\s*(Read|Edit|Write|Glob|Grep)[^\n]*/gm,
    /┌──\[[^\]]+\]─[^\n]*/g,
    /└─[❯>][^\n]*/g,
    /```[\s\S]*?```/g,
    /\[search-mode\][\s\S]*?\[\/search-mode\]/gi,
    /\[analyze-mode\][\s\S]*?\[\/analyze-mode\]/gi,
  ];

  const shouldSkipContent = (text: string): boolean => {
    const trimmed = text.trim();
    if (trimmed.length < 20) return true;
    if (/^(continue|yes|no|ok|done|thanks|y|n)$/i.test(trimmed)) return true;
    return SKIP_PATTERNS.some((p) => p.test(trimmed));
  };

  const preprocessContent = (text: string): string => {
    let cleaned = text;
    for (const pattern of NOISE_PATTERNS) {
      cleaned = cleaned.replace(pattern, " ");
    }
    return cleaned.replace(/\s+/g, " ").trim();
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
    if (shouldSkipContent(content)) return null;

    const cleanedContent = preprocessContent(content);
    if (cleanedContent.length < 20) return null;

    const classification = classifySector(cleanedContent);
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
      content: cleanedContent.substring(0, 2000),
      sector: classification.sector,
      tier: "session",
      salience,
      decay_lambda: decayRate,
      valid_from: null,
      valid_to: null,
      is_consolidated: false,
      metadata_json: JSON.stringify({
        confidence: classification.confidence,
        secondarySectors: classification.secondarySectors,
      }),
    });

    try {
      const emb = await getEmbedder();
      const vector = await emb.embed(cleanedContent.substring(0, 1000));
      db.insertMemoryVector(memoryId, classification.sector, vector);

      await createWaypointsForMemory(db, memoryId);
    } catch {}

    try {
      const { entities, relations } = extractEntitiesAndRelations(content);
      const entityIds: string[] = [];
      const entityNameToId = new Map<string, string>();

      for (const entity of entities) {
        let existing = db.getEntityByName(entity.name, entity.type);
        
        if (!existing) {
          const entityId = crypto.randomUUID();
          db.upsertEntity({
            id: entityId,
            name: entity.name,
            type: entity.type,
            metadata_json: JSON.stringify({ confidence: entity.confidence }),
          });
          existing = db.getEntityByName(entity.name, entity.type);
        } else {
          db.upsertEntity({
            id: existing.id,
            name: entity.name,
            type: entity.type,
            metadata_json: JSON.stringify({ confidence: entity.confidence }),
          });
        }

        if (existing) {
          entityIds.push(existing.id);
          entityNameToId.set(entity.name.toLowerCase(), existing.id);
          db.insertEntityMention({
            entity_id: existing.id,
            memory_id: memoryId,
            session_id: sessionId,
            context: entity.context.substring(0, 500),
          });

          try {
            const emb = await getEmbedder();
            const contextVector = await emb.embed(
              entity.context.substring(0, 500),
            );
            db.insertEntityVector(
              existing.id,
              memoryId,
              contextVector,
              entity.context.substring(0, 200),
            );
          } catch {}
        }
      }

      for (let i = 0; i < entityIds.length; i++) {
        for (let j = i + 1; j < entityIds.length; j++) {
          db.upsertEntityCooccurrence(entityIds[i], entityIds[j], memoryId);
        }
      }

      for (const relation of relations) {
        const sourceId = entityNameToId.get(
          relation.sourceEntity.name.toLowerCase(),
        );
        const targetId = entityNameToId.get(
          relation.targetEntity.name.toLowerCase(),
        );

        if (sourceId && targetId && sourceId !== targetId) {
          db.upsertEntityRelation({
            source_entity_id: sourceId,
            target_entity_id: targetId,
            relation_type: relation.relationType,
            weight: relation.confidence,
          });
        }
      }

      const facts = extractFactsWithContext(content, classification.sector);
      for (const fact of facts) {
        const relatedFacts = db.findRelatedFacts(fact.content, fact.sector, 10);
        const supersession = checkFactSupersession(fact, relatedFacts);

        const newFactId = crypto.randomUUID();

        if (supersession.supersedes && supersession.oldFactId) {
          db.supersedeFact(
            supersession.oldFactId,
            newFactId,
            supersession.reason || "New fact supersedes old",
          );
        }

        db.insertFact({
          id: newFactId,
          memory_id: memoryId,
          session_id: sessionId,
          content: fact.content,
          sector: fact.sector,
          confidence: fact.confidence,
          valid_from: fact.validFrom,
          valid_to: fact.validTo,
        });
      }
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

      chat_log_semantic_search: tool({
        description:
          "Search memories using semantic similarity (vector-based). Returns memories ranked by composite score combining similarity, salience, recency, and associative links.",
        args: {
          query: tool.schema
            .string()
            .describe(
              "Natural language query to search for semantically similar memories",
            ),
          limit: tool.schema
            .number()
            .optional()
            .describe("Maximum results (default: 10)"),
          min_similarity: tool.schema
            .number()
            .optional()
            .describe("Minimum similarity threshold 0-1 (default: 0.3)"),
          sector: tool.schema
            .string()
            .optional()
            .describe(
              "Filter by sector: code_change, debugging, architecture, discussion, procedural",
            ),
        },
        async execute(args) {
          try {
            const emb = await getEmbedder();
            const sectors = args.sector ? [args.sector as Sector] : undefined;

            const results = await searchMemories(db, emb, args.query, {
              limit: args.limit || 10,
              minSimilarity: args.min_similarity || 0.3,
              sectors,
            });

            if (results.length === 0) {
              return `No memories found matching "${args.query}" (similarity threshold: ${args.min_similarity || 0.3})`;
            }

            let output = `## Semantic Search Results for "${args.query}"\n\n`;
            output += `Found ${results.length} relevant memories:\n\n`;

            for (const scored of results) {
              const m = scored.memory;
              output += `### [${m.sector}] Score: ${scored.compositeScore.toFixed(3)}\n`;
              output += `- **Similarity**: ${scored.similarity.toFixed(3)}\n`;
              output += `- **Salience**: ${scored.effectiveSalience.toFixed(3)} (base: ${m.salience.toFixed(3)})\n`;
              output += `- **Recency**: ${scored.recencyScore.toFixed(3)}\n`;
              output += `- **Waypoint Boost**: ${scored.waypointBoost.toFixed(3)}\n`;
              output += `- **Access Count**: ${m.access_count}\n`;
              output += `- **Last Accessed**: ${m.last_accessed}\n\n`;
              output += `> ${m.content.substring(0, 500)}${m.content.length > 500 ? "..." : ""}\n\n`;
              output += `---\n\n`;
            }

            return output;
          } catch (e) {
            return `Error in semantic search: ${e}`;
          }
        },
      }),

      // chat_log_memory_prune: tool({
      //   description:
      //     "Prune decayed memories below a salience threshold. Memories naturally decay based on their sector (architecture decays slowest, debugging fastest).",
      //   args: {
      //     threshold: tool.schema
      //       .number()
      //       .optional()
      //       .describe(
      //         "Salience threshold below which to prune (default: 0.01)",
      //       ),
      //     dry_run: tool.schema
      //       .boolean()
      //       .optional()
      //       .describe(
      //         "Preview what would be pruned without actually deleting (default: true)",
      //       ),
      //   },
      //   async execute(args) {
      //     const threshold = args.threshold || 0.01;
      //     const dryRun = args.dry_run !== false;
      //
      //     try {
      //       const allMemories = db.getAllMemoriesWithVectors();
      //       const toPrune: Array<{
      //         id: string;
      //         sector: Sector;
      //         salience: number;
      //         content: string;
      //       }> = [];
      //
      //       for (const memory of allMemories) {
      //         const effectiveSalience = db.getDecayedSalience(memory);
      //         if (effectiveSalience < threshold) {
      //           toPrune.push({
      //             id: memory.id,
      //             sector: memory.sector,
      //             salience: effectiveSalience,
      //             content: memory.content.substring(0, 100),
      //           });
      //         }
      //       }
      //
      //       if (toPrune.length === 0) {
      //         return `No memories below threshold ${threshold}. All ${allMemories.length} memories are above the salience threshold.`;
      //       }
      //
      //       let output = `## Memory Pruning ${dryRun ? "(DRY RUN)" : ""}\n\n`;
      //       output += `Found ${toPrune.length} memories below salience threshold ${threshold}:\n\n`;
      //
      //       const bySector = new Map<Sector, number>();
      //       for (const m of toPrune) {
      //         bySector.set(m.sector, (bySector.get(m.sector) || 0) + 1);
      //       }
      //
      //       output += `### By Sector:\n`;
      //       for (const [sector, count] of bySector) {
      //         output += `- ${sector}: ${count}\n`;
      //       }
      //       output += `\n`;
      //
      //       if (!dryRun) {
      //         const pruned = db.pruneDecayedMemories(threshold);
      //         output += `**Pruned ${pruned} memories.**\n`;
      //       } else {
      //         output += `_Run with dry_run=false to actually prune these memories._\n\n`;
      //         output += `### Preview (first 10):\n`;
      //         for (const m of toPrune.slice(0, 10)) {
      //           output += `- [${m.sector}] salience=${m.salience.toFixed(4)}: ${m.content}...\n`;
      //         }
      //       }
      //
      //       return output;
      //     } catch (e) {
      //       return `Error pruning memories: ${e}`;
      //     }
      //   },
      // }),

      chat_log_related_memories: tool({
        description:
          "Explore the memory graph by finding memories related to a given memory through waypoint links.",
        args: {
          memory_id: tool.schema
            .string()
            .describe("Memory ID to find related memories for"),
          depth: tool.schema
            .number()
            .optional()
            .describe("Maximum traversal depth (default: 2)"),
          limit: tool.schema
            .number()
            .optional()
            .describe("Maximum related memories to return (default: 10)"),
        },
        async execute(args) {
          try {
            const memory = db.getMemory(args.memory_id);
            if (!memory) {
              return `Memory ${args.memory_id} not found.`;
            }

            const graph = traverseFromMemory(
              db,
              args.memory_id,
              args.depth || 2,
              (args.limit || 10) + 1,
            );

            let output = `## Related Memories for [${memory.sector}]\n\n`;
            output += `**Source Memory**: ${memory.content.substring(0, 200)}...\n\n`;
            output += `Found ${graph.nodes.length - 1} related memories across ${graph.edges.length} links:\n\n`;

            const byDepth = new Map<number, typeof graph.nodes>();
            for (const node of graph.nodes) {
              if (node.id === args.memory_id) continue;
              const existing = byDepth.get(node.depth) || [];
              existing.push(node);
              byDepth.set(node.depth, existing);
            }

            for (const [depth, nodes] of [...byDepth.entries()].sort(
              (a, b) => a[0] - b[0],
            )) {
              output += `### Depth ${depth} (${nodes.length} memories)\n\n`;
              for (const node of nodes) {
                const m = node.memory;
                output += `- **[${m.sector}]** (id: ${m.id.substring(0, 8)}...)\n`;
                output += `  > ${m.content.substring(0, 150)}...\n\n`;
              }
            }

            return output;
          } catch (e) {
            return `Error finding related memories: ${e}`;
          }
        },
      }),

      chat_log_entities: tool({
        description:
          "Search and list extracted entities (files, classes, functions, concepts) from past sessions.",
        args: {
          query: tool.schema
            .string()
            .optional()
            .describe("Search query for entity names"),
          type: tool.schema
            .string()
            .optional()
            .describe(
              "Filter by entity type: file, class, function, variable, project, person, concept, tool, error",
            ),
          limit: tool.schema
            .number()
            .optional()
            .describe("Maximum results (default: 50)"),
        },
        async execute(args) {
          const limit = args.limit || 50;

          if (args.query) {
            const results = db.searchEntities(args.query, limit);
            if (results.length === 0) {
              return `No entities found matching "${args.query}"`;
            }

            let output = `## Entities matching "${args.query}"\n\n`;
            for (const entity of results) {
              output += `- **${entity.name}** [${entity.type}]\n`;
              output += `  - Mentions: ${entity.mention_count}\n`;
              output += `  - First seen: ${entity.first_seen}\n`;
              output += `  - Last seen: ${entity.last_seen}\n\n`;
            }
            return output;
          }

          const entities = db.getTopEntities(
            limit,
            args.type as import("./db").EntityType | undefined,
          );
          if (entities.length === 0) {
            return "No entities found in the database.";
          }

          let output = `## Top ${entities.length} Entities${args.type ? ` (type: ${args.type})` : ""}\n\n`;
          for (const entity of entities) {
            output += `- **${entity.name}** [${entity.type}] - ${entity.mention_count} mentions\n`;
          }
          return output;
        },
      }),

      chat_log_related_entities: tool({
        description:
          "Find entities related to a given entity through co-occurrence (appearing together in memories) and semantic similarity.",
        args: {
          entity_name: tool.schema
            .string()
            .describe("Name of the entity to find relations for"),
          entity_type: tool.schema
            .string()
            .optional()
            .describe(
              "Entity type to disambiguate (file, class, function, concept, tool, project)",
            ),
          limit: tool.schema
            .number()
            .optional()
            .describe("Maximum related entities to return (default: 20)"),
          min_cooccurrence: tool.schema
            .number()
            .optional()
            .describe("Minimum co-occurrence count (default: 1)"),
        },
        async execute(args) {
          const entity = db.getEntityByName(
            args.entity_name,
            args.entity_type as import("./db").EntityType | undefined,
          );

          if (!entity) {
            const suggestions = db.searchEntities(args.entity_name, 5);
            if (suggestions.length > 0) {
              return `Entity "${args.entity_name}" not found. Did you mean:\n${suggestions.map((s) => `- ${s.name} [${s.type}]`).join("\n")}`;
            }
            return `Entity "${args.entity_name}" not found.`;
          }

          const related = db.findRelatedEntities(entity.id, {
            limit: args.limit || 20,
            minCooccurrence: args.min_cooccurrence || 1,
          });

          if (related.length === 0) {
            return `No related entities found for "${entity.name}" [${entity.type}]. This entity may not have appeared alongside others in memories yet.`;
          }

          let output = `## Entities Related to "${entity.name}" [${entity.type}]\n\n`;
          output += `Found ${related.length} related entities:\n\n`;

          for (const r of related) {
            output += `### ${r.entity.name} [${r.entity.type}]\n`;
            output += `- **Co-occurrences**: ${r.cooccurrenceCount}\n`;
            output += `- **Composite Score**: ${r.compositeScore.toFixed(3)}\n`;
            output += `- **Co-occurrence Score**: ${r.cooccurrenceScore.toFixed(3)}\n`;
            if (r.vectorSimilarity > 0) {
              output += `- **Context Similarity**: ${r.vectorSimilarity.toFixed(3)}\n`;
            }
            output += `- **Mentions**: ${r.entity.mention_count}\n\n`;
          }

          return output;
        },
      }),

      chat_log_timeline: tool({
        description:
          "Query memories by time range. Useful for 'what happened last week' queries.",
        args: {
          start_date: tool.schema
            .string()
            .describe("Start date (ISO format, e.g., 2024-01-01)"),
          end_date: tool.schema
            .string()
            .optional()
            .describe("End date (ISO format, defaults to now)"),
          sector: tool.schema
            .string()
            .optional()
            .describe(
              "Filter by sector: code_change, debugging, architecture, discussion, procedural, emotional",
            ),
          directory: tool.schema
            .string()
            .optional()
            .describe("Filter by project directory"),
          limit: tool.schema
            .number()
            .optional()
            .describe("Maximum results (default: 50)"),
        },
        async execute(args) {
          const endDate = args.end_date || new Date().toISOString();
          const memories = db.getMemoriesByTimeRange(args.start_date, endDate, {
            sector: args.sector as import("./db").Sector | undefined,
            directory: args.directory,
            limit: args.limit || 50,
          });

          if (memories.length === 0) {
            return `No memories found between ${args.start_date} and ${endDate}`;
          }

          let output = `## Timeline: ${args.start_date} to ${endDate.substring(0, 10)}\n\n`;
          output += `Found ${memories.length} memories:\n\n`;

          const bySector = new Map<string, number>();
          for (const m of memories) {
            bySector.set(m.sector, (bySector.get(m.sector) || 0) + 1);
          }

          output += `### By Sector\n`;
          for (const [sector, count] of bySector) {
            output += `- ${sector}: ${count}\n`;
          }
          output += `\n### Memories\n\n`;

          for (const m of memories.slice(0, 20)) {
            output += `#### [${m.sector}] ${m.created_at}\n`;
            output += `> ${m.content.substring(0, 300)}${m.content.length > 300 ? "..." : ""}\n\n`;
          }

          if (memories.length > 20) {
            output += `\n_...and ${memories.length - 20} more memories_`;
          }

          return output;
        },
      }),

      chat_log_facts: tool({
        description:
          "Search extracted facts from conversations. Facts are discrete pieces of knowledge.",
        args: {
          query: tool.schema
            .string()
            .optional()
            .describe("Search query for facts"),
          current_only: tool.schema
            .boolean()
            .optional()
            .describe(
              "Only show current (not superseded) facts (default: true)",
            ),
          limit: tool.schema
            .number()
            .optional()
            .describe("Maximum results (default: 50)"),
        },
        async execute(args) {
          const limit = args.limit || 50;

          if (args.query) {
            const results = db.searchFacts(args.query, limit);
            if (results.length === 0) {
              return `No facts found matching "${args.query}"`;
            }

            let output = `## Facts matching "${args.query}"\n\n`;
            for (const fact of results) {
              const status = fact.is_current ? "current" : "superseded";
              output += `### [${fact.sector}] (${status})\n`;
              output += `${fact.content}\n`;
              output += `- Confidence: ${(fact.confidence * 100).toFixed(0)}%\n`;
              output += `- Created: ${fact.created_at}\n`;
              if (fact.valid_from || fact.valid_to) {
                output += `- Valid: ${fact.valid_from || "?"} to ${fact.valid_to || "present"}\n`;
              }
              output += `\n`;
            }
            return output;
          }

          const facts = db.getCurrentFacts(undefined, limit);
          if (facts.length === 0) {
            return "No facts stored yet.";
          }

          let output = `## Current Facts (${facts.length})\n\n`;
          for (const fact of facts) {
            output += `- **[${fact.sector}]** ${fact.content.substring(0, 200)}${fact.content.length > 200 ? "..." : ""}\n`;
          }
          return output;
        },
      }),

      chat_log_extended_stats: tool({
        description:
          "Get extended statistics including entities, facts, and consolidation info.",
        args: {},
        async execute() {
          const stats = db.getExtendedStats();
          const dbPath = path.join(logDir, "chat-logs.db");
          const dbSize = fs.existsSync(dbPath)
            ? (fs.statSync(dbPath).size / 1024 / 1024).toFixed(2) + " MB"
            : "unknown";

          return (
            `## Extended Chat Log Statistics\n\n` +
            `### Core\n` +
            `- **Sessions**: ${stats.sessions}\n` +
            `- **Messages**: ${stats.messages}\n` +
            `- **Tool Calls**: ${stats.toolCalls}\n\n` +
            `### Memory System\n` +
            `- **Memories**: ${stats.memories}\n` +
            `- **Waypoints**: ${stats.waypoints}\n\n` +
            `### Advanced Features\n` +
            `- **Entities**: ${stats.entities}\n` +
            `- **Entity Co-occurrences**: ${stats.entityCooccurrences}\n` +
            `- **Entity Relations**: ${stats.entityRelations}\n` +
            `- **Facts**: ${stats.facts}\n` +
            `- **Consolidations**: ${stats.consolidations}\n\n` +
            `### Storage\n` +
            `- **Database Size**: ${dbSize}\n` +
            `- **Log Directory**: ${logDir}\n`
          );
        },
      }),

      chat_log_consolidate: tool({
        description:
          "Manually trigger memory consolidation and tier promotion. Merges similar memories and promotes frequently-accessed memories to higher tiers.",
        args: {
          max_merges: tool.schema
            .number()
            .optional()
            .describe("Maximum memory pairs to merge (default: 20)"),
          max_promotions: tool.schema
            .number()
            .optional()
            .describe("Maximum memories to promote (default: 20)"),
          dry_run: tool.schema
            .boolean()
            .optional()
            .describe(
              "Preview what would happen without making changes (default: false)",
            ),
        },
        async execute(args) {
          const maxMerges = args.max_merges || 20;
          const maxPromotions = args.max_promotions || 20;
          const dryRun = args.dry_run || false;

          const stats = getConsolidationStats(db);

          let output = `## Memory Consolidation${dryRun ? " (DRY RUN)" : ""}\n\n`;
          output += `### Current State\n`;
          output += `- Unconsolidated memories: ${stats.unconsolidated}\n`;
          output += `- Potential merge pairs: ${stats.potentialMerges}\n`;
          output += `- Previous consolidations: ${stats.consolidated}\n\n`;

          const sessionCandidates = db.getPromotionCandidates(
            "session",
            3,
            0.4,
            50,
          );
          const projectCandidates = db.getPromotionCandidates(
            "project",
            5,
            0.6,
            50,
          );

          output += `### Promotion Candidates\n`;
          output += `- Session → Project: ${sessionCandidates.length} candidates\n`;
          output += `- Project → Personal: ${projectCandidates.length} candidates\n\n`;

          if (dryRun) {
            output += `### Preview (no changes made)\n`;
            output += `Would merge up to ${Math.min(maxMerges, stats.potentialMerges)} similar memory pairs.\n`;
            output += `Would promote up to ${Math.min(maxPromotions, sessionCandidates.length + projectCandidates.length)} memories.\n\n`;

            if (sessionCandidates.length > 0) {
              output += `#### Top Session → Project Candidates:\n`;
              for (const m of sessionCandidates.slice(0, 5)) {
                output += `- [${m.sector}] access=${m.access_count}, salience=${m.salience.toFixed(2)}\n`;
                output += `  > ${m.content.substring(0, 100)}...\n`;
              }
            }
          } else {
            const mergeResult = runConsolidationPass(db, maxMerges);
            const promotionResult = runTierPromotion(db, maxPromotions);

            output += `### Results\n`;
            output += `- **Memories merged**: ${mergeResult.merged}\n`;
            output += `- **Session → Project promotions**: ${promotionResult.sessionToProject}\n`;
            output += `- **Project → Personal promotions**: ${promotionResult.projectToPersonal}\n`;
          }

          return output;
        },
      }),

      chat_log_memories_by_tier: tool({
        description:
          "List memories grouped by tier (session, project, personal). Useful for understanding memory distribution.",
        args: {
          tier: tool.schema
            .string()
            .optional()
            .describe(
              "Filter by tier: session, project, personal (default: all)",
            ),
          limit: tool.schema
            .number()
            .optional()
            .describe("Maximum memories per tier (default: 20)"),
        },
        async execute(args) {
          const limit = args.limit || 20;

          if (args.tier) {
            const memories = db.getMemoriesByTier(
              args.tier as "session" | "project" | "personal",
              limit,
            );
            let output = `## ${args.tier.charAt(0).toUpperCase() + args.tier.slice(1)} Tier Memories (${memories.length})\n\n`;

            for (const m of memories) {
              output += `### [${m.sector}] salience=${m.salience.toFixed(2)}, access=${m.access_count}\n`;
              output += `> ${m.content.substring(0, 300)}${m.content.length > 300 ? "..." : ""}\n\n`;
            }

            return output;
          }

          const sessionMemories = db.getMemoriesByTier("session", limit);
          const projectMemories = db.getMemoriesByTier("project", limit);
          const personalMemories = db.getMemoriesByTier("personal", limit);

          let output = `## Memories by Tier\n\n`;
          output += `### Summary\n`;
          output += `- Session: ${sessionMemories.length}${sessionMemories.length >= limit ? "+" : ""}\n`;
          output += `- Project: ${projectMemories.length}${projectMemories.length >= limit ? "+" : ""}\n`;
          output += `- Personal: ${personalMemories.length}${personalMemories.length >= limit ? "+" : ""}\n\n`;

          if (personalMemories.length > 0) {
            output += `### Personal Tier (highest priority)\n`;
            for (const m of personalMemories.slice(0, 5)) {
              output += `- [${m.sector}] ${m.content.substring(0, 150)}...\n`;
            }
            output += `\n`;
          }

          if (projectMemories.length > 0) {
            output += `### Project Tier\n`;
            for (const m of projectMemories.slice(0, 5)) {
              output += `- [${m.sector}] ${m.content.substring(0, 150)}...\n`;
            }
            output += `\n`;
          }

          output += `_Use tier="session|project|personal" to see full list for a specific tier._`;

          return output;
        },
      }),
    },

    config: async (cfg) => {
      const projectSessions = db.listSessions({
        directory: input.directory,
        limit: 10,
      });

      const personalMemories = db.getPersonalMemories(5);
      const projectMemories = db.getProjectMemories(input.directory, 5);
      const currentFacts = db.getCurrentFacts(undefined, 10);

      let memoryContext = "\n[Recalled Memory Context]\n";

      if (personalMemories.length > 0) {
        memoryContext += "\n## User Preferences & Cross-Project Knowledge\n";
        for (const m of personalMemories) {
          memoryContext += `- ${m.content.substring(0, 200)}${m.content.length > 200 ? "..." : ""}\n`;
        }
      }

      if (projectMemories.length > 0) {
        memoryContext += "\n## This Project's Context\n";
        for (const m of projectMemories) {
          memoryContext += `- [${m.sector}] ${m.content.substring(0, 200)}${m.content.length > 200 ? "..." : ""}\n`;
        }
      }

      if (currentFacts.length > 0) {
        memoryContext += "\n## Known Facts\n";
        for (const f of currentFacts) {
          memoryContext += `- ${f.content.substring(0, 150)}\n`;
        }
      }

      const totalMessages = projectSessions.reduce(
        (sum, s) => sum + s.message_count,
        0,
      );
      const lastSession = projectSessions[0];
      const lastDate = lastSession?.updated_at
        ? new Date(lastSession.updated_at).toLocaleDateString()
        : "unknown";

      if (projectSessions.length > 0) {
        memoryContext += `\n## Session History\n`;
        memoryContext += `${projectSessions.length} past session(s) in this project (${totalMessages} messages).\n`;
        memoryContext += `Most recent: "${lastSession?.title || "untitled"}" on ${lastDate}.\n`;
      }

      memoryContext += `\n## Memory Tools Available\n`;
      memoryContext += `- \`chat_log_semantic_search query="..."\` - Find relevant memories by meaning\n`;
      memoryContext += `- \`chat_log_related_entities entity_name="..."\` - Discover entity relationships\n`;
      memoryContext += `- \`chat_log_context topic="..."\` - Get context from past sessions\n`;

      const hasContent =
        personalMemories.length > 0 ||
        projectMemories.length > 0 ||
        currentFacts.length > 0 ||
        projectSessions.length > 0;

      if (!hasContent) return;

      type AgentConfig = { prompt?: string };
      const agents = cfg.agent as Record<string, AgentConfig> | undefined;

      if (agents) {
        for (const agentName of Object.keys(agents)) {
          const agent = agents[agentName];
          if (agent && typeof agent.prompt === "string") {
            agent.prompt = agent.prompt + memoryContext;
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

      currentSessionID = sessionID;

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

      db.upsertSession({
        id: sessionID,
        directory: pluginDirectory,
        last_agent: agent,
        last_model: modelStr,
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
      db.incrementMessageCount(sessionID);

      const role = message.role as string;
      if (role === "user" && contentStr.trim().length >= 3) {
        const toolCount = parts.filter((p) => p.type === "tool").length;
        queueMemoryCreation(() =>
          createMemoryFromContent(sessionID, contentStr, {
            isUserMessage: true,
            hasCodeBlock: contentStr.includes("```"),
            toolCount,
          }).then(() => {})
        );
      } else if (role === "assistant") {
        const assistantText = extractAssistantText(parts);
        if (isSubstantiveAssistantText(assistantText)) {
          queueMemoryCreation(() =>
            createMemoryFromContent(sessionID, assistantText, {
              isUserMessage: false,
              hasCodeBlock: false,
              toolCount: parts.filter((p) => p.type === "tool").length,
            }).then(() => {})
          );
        }
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
          queueMemoryCreation(() =>
            createMemoryFromContent(sessionID, sessionSummary, {
              isUserMessage: true,
              hasCodeBlock: sessionSummary.includes("```"),
            }).then(() => {})
          );
        }

        db.updateSessionSummary(
          sessionID,
          `Session with ${messages.length} messages. Topics: ${relevantMemories.map((m) => m.memory.sector).join(", ")}`,
        );

        runSessionEndConsolidation(db);
      } catch {}
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      const seenMessageIds = new Set<string>();
      
      for (const msg of output.messages) {
        if (msg.info.role !== "assistant") continue;
        if (seenMessageIds.has(msg.info.id)) continue;
        
        seenMessageIds.add(msg.info.id);
        
        const sessionID = (msg.info as { sessionID?: string }).sessionID;
        if (!sessionID) continue;
        
        const existingMsg = db.getMessage(msg.info.id);
        if (existingMsg) continue;
        
        const textParts = msg.parts.filter((p: { type: string }) => p.type === "text");
        const contentStr = textParts
          .map((p) => (p as { text?: string }).text || "")
          .join("\n");
        
        if (contentStr.trim().length < 10) continue;
        
        db.insertMessage({
          id: msg.info.id,
          session_id: sessionID,
          role: "assistant",
          content: contentStr,
          agent: null,
          model: null,
          parts_json: JSON.stringify(msg.parts),
          embedding: null,
        });
        
        const assistantText = extractAssistantText(msg.parts as Array<{ type: string; text?: string }>);
        if (isSubstantiveAssistantText(assistantText)) {
          queueMemoryCreation(() =>
            createMemoryFromContent(sessionID, assistantText, {
              isUserMessage: false,
              hasCodeBlock: false,
              toolCount: msg.parts.filter((p: { type: string }) => p.type === "tool-invocation").length,
            }).then(() => {})
          );
        }
      }
    },

    "experimental.chat.system.transform": async (_input, output) => {
      if (!currentSessionID) return;

      try {
        const session = db.getSession(currentSessionID);
        if (!session) return;

        const messages = db.getSessionMessages(currentSessionID);
        const recentContent = messages
          .slice(-5)
          .map((m) => m.content)
          .join("\n");

        if (recentContent.length < 50) return;

        const emb = await getEmbedder();
        const relevantMemories = await searchMemories(db, emb, recentContent, {
          limit: 5,
          minSimilarity: 0.35,
          minSalience: 0.03,
        });

        if (relevantMemories.length === 0) return;

        reinforceRetrievedMemories(db, relevantMemories, 0.05);

        const contextStr = formatMemoriesForContext(relevantMemories, 2000);

        output.system.push(
          "[Recalled Memory Context]\n\n" + contextStr,
        );
      } catch {}
    },
  };
};

export default chatLogger;
