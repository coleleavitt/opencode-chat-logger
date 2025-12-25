#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import * as path from "path";
import * as os from "os";

const OLLAMA_URL = "http://localhost:11434";
const OLLAMA_MODEL = "nomic-embed-text";

interface MemoryRow {
  id: string;
  content: string;
  sector: string;
}

interface VectorRow {
  id: number;
  memory_id: string;
  dimension: number;
}

async function embedWithOllama(text: string): Promise<Float32Array> {
  const response = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: OLLAMA_MODEL, input: text }),
  });

  if (!response.ok) {
    throw new Error(`Ollama embedding failed: ${response.statusText}`);
  }

  const data = (await response.json()) as { embeddings: number[][] };
  return new Float32Array(data.embeddings[0]);
}

async function main() {
  const logDir = path.join(os.homedir(), ".local/share/opencode/chat-logs");
  const dbPath = path.join(logDir, "chat-logs.db");

  console.log(`Opening database: ${dbPath}`);
  const db = new Database(dbPath);

  const oldVectors = db
    .prepare(
      `SELECT DISTINCT mv.memory_id, mv.dimension 
       FROM memory_vectors mv 
       WHERE mv.dimension = 384`,
    )
    .all() as VectorRow[];

  console.log(
    `Found ${oldVectors.length} memories with 384d embeddings to regenerate\n`,
  );

  if (oldVectors.length === 0) {
    console.log("Nothing to regenerate!");
    db.close();
    return;
  }

  let success = 0;
  let failed = 0;

  for (const vec of oldVectors) {
    const memory = db
      .prepare(`SELECT id, content, sector FROM memories WHERE id = ?`)
      .get(vec.memory_id) as MemoryRow | null;

    if (!memory) {
      console.log(`⚠ Memory ${vec.memory_id} not found, skipping`);
      failed++;
      continue;
    }

    process.stdout.write(`Processing: ${memory.id.slice(0, 8)}... `);

    try {
      const embedding = await embedWithOllama(memory.content);

      db.prepare(`DELETE FROM memory_vectors WHERE memory_id = ?`).run(
        memory.id,
      );

      db.prepare(
        `INSERT INTO memory_vectors (memory_id, sector, vector, dimension) VALUES (?, ?, ?, ?)`,
      ).run(
        memory.id,
        memory.sector,
        new Uint8Array(embedding.buffer),
        embedding.length,
      );

      console.log(`✓ 384d → ${embedding.length}d`);
      success++;
    } catch (err) {
      console.log(`✗ ${err}`);
      failed++;
    }

    await new Promise((r) => setTimeout(r, 50));
  }

  console.log(`\n========================================`);
  console.log(`Regeneration complete!`);
  console.log(`  Success: ${success}`);
  console.log(`  Failed:  ${failed}`);
  console.log(`========================================\n`);

  const stats = db
    .prepare(
      `SELECT dimension, COUNT(*) as count FROM memory_vectors GROUP BY dimension`,
    )
    .all() as Array<{ dimension: number; count: number }>;

  console.log("Current embedding distribution:");
  for (const s of stats) {
    console.log(`  ${s.dimension}d: ${s.count} vectors`);
  }

  db.close();
}

main().catch(console.error);
