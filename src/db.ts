import { Database } from "bun:sqlite";
import * as path from "path";
import * as fs from "fs";

export type Sector =
  | "code_change"
  | "debugging"
  | "architecture"
  | "discussion"
  | "procedural"
  | "emotional";

export type EntityType =
  | "file"
  | "class"
  | "function"
  | "variable"
  | "project"
  | "person"
  | "concept"
  | "tool"
  | "error"
  | "other";

export type MemoryTier = "session" | "project" | "personal";

export const SECTOR_DECAY_RATES: Record<Sector, number> = {
  code_change: 0.01,
  debugging: 0.025,
  architecture: 0.003,
  discussion: 0.02,
  procedural: 0.005,
  emotional: 0.03,
};

export interface DbSession {
  id: string;
  directory: string | null;
  project_id: string | null;
  title: string | null;
  version: string | null;
  created_at: string;
  updated_at: string;
  last_agent: string | null;
  last_model: string | null;
  message_count: number;
  summary: string | null;
}

export interface DbMessage {
  id: string;
  session_id: string;
  role: string;
  content: string;
  agent: string | null;
  model: string | null;
  parts_json: string | null;
  embedding: Uint8Array | null;
  created_at: string;
}

export interface DbToolCall {
  id: string;
  session_id: string;
  call_id: string;
  tool: string;
  phase: "before" | "after";
  args_json: string | null;
  output: string | null;
  title: string | null;
  metadata_json: string | null;
  created_at: string;
}

export interface DbMemory {
  id: string;
  session_id: string;
  content: string;
  sector: Sector;
  tier: MemoryTier;
  salience: number;
  decay_lambda: number;
  access_count: number;
  last_accessed: string;
  created_at: string;
  valid_from: string | null;
  valid_to: string | null;
  is_consolidated: boolean;
  metadata_json: string | null;
}

export interface DbMemoryVector {
  id: number;
  memory_id: string;
  sector: Sector;
  vector: Uint8Array;
  dimension: number;
}

export interface DbWaypoint {
  id: number;
  src_memory_id: string;
  dst_memory_id: string;
  weight: number;
  created_at: string;
}

export interface DbEntity {
  id: string;
  name: string;
  type: EntityType;
  first_seen: string;
  last_seen: string;
  mention_count: number;
  metadata_json: string | null;
}

export interface DbEntityMention {
  id: number;
  entity_id: string;
  memory_id: string | null;
  session_id: string;
  context: string;
  created_at: string;
}

export interface DbEntityRelation {
  id: number;
  source_entity_id: string;
  target_entity_id: string;
  relation_type: string;
  weight: number;
  first_seen: string;
  last_seen: string;
  mention_count: number;
}

export interface DbFact {
  id: string;
  memory_id: string | null;
  session_id: string;
  content: string;
  sector: Sector;
  confidence: number;
  valid_from: string | null;
  valid_to: string | null;
  is_current: boolean;
  created_at: string;
  metadata_json: string | null;
}

export interface DbConsolidationLog {
  id: number;
  action: "merge" | "update" | "delete" | "create";
  source_ids: string;
  result_id: string | null;
  reason: string;
  created_at: string;
}

export interface FtsSearchResult {
  message_id: string;
  session_id: string;
  role: string;
  content: string;
  snippet: string;
  rank: number;
  session_title: string | null;
  session_directory: string | null;
  session_created_at: string;
}

export interface MemorySearchResult {
  memory: DbMemory;
  similarity: number;
  composite_score: number;
  waypoint_boost: number;
}

export class ChatLoggerDb {
  db: Database;

  constructor(logDir: string) {
    const dbPath = path.join(logDir, "chat-logs.db");

    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.initSchema();
    this.runMigrations();
  }

  private runMigrations(): void {
    const sessionCols = this.db
      .prepare("PRAGMA table_info(sessions)")
      .all() as Array<{ name: string }>;
    const hasSessionCol = (name: string) =>
      sessionCols.some((c) => c.name === name);

    if (!hasSessionCol("summary")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN summary TEXT");
    }

    const memoryCols = this.db
      .prepare("PRAGMA table_info(memories)")
      .all() as Array<{ name: string }>;
    const hasMemoryCol = (name: string) =>
      memoryCols.some((c) => c.name === name);

    if (!hasMemoryCol("tier")) {
      this.db.exec(
        "ALTER TABLE memories ADD COLUMN tier TEXT DEFAULT 'session'",
      );
    }
    if (!hasMemoryCol("valid_from")) {
      this.db.exec("ALTER TABLE memories ADD COLUMN valid_from TEXT");
    }
    if (!hasMemoryCol("valid_to")) {
      this.db.exec("ALTER TABLE memories ADD COLUMN valid_to TEXT");
    }
    if (!hasMemoryCol("is_consolidated")) {
      this.db.exec(
        "ALTER TABLE memories ADD COLUMN is_consolidated INTEGER DEFAULT 0",
      );
    }
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        directory TEXT,
        project_id TEXT,
        title TEXT,
        version TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_agent TEXT,
        last_model TEXT,
        message_count INTEGER DEFAULT 0,
        summary TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_directory ON sessions(directory);
      CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        agent TEXT,
        model TEXT,
        parts_json TEXT,
        embedding BLOB,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(role);

      CREATE TABLE IF NOT EXISTS tool_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        call_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('before', 'after')),
        args_json TEXT,
        output TEXT,
        title TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_tool_calls_session_id ON tool_calls(session_id);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_tool ON tool_calls(tool);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_call_id ON tool_calls(call_id);

      -- Memory system tables
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        content TEXT NOT NULL,
        sector TEXT NOT NULL CHECK (sector IN ('code_change', 'debugging', 'architecture', 'discussion', 'procedural', 'emotional')),
        tier TEXT NOT NULL DEFAULT 'session' CHECK (tier IN ('session', 'project', 'personal')),
        salience REAL NOT NULL DEFAULT 0.5,
        decay_lambda REAL NOT NULL DEFAULT 0.01,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed TEXT NOT NULL DEFAULT (datetime('now')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        valid_from TEXT,
        valid_to TEXT,
        is_consolidated INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_memories_session_id ON memories(session_id);
      CREATE INDEX IF NOT EXISTS idx_memories_sector ON memories(sector);
      CREATE INDEX IF NOT EXISTS idx_memories_salience ON memories(salience);
      CREATE INDEX IF NOT EXISTS idx_memories_last_accessed ON memories(last_accessed);

      CREATE TABLE IF NOT EXISTS memory_vectors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id TEXT NOT NULL,
        sector TEXT NOT NULL,
        vector BLOB NOT NULL,
        dimension INTEGER NOT NULL,
        FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_memory_vectors_memory_id ON memory_vectors(memory_id);
      CREATE INDEX IF NOT EXISTS idx_memory_vectors_sector ON memory_vectors(sector);

      CREATE TABLE IF NOT EXISTS waypoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        src_memory_id TEXT NOT NULL,
        dst_memory_id TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1.0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (src_memory_id) REFERENCES memories(id) ON DELETE CASCADE,
        FOREIGN KEY (dst_memory_id) REFERENCES memories(id) ON DELETE CASCADE,
        UNIQUE(src_memory_id, dst_memory_id)
      );

      CREATE INDEX IF NOT EXISTS idx_waypoints_src ON waypoints(src_memory_id);
      CREATE INDEX IF NOT EXISTS idx_waypoints_dst ON waypoints(dst_memory_id);

      -- FTS for messages
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        content_rowid='rowid',
        tokenize='porter unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', OLD.rowid, OLD.content);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', OLD.rowid, OLD.content);
        INSERT INTO messages_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
      END;

      -- FTS for memories
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content,
        content_rowid='rowid',
        tokenize='porter unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', OLD.rowid, OLD.content);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', OLD.rowid, OLD.content);
        INSERT INTO memories_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
      END;

      -- Entity system tables
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('file', 'class', 'function', 'variable', 'project', 'person', 'concept', 'tool', 'error', 'other')),
        first_seen TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen TEXT NOT NULL DEFAULT (datetime('now')),
        mention_count INTEGER NOT NULL DEFAULT 1,
        metadata_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
      CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_name_type ON entities(name, type);

      CREATE TABLE IF NOT EXISTS entity_mentions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id TEXT NOT NULL,
        memory_id TEXT,
        session_id TEXT NOT NULL,
        context TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE,
        FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE SET NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_entity_mentions_entity ON entity_mentions(entity_id);
      CREATE INDEX IF NOT EXISTS idx_entity_mentions_session ON entity_mentions(session_id);

      CREATE TABLE IF NOT EXISTS entity_relations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_entity_id TEXT NOT NULL,
        target_entity_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1.0,
        first_seen TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen TEXT NOT NULL DEFAULT (datetime('now')),
        mention_count INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY (source_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
        FOREIGN KEY (target_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
        UNIQUE(source_entity_id, target_entity_id, relation_type)
      );

      CREATE INDEX IF NOT EXISTS idx_entity_relations_source ON entity_relations(source_entity_id);
      CREATE INDEX IF NOT EXISTS idx_entity_relations_target ON entity_relations(target_entity_id);

      -- Facts table for extracted knowledge
      CREATE TABLE IF NOT EXISTS facts (
        id TEXT PRIMARY KEY,
        memory_id TEXT,
        session_id TEXT NOT NULL,
        content TEXT NOT NULL,
        sector TEXT NOT NULL CHECK (sector IN ('code_change', 'debugging', 'architecture', 'discussion', 'procedural', 'emotional')),
        confidence REAL NOT NULL DEFAULT 0.8,
        valid_from TEXT,
        valid_to TEXT,
        is_current INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        metadata_json TEXT,
        FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE SET NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_facts_session ON facts(session_id);
      CREATE INDEX IF NOT EXISTS idx_facts_is_current ON facts(is_current);
      CREATE INDEX IF NOT EXISTS idx_facts_sector ON facts(sector);

      -- FTS for facts
      CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
        content,
        content_rowid='rowid',
        tokenize='porter unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
        INSERT INTO facts_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
      END;

      CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
        INSERT INTO facts_fts(facts_fts, rowid, content) VALUES ('delete', OLD.rowid, OLD.content);
      END;

      -- FTS for entities
      CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
        name,
        content_rowid='rowid',
        tokenize='porter unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS entities_ai AFTER INSERT ON entities BEGIN
        INSERT INTO entities_fts(rowid, name) VALUES (NEW.rowid, NEW.name);
      END;

      CREATE TRIGGER IF NOT EXISTS entities_ad AFTER DELETE ON entities BEGIN
        INSERT INTO entities_fts(entities_fts, rowid, name) VALUES ('delete', OLD.rowid, OLD.name);
      END;

      -- Consolidation log
      CREATE TABLE IF NOT EXISTS consolidation_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL CHECK (action IN ('merge', 'update', 'delete', 'create')),
        source_ids TEXT NOT NULL,
        result_id TEXT,
        reason TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_consolidation_created ON consolidation_log(created_at);
    `);
  }

  upsertSession(session: Partial<DbSession> & { id: string }): void {
    const stmt = this.db.prepare(`
      INSERT INTO sessions (id, directory, project_id, title, version, last_agent, last_model, message_count, summary, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        directory = COALESCE(excluded.directory, directory),
        project_id = COALESCE(excluded.project_id, project_id),
        title = COALESCE(excluded.title, title),
        version = COALESCE(excluded.version, version),
        last_agent = COALESCE(excluded.last_agent, last_agent),
        last_model = COALESCE(excluded.last_model, last_model),
        message_count = COALESCE(excluded.message_count, message_count),
        summary = COALESCE(excluded.summary, summary),
        updated_at = datetime('now')
    `);

    stmt.run(
      String(session.id || ""),
      session.directory ? String(session.directory) : null,
      session.project_id ? String(session.project_id) : null,
      session.title ? String(session.title) : null,
      session.version ? String(session.version) : null,
      session.last_agent ? String(session.last_agent) : null,
      session.last_model ? String(session.last_model) : null,
      typeof session.message_count === "number" ? session.message_count : 0,
      session.summary ? String(session.summary) : null,
    );
  }

  incrementMessageCount(sessionId: string): void {
    const stmt = this.db.prepare(`
      UPDATE sessions SET message_count = message_count + 1, updated_at = datetime('now') WHERE id = ?
    `);
    stmt.run(sessionId);
  }

  insertMessage(message: Omit<DbMessage, "created_at">): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO messages (id, session_id, role, content, agent, model, parts_json, embedding, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    stmt.run(
      String(message.id || ""),
      String(message.session_id || ""),
      String(message.role || "unknown"),
      String(message.content || ""),
      message.agent ? String(message.agent) : null,
      message.model ? String(message.model) : null,
      message.parts_json ? String(message.parts_json) : null,
      message.embedding ?? null,
    );
  }

  insertToolCall(toolCall: Omit<DbToolCall, "id" | "created_at">): void {
    const stmt = this.db.prepare(`
      INSERT INTO tool_calls (session_id, call_id, tool, phase, args_json, output, title, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    stmt.run(
      String(toolCall.session_id || ""),
      String(toolCall.call_id || ""),
      String(toolCall.tool || ""),
      String(toolCall.phase || "before"),
      toolCall.args_json ? String(toolCall.args_json) : null,
      toolCall.output ? String(toolCall.output) : null,
      toolCall.title ? String(toolCall.title) : null,
      toolCall.metadata_json ? String(toolCall.metadata_json) : null,
    );
  }

  insertMemory(
    memory: Omit<DbMemory, "access_count" | "last_accessed" | "created_at">,
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO memories (id, session_id, content, sector, tier, salience, decay_lambda, valid_from, valid_to, is_consolidated, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      memory.id,
      memory.session_id,
      memory.content,
      memory.sector,
      memory.tier,
      memory.salience,
      memory.decay_lambda,
      memory.valid_from,
      memory.valid_to,
      memory.is_consolidated ? 1 : 0,
      memory.metadata_json,
    );
  }

  insertMemoryVector(
    memoryId: string,
    sector: Sector,
    vector: Float32Array,
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO memory_vectors (memory_id, sector, vector, dimension)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(memoryId, sector, new Uint8Array(vector.buffer), vector.length);
  }

  getMemoryVectors(
    memoryId: string,
  ): Array<{ sector: Sector; vector: Float32Array }> {
    const stmt = this.db.prepare(
      `SELECT sector, vector, dimension FROM memory_vectors WHERE memory_id = ?`,
    );
    const rows = stmt.all(memoryId) as Array<{
      sector: Sector;
      vector: Uint8Array;
      dimension: number;
    }>;
    return rows.map((r) => ({
      sector: r.sector,
      vector: new Float32Array(
        r.vector.buffer,
        r.vector.byteOffset,
        r.dimension,
      ),
    }));
  }

  insertWaypoint(srcId: string, dstId: string, weight: number = 1.0): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO waypoints (src_memory_id, dst_memory_id, weight)
      VALUES (?, ?, ?)
    `);
    stmt.run(srcId, dstId, weight);
  }

  getWaypoints(
    memoryId: string,
  ): Array<{ dst_memory_id: string; weight: number }> {
    const stmt = this.db.prepare(
      `SELECT dst_memory_id, weight FROM waypoints WHERE src_memory_id = ?`,
    );
    return stmt.all(memoryId) as Array<{
      dst_memory_id: string;
      weight: number;
    }>;
  }

  boostWaypointWeight(
    srcId: string,
    dstId: string,
    boost: number = 0.05,
  ): void {
    const stmt = this.db.prepare(`
      UPDATE waypoints SET weight = MIN(weight + ?, 2.0) WHERE src_memory_id = ? AND dst_memory_id = ?
    `);
    stmt.run(boost, srcId, dstId);
  }

  reinforceMemory(memoryId: string, salienceBoost: number = 0.1): void {
    const stmt = this.db.prepare(`
      UPDATE memories 
      SET salience = MIN(salience + ?, 1.0), 
          access_count = access_count + 1,
          last_accessed = datetime('now')
      WHERE id = ?
    `);
    stmt.run(salienceBoost, memoryId);
  }

  getMemory(memoryId: string): DbMemory | null {
    const stmt = this.db.prepare(`SELECT * FROM memories WHERE id = ?`);
    return stmt.get(memoryId) as DbMemory | null;
  }

  getMemoriesBySession(sessionId: string): DbMemory[] {
    const stmt = this.db.prepare(
      `SELECT * FROM memories WHERE session_id = ? ORDER BY created_at DESC`,
    );
    return stmt.all(sessionId) as DbMemory[];
  }

  getRecentMemories(limit: number = 50, sector?: Sector): DbMemory[] {
    let sql = `SELECT * FROM memories`;
    const params: (string | number)[] = [];

    if (sector) {
      sql += ` WHERE sector = ?`;
      params.push(sector);
    }

    sql += ` ORDER BY last_accessed DESC LIMIT ?`;
    params.push(limit);

    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as DbMemory[];
  }

  searchMemoriesFts(
    query: string,
    limit: number = 20,
  ): Array<DbMemory & { rank: number }> {
    const stmt = this.db.prepare(`
      SELECT m.*, bm25(memories_fts) as rank
      FROM memories_fts
      JOIN memories m ON memories_fts.rowid = m.rowid
      WHERE memories_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);
    return stmt.all(query, limit) as Array<DbMemory & { rank: number }>;
  }

  getAllMemoriesWithVectors(): Array<
    DbMemory & { vectors: Array<{ sector: Sector; vector: Float32Array }> }
  > {
    const memories = this.db
      .prepare(`SELECT * FROM memories`)
      .all() as DbMemory[];
    return memories.map((m) => ({
      ...m,
      vectors: this.getMemoryVectors(m.id),
    }));
  }

  getDecayedSalience(memory: DbMemory): number {
    const daysSinceAccess =
      (Date.now() - new Date(memory.last_accessed).getTime()) /
      (1000 * 60 * 60 * 24);
    return memory.salience * Math.exp(-memory.decay_lambda * daysSinceAccess);
  }

  pruneDecayedMemories(threshold: number = 0.01): number {
    const memories = this.db
      .prepare(`SELECT * FROM memories`)
      .all() as DbMemory[];
    let pruned = 0;

    for (const memory of memories) {
      const effectiveSalience = this.getDecayedSalience(memory);
      if (effectiveSalience < threshold) {
        this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(memory.id);
        pruned++;
      }
    }

    return pruned;
  }

  updateSessionSummary(sessionId: string, summary: string): void {
    const stmt = this.db.prepare(
      `UPDATE sessions SET summary = ?, updated_at = datetime('now') WHERE id = ?`,
    );
    stmt.run(summary, sessionId);
  }

  searchMessages(
    query: string,
    options: {
      limit?: number;
      sessionId?: string;
      startDate?: string;
      endDate?: string;
    } = {},
  ): FtsSearchResult[] {
    const limit = options.limit || 50;

    let sql = `
      SELECT 
        m.id as message_id,
        m.session_id,
        m.role,
        m.content,
        snippet(messages_fts, 0, '>>>', '<<<', '...', 64) as snippet,
        bm25(messages_fts) as rank,
        s.title as session_title,
        s.directory as session_directory,
        s.created_at as session_created_at
      FROM messages_fts
      JOIN messages m ON messages_fts.rowid = m.rowid
      JOIN sessions s ON m.session_id = s.id
      WHERE messages_fts MATCH ?
    `;

    const params: (string | number)[] = [query];

    if (options.sessionId) {
      sql += ` AND m.session_id = ?`;
      params.push(options.sessionId);
    }

    if (options.startDate) {
      sql += ` AND s.created_at >= ?`;
      params.push(options.startDate);
    }

    if (options.endDate) {
      sql += ` AND s.created_at <= ?`;
      params.push(options.endDate);
    }

    sql += ` ORDER BY rank LIMIT ?`;
    params.push(limit);

    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as FtsSearchResult[];
  }

  listSessions(
    options: { limit?: number; directory?: string } = {},
  ): DbSession[] {
    const limit = options.limit || 50;

    let sql = `SELECT * FROM sessions`;
    const params: (string | number)[] = [];

    if (options.directory) {
      sql += ` WHERE directory = ?`;
      params.push(options.directory);
    }

    sql += ` ORDER BY updated_at DESC LIMIT ?`;
    params.push(limit);

    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as DbSession[];
  }

  getSession(sessionId: string): DbSession | null {
    const stmt = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`);
    return stmt.get(sessionId) as DbSession | null;
  }

  getSessionMessages(sessionId: string): DbMessage[] {
    const stmt = this.db.prepare(
      `SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC`,
    );
    return stmt.all(sessionId) as DbMessage[];
  }

  getSessionToolCalls(sessionId: string): DbToolCall[] {
    const stmt = this.db.prepare(
      `SELECT * FROM tool_calls WHERE session_id = ? ORDER BY created_at ASC`,
    );
    return stmt.all(sessionId) as DbToolCall[];
  }

  getStats(): {
    sessions: number;
    messages: number;
    toolCalls: number;
    memories: number;
    waypoints: number;
  } {
    const sessions = (
      this.db.prepare(`SELECT COUNT(*) as count FROM sessions`).get() as {
        count: number;
      }
    ).count;
    const messages = (
      this.db.prepare(`SELECT COUNT(*) as count FROM messages`).get() as {
        count: number;
      }
    ).count;
    const toolCalls = (
      this.db.prepare(`SELECT COUNT(*) as count FROM tool_calls`).get() as {
        count: number;
      }
    ).count;
    const memories = (
      this.db.prepare(`SELECT COUNT(*) as count FROM memories`).get() as {
        count: number;
      }
    ).count;
    const waypoints = (
      this.db.prepare(`SELECT COUNT(*) as count FROM waypoints`).get() as {
        count: number;
      }
    ).count;
    return { sessions, messages, toolCalls, memories, waypoints };
  }

  updateEmbedding(messageId: string, embedding: Uint8Array): void {
    const stmt = this.db.prepare(
      `UPDATE messages SET embedding = ? WHERE id = ?`,
    );
    stmt.run(embedding, messageId);
  }

  getMessagesWithoutEmbeddings(limit: number = 100): DbMessage[] {
    const stmt = this.db.prepare(`
      SELECT * FROM messages WHERE embedding IS NULL ORDER BY created_at DESC LIMIT ?
    `);
    return stmt.all(limit) as DbMessage[];
  }

  upsertEntity(entity: {
    id: string;
    name: string;
    type: EntityType;
    metadata_json?: string | null;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO entities (id, name, type, metadata_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(name, type) DO UPDATE SET
        last_seen = datetime('now'),
        mention_count = mention_count + 1
    `);
    stmt.run(entity.id, entity.name, entity.type, entity.metadata_json ?? null);
  }

  getEntity(entityId: string): DbEntity | null {
    const stmt = this.db.prepare(`SELECT * FROM entities WHERE id = ?`);
    return stmt.get(entityId) as DbEntity | null;
  }

  getEntityByName(name: string, type?: EntityType): DbEntity | null {
    if (type) {
      const stmt = this.db.prepare(
        `SELECT * FROM entities WHERE name = ? AND type = ?`,
      );
      return stmt.get(name, type) as DbEntity | null;
    }
    const stmt = this.db.prepare(
      `SELECT * FROM entities WHERE name = ? ORDER BY mention_count DESC LIMIT 1`,
    );
    return stmt.get(name) as DbEntity | null;
  }

  searchEntities(query: string, limit: number = 20): DbEntity[] {
    const stmt = this.db.prepare(`
      SELECT e.* FROM entities_fts
      JOIN entities e ON entities_fts.rowid = e.rowid
      WHERE entities_fts MATCH ?
      ORDER BY e.mention_count DESC
      LIMIT ?
    `);
    return stmt.all(query, limit) as DbEntity[];
  }

  getTopEntities(limit: number = 50, type?: EntityType): DbEntity[] {
    let sql = `SELECT * FROM entities`;
    const params: (string | number)[] = [];

    if (type) {
      sql += ` WHERE type = ?`;
      params.push(type);
    }

    sql += ` ORDER BY mention_count DESC LIMIT ?`;
    params.push(limit);

    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as DbEntity[];
  }

  insertEntityMention(mention: {
    entity_id: string;
    memory_id?: string | null;
    session_id: string;
    context?: string;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO entity_mentions (entity_id, memory_id, session_id, context)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(
      mention.entity_id,
      mention.memory_id ?? null,
      mention.session_id,
      mention.context ?? null,
    );
  }

  getEntityMentions(entityId: string, limit: number = 50): DbEntityMention[] {
    const stmt = this.db.prepare(`
      SELECT * FROM entity_mentions WHERE entity_id = ? ORDER BY created_at DESC LIMIT ?
    `);
    return stmt.all(entityId, limit) as DbEntityMention[];
  }

  upsertEntityRelation(relation: {
    source_entity_id: string;
    target_entity_id: string;
    relation_type: string;
    weight?: number;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO entity_relations (source_entity_id, target_entity_id, relation_type, weight)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(source_entity_id, target_entity_id, relation_type) DO UPDATE SET
        last_seen = datetime('now'),
        mention_count = mention_count + 1,
        weight = MIN(weight + 0.1, 2.0)
    `);
    stmt.run(
      relation.source_entity_id,
      relation.target_entity_id,
      relation.relation_type,
      relation.weight ?? 1.0,
    );
  }

  getEntityRelations(entityId: string): DbEntityRelation[] {
    const stmt = this.db.prepare(`
      SELECT * FROM entity_relations 
      WHERE source_entity_id = ? OR target_entity_id = ?
      ORDER BY weight DESC
    `);
    return stmt.all(entityId, entityId) as DbEntityRelation[];
  }

  insertFact(fact: {
    id: string;
    memory_id?: string | null;
    session_id: string;
    content: string;
    sector: Sector;
    confidence?: number;
    valid_from?: string | null;
    valid_to?: string | null;
    metadata_json?: string | null;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO facts (id, memory_id, session_id, content, sector, confidence, valid_from, valid_to, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      fact.id,
      fact.memory_id ?? null,
      fact.session_id,
      fact.content,
      fact.sector,
      fact.confidence ?? 0.8,
      fact.valid_from ?? null,
      fact.valid_to ?? null,
      fact.metadata_json ?? null,
    );
  }

  getFact(factId: string): DbFact | null {
    const stmt = this.db.prepare(`SELECT * FROM facts WHERE id = ?`);
    return stmt.get(factId) as DbFact | null;
  }

  getCurrentFacts(sessionId?: string, limit: number = 100): DbFact[] {
    let sql = `SELECT * FROM facts WHERE is_current = 1`;
    const params: (string | number)[] = [];

    if (sessionId) {
      sql += ` AND session_id = ?`;
      params.push(sessionId);
    }

    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);

    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as DbFact[];
  }

  searchFacts(
    query: string,
    limit: number = 20,
  ): Array<DbFact & { rank: number }> {
    const stmt = this.db.prepare(`
      SELECT f.*, bm25(facts_fts) as rank
      FROM facts_fts
      JOIN facts f ON facts_fts.rowid = f.rowid
      WHERE facts_fts MATCH ? AND f.is_current = 1
      ORDER BY rank
      LIMIT ?
    `);
    return stmt.all(query, limit) as Array<DbFact & { rank: number }>;
  }

  invalidateFact(factId: string, validTo?: string): void {
    const stmt = this.db.prepare(`
      UPDATE facts SET is_current = 0, valid_to = COALESCE(?, datetime('now')) WHERE id = ?
    `);
    stmt.run(validTo ?? null, factId);
  }

  findRelatedFacts(
    content: string,
    sector: Sector,
    limit: number = 10,
  ): DbFact[] {
    const words = content
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3);

    if (words.length === 0) return [];

    const searchTerms = words.slice(0, 5).join(" OR ");

    const stmt = this.db.prepare(`
      SELECT f.* FROM facts_fts
      JOIN facts f ON facts_fts.rowid = f.rowid
      WHERE facts_fts MATCH ? AND f.is_current = 1 AND f.sector = ?
      ORDER BY bm25(facts_fts)
      LIMIT ?
    `);

    try {
      return stmt.all(searchTerms, sector, limit) as DbFact[];
    } catch {
      return [];
    }
  }

  supersedeFact(oldFactId: string, newFactId: string, reason: string): void {
    this.invalidateFact(oldFactId);
    this.logConsolidation({
      action: "update",
      source_ids: [oldFactId],
      result_id: newFactId,
      reason: `Superseded: ${reason}`,
    });
  }

  promoteMemoryTier(memoryId: string, newTier: MemoryTier): void {
    const stmt = this.db.prepare(`
      UPDATE memories SET tier = ? WHERE id = ?
    `);
    stmt.run(newTier, memoryId);
  }

  getMemoriesByTier(tier: MemoryTier, limit: number = 100): DbMemory[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memories WHERE tier = ? ORDER BY salience DESC LIMIT ?
    `);
    return stmt.all(tier, limit) as DbMemory[];
  }

  getPromotionCandidates(
    fromTier: MemoryTier,
    minAccessCount: number = 3,
    minSalience: number = 0.5,
    limit: number = 50,
  ): DbMemory[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memories 
      WHERE tier = ? 
        AND access_count >= ? 
        AND salience >= ?
        AND is_consolidated = 0
      ORDER BY salience DESC, access_count DESC
      LIMIT ?
    `);
    return stmt.all(fromTier, minAccessCount, minSalience, limit) as DbMemory[];
  }

  getProjectMemories(directory: string, limit: number = 100): DbMemory[] {
    const stmt = this.db.prepare(`
      SELECT m.* FROM memories m
      JOIN sessions s ON m.session_id = s.id
      WHERE s.directory = ? AND m.tier IN ('project', 'personal')
      ORDER BY m.salience DESC
      LIMIT ?
    `);
    return stmt.all(directory, limit) as DbMemory[];
  }

  getPersonalMemories(limit: number = 100): DbMemory[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memories WHERE tier = 'personal' ORDER BY salience DESC LIMIT ?
    `);
    return stmt.all(limit) as DbMemory[];
  }

  getCrossSessionMemoryCount(
    content: string,
    minSimilarityWords: number = 3,
  ): number {
    const words = content
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 5);

    if (words.length < minSimilarityWords) return 0;

    const searchTerms = words.join(" OR ");

    const stmt = this.db.prepare(`
      SELECT COUNT(DISTINCT m.session_id) as session_count
      FROM memories_fts
      JOIN memories m ON memories_fts.rowid = m.rowid
      WHERE memories_fts MATCH ?
    `);

    try {
      const result = stmt.get(searchTerms) as { session_count: number } | null;
      return result?.session_count || 0;
    } catch {
      return 0;
    }
  }

  logConsolidation(log: {
    action: "merge" | "update" | "delete" | "create";
    source_ids: string[];
    result_id?: string | null;
    reason: string;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO consolidation_log (action, source_ids, result_id, reason)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(
      log.action,
      JSON.stringify(log.source_ids),
      log.result_id ?? null,
      log.reason,
    );
  }

  getConsolidationLogs(limit: number = 100): DbConsolidationLog[] {
    const stmt = this.db.prepare(`
      SELECT * FROM consolidation_log ORDER BY created_at DESC LIMIT ?
    `);
    return stmt.all(limit) as DbConsolidationLog[];
  }

  markMemoryConsolidated(memoryId: string): void {
    const stmt = this.db.prepare(`
      UPDATE memories SET is_consolidated = 1 WHERE id = ?
    `);
    stmt.run(memoryId);
  }

  getUnconsolidatedMemories(limit: number = 100): DbMemory[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memories WHERE is_consolidated = 0 ORDER BY created_at ASC LIMIT ?
    `);
    return stmt.all(limit) as DbMemory[];
  }

  getSimilarMemories(
    memoryId: string,
    threshold: number = 0.85,
  ): Array<{ memory: DbMemory; similarity: number }> {
    const sourceVectors = this.getMemoryVectors(memoryId);
    if (sourceVectors.length === 0) return [];

    const allMemories = this.getAllMemoriesWithVectors();
    const results: Array<{ memory: DbMemory; similarity: number }> = [];

    for (const m of allMemories) {
      if (m.id === memoryId || m.vectors.length === 0) continue;

      let maxSim = 0;
      for (const sv of sourceVectors) {
        for (const tv of m.vectors) {
          let dot = 0;
          let normA = 0;
          let normB = 0;
          for (let i = 0; i < sv.vector.length; i++) {
            dot += sv.vector[i] * tv.vector[i];
            normA += sv.vector[i] * sv.vector[i];
            normB += tv.vector[i] * tv.vector[i];
          }
          const sim = dot / (Math.sqrt(normA) * Math.sqrt(normB));
          if (sim > maxSim) maxSim = sim;
        }
      }

      if (maxSim >= threshold) {
        results.push({ memory: m, similarity: maxSim });
      }
    }

    return results.sort((a, b) => b.similarity - a.similarity);
  }

  getMemoriesByTimeRange(
    startDate: string,
    endDate: string,
    options: { sector?: Sector; directory?: string; limit?: number } = {},
  ): DbMemory[] {
    let sql = `
      SELECT m.* FROM memories m
      JOIN sessions s ON m.session_id = s.id
      WHERE m.created_at >= ? AND m.created_at <= ?
    `;
    const params: (string | number)[] = [startDate, endDate];

    if (options.sector) {
      sql += ` AND m.sector = ?`;
      params.push(options.sector);
    }

    if (options.directory) {
      sql += ` AND s.directory = ?`;
      params.push(options.directory);
    }

    sql += ` ORDER BY m.created_at DESC LIMIT ?`;
    params.push(options.limit || 100);

    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as DbMemory[];
  }

  getExtendedStats(): {
    sessions: number;
    messages: number;
    toolCalls: number;
    memories: number;
    waypoints: number;
    entities: number;
    entityRelations: number;
    facts: number;
    consolidations: number;
  } {
    const basic = this.getStats();
    const entities = (
      this.db.prepare(`SELECT COUNT(*) as count FROM entities`).get() as {
        count: number;
      }
    ).count;
    const entityRelations = (
      this.db
        .prepare(`SELECT COUNT(*) as count FROM entity_relations`)
        .get() as {
        count: number;
      }
    ).count;
    const facts = (
      this.db.prepare(`SELECT COUNT(*) as count FROM facts`).get() as {
        count: number;
      }
    ).count;
    const consolidations = (
      this.db
        .prepare(`SELECT COUNT(*) as count FROM consolidation_log`)
        .get() as {
        count: number;
      }
    ).count;
    return { ...basic, entities, entityRelations, facts, consolidations };
  }

  close(): void {
    this.db.close();
  }
}
