import { Database } from "bun:sqlite"
import * as path from "path"
import * as fs from "fs"

export interface DbSession {
  id: string
  directory: string | null
  project_id: string | null
  title: string | null
  version: string | null
  created_at: string
  updated_at: string
  last_agent: string | null
  last_model: string | null
  message_count: number
}

export interface DbMessage {
  id: string
  session_id: string
  role: string
  content: string
  agent: string | null
  model: string | null
  parts_json: string | null
  embedding: Uint8Array | null
  created_at: string
}

export interface DbToolCall {
  id: string
  session_id: string
  call_id: string
  tool: string
  phase: "before" | "after"
  args_json: string | null
  output: string | null
  title: string | null
  metadata_json: string | null
  created_at: string
}

export interface FtsSearchResult {
  message_id: string
  session_id: string
  role: string
  content: string
  snippet: string
  rank: number
  session_title: string | null
  session_directory: string | null
  session_created_at: string
}

export class ChatLoggerDb {
  private db: Database

  constructor(logDir: string) {
    const dbPath = path.join(logDir, "chat-logs.db")
    
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true })
    }

    this.db = new Database(dbPath)
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA foreign_keys = ON")
    this.initSchema()
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
        message_count INTEGER DEFAULT 0
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
    `)
  }

  upsertSession(session: Partial<DbSession> & { id: string }): void {
    const stmt = this.db.prepare(`
      INSERT INTO sessions (id, directory, project_id, title, version, last_agent, last_model, message_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        directory = COALESCE(excluded.directory, directory),
        project_id = COALESCE(excluded.project_id, project_id),
        title = COALESCE(excluded.title, title),
        version = COALESCE(excluded.version, version),
        last_agent = COALESCE(excluded.last_agent, last_agent),
        last_model = COALESCE(excluded.last_model, last_model),
        message_count = COALESCE(excluded.message_count, message_count),
        updated_at = datetime('now')
    `)

    stmt.run(
      String(session.id || ""),
      session.directory ? String(session.directory) : null,
      session.project_id ? String(session.project_id) : null,
      session.title ? String(session.title) : null,
      session.version ? String(session.version) : null,
      session.last_agent ? String(session.last_agent) : null,
      session.last_model ? String(session.last_model) : null,
      typeof session.message_count === "number" ? session.message_count : 0
    )
  }

  incrementMessageCount(sessionId: string): void {
    const stmt = this.db.prepare(`
      UPDATE sessions SET message_count = message_count + 1, updated_at = datetime('now') WHERE id = ?
    `)
    stmt.run(sessionId)
  }

  insertMessage(message: Omit<DbMessage, "created_at">): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO messages (id, session_id, role, content, agent, model, parts_json, embedding, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `)

    stmt.run(
      String(message.id || ""),
      String(message.session_id || ""),
      String(message.role || "unknown"),
      String(message.content || ""),
      message.agent ? String(message.agent) : null,
      message.model ? String(message.model) : null,
      message.parts_json ? String(message.parts_json) : null,
      message.embedding ?? null
    )
  }

  insertToolCall(toolCall: Omit<DbToolCall, "id" | "created_at">): void {
    const stmt = this.db.prepare(`
      INSERT INTO tool_calls (session_id, call_id, tool, phase, args_json, output, title, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `)

    stmt.run(
      String(toolCall.session_id || ""),
      String(toolCall.call_id || ""),
      String(toolCall.tool || ""),
      String(toolCall.phase || "before"),
      toolCall.args_json ? String(toolCall.args_json) : null,
      toolCall.output ? String(toolCall.output) : null,
      toolCall.title ? String(toolCall.title) : null,
      toolCall.metadata_json ? String(toolCall.metadata_json) : null
    )
  }

  searchMessages(query: string, options: { limit?: number; sessionId?: string; startDate?: string; endDate?: string } = {}): FtsSearchResult[] {
    const limit = options.limit || 50
    
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
    `

    const params: (string | number)[] = [query]

    if (options.sessionId) {
      sql += ` AND m.session_id = ?`
      params.push(options.sessionId)
    }

    if (options.startDate) {
      sql += ` AND s.created_at >= ?`
      params.push(options.startDate)
    }

    if (options.endDate) {
      sql += ` AND s.created_at <= ?`
      params.push(options.endDate)
    }

    sql += ` ORDER BY rank LIMIT ?`
    params.push(limit)

    const stmt = this.db.prepare(sql)
    return stmt.all(...params) as FtsSearchResult[]
  }

  listSessions(options: { limit?: number; directory?: string } = {}): DbSession[] {
    const limit = options.limit || 50
    
    let sql = `SELECT * FROM sessions`
    const params: (string | number)[] = []

    if (options.directory) {
      sql += ` WHERE directory = ?`
      params.push(options.directory)
    }

    sql += ` ORDER BY updated_at DESC LIMIT ?`
    params.push(limit)

    const stmt = this.db.prepare(sql)
    return stmt.all(...params) as DbSession[]
  }

  getSession(sessionId: string): DbSession | null {
    const stmt = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`)
    return stmt.get(sessionId) as DbSession | null
  }

  getSessionMessages(sessionId: string): DbMessage[] {
    const stmt = this.db.prepare(`SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC`)
    return stmt.all(sessionId) as DbMessage[]
  }

  getSessionToolCalls(sessionId: string): DbToolCall[] {
    const stmt = this.db.prepare(`SELECT * FROM tool_calls WHERE session_id = ? ORDER BY created_at ASC`)
    return stmt.all(sessionId) as DbToolCall[]
  }

  getStats(): { sessions: number; messages: number; toolCalls: number } {
    const sessions = (this.db.prepare(`SELECT COUNT(*) as count FROM sessions`).get() as { count: number }).count
    const messages = (this.db.prepare(`SELECT COUNT(*) as count FROM messages`).get() as { count: number }).count
    const toolCalls = (this.db.prepare(`SELECT COUNT(*) as count FROM tool_calls`).get() as { count: number }).count
    return { sessions, messages, toolCalls }
  }

  updateEmbedding(messageId: string, embedding: Uint8Array): void {
    const stmt = this.db.prepare(`UPDATE messages SET embedding = ? WHERE id = ?`)
    stmt.run(embedding, messageId)
  }

  getMessagesWithoutEmbeddings(limit: number = 100): DbMessage[] {
    const stmt = this.db.prepare(`
      SELECT * FROM messages WHERE embedding IS NULL ORDER BY created_at DESC LIMIT ?
    `)
    return stmt.all(limit) as DbMessage[]
  }

  close(): void {
    this.db.close()
  }
}
