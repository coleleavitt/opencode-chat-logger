import { Database } from "bun:sqlite";
import * as path from "path";
import * as fs from "fs";

export type Sector =
  | "code_change"
  | "debugging"
  | "architecture"
  | "discussion"
  | "procedural";

export const SECTOR_DECAY_RATES: Record<Sector, number> = {
  code_change: 0.01,
  debugging: 0.025,
  architecture: 0.003,
  discussion: 0.02,
  procedural: 0.005,
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
  salience: number;
  decay_lambda: number;
  access_count: number;
  last_accessed: string;
  created_at: string;
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
        sector TEXT NOT NULL CHECK (sector IN ('code_change', 'debugging', 'architecture', 'discussion', 'procedural')),
        salience REAL NOT NULL DEFAULT 0.5,
        decay_lambda REAL NOT NULL DEFAULT 0.01,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed TEXT NOT NULL DEFAULT (datetime('now')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
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
      INSERT INTO memories (id, session_id, content, sector, salience, decay_lambda, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      memory.id,
      memory.session_id,
      memory.content,
      memory.sector,
      memory.salience,
      memory.decay_lambda,
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

  close(): void {
    this.db.close();
  }
}
