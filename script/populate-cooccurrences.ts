import { ChatLoggerDb } from "../src/db";
import { extractEntities } from "../src/entities";
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
} from "../src/embedding";
import * as path from "path";
import * as os from "os";

const LOG_DIR = path.join(
  os.homedir(),
  ".local",
  "share",
  "opencode",
  "chat-logs",
);

async function main() {
  const db = new ChatLoggerDb(LOG_DIR);

  console.log("=== Populating Entity Co-occurrences ===\n");

  const stats = db.getExtendedStats();
  console.log("Current stats:");
  console.log(`- Memories: ${stats.memories}`);
  console.log(`- Entities: ${stats.entities}`);
  console.log(`- Entity Relations (old): ${stats.entityRelations}`);

  const cooccurrenceCount = (
    db["db"]
      .prepare("SELECT COUNT(*) as count FROM entity_cooccurrences")
      .get() as { count: number }
  ).count;
  console.log(`- Co-occurrences: ${cooccurrenceCount}\n`);

  let embedder: EmbeddingProvider | null = null;
  try {
    embedder = await createEmbeddingProvider({});
    console.log(`Using embedder with dimension: ${embedder.dimension}\n`);
  } catch (e) {
    console.log("No embedder available, skipping context vectors\n");
  }

  const memories = db["db"]
    .prepare("SELECT id, content, session_id FROM memories")
    .all() as Array<{ id: string; content: string; session_id: string }>;

  console.log(`Processing ${memories.length} memories...\n`);

  let totalCooccurrences = 0;
  let totalVectors = 0;
  let processedMemories = 0;

  for (const memory of memories) {
    const entities = extractEntities(memory.content);
    if (entities.length < 2) continue;

    const entityIds: string[] = [];

    for (const entity of entities) {
      db.upsertEntity({
        id: crypto.randomUUID(),
        name: entity.name,
        type: entity.type,
        metadata_json: JSON.stringify({ confidence: entity.confidence }),
      });

      const existing = db.getEntityByName(entity.name, entity.type);
      if (existing) {
        entityIds.push(existing.id);

        const existingMention = db["db"]
          .prepare(
            "SELECT id FROM entity_mentions WHERE entity_id = ? AND memory_id = ?",
          )
          .get(existing.id, memory.id);

        if (!existingMention) {
          db.insertEntityMention({
            entity_id: existing.id,
            memory_id: memory.id,
            session_id: memory.session_id,
            context: entity.context.substring(0, 500),
          });
        }

        if (embedder) {
          const existingVector = db["db"]
            .prepare(
              "SELECT id FROM entity_vectors WHERE entity_id = ? AND memory_id = ?",
            )
            .get(existing.id, memory.id);

          if (!existingVector) {
            try {
              const vector = await embedder.embed(
                entity.context.substring(0, 500),
              );
              db.insertEntityVector(
                existing.id,
                memory.id,
                vector,
                entity.context.substring(0, 200),
              );
              totalVectors++;
            } catch {}
          }
        }
      }
    }

    for (let i = 0; i < entityIds.length; i++) {
      for (let j = i + 1; j < entityIds.length; j++) {
        db.upsertEntityCooccurrence(entityIds[i], entityIds[j], memory.id);
        totalCooccurrences++;
      }
    }

    processedMemories++;
    if (processedMemories % 10 === 0) {
      process.stdout.write(
        `\rProcessed ${processedMemories}/${memories.length} memories...`,
      );
    }
  }

  console.log(`\n\n=== Results ===`);
  console.log(`Processed memories: ${processedMemories}`);
  console.log(`Co-occurrences recorded: ${totalCooccurrences}`);
  console.log(`Entity vectors created: ${totalVectors}`);

  const finalCooccurrences = (
    db["db"]
      .prepare("SELECT COUNT(*) as count FROM entity_cooccurrences")
      .get() as { count: number }
  ).count;
  console.log(`\nTotal co-occurrences in DB: ${finalCooccurrences}`);

  const finalVectors = (
    db["db"].prepare("SELECT COUNT(*) as count FROM entity_vectors").get() as {
      count: number;
    }
  ).count;
  console.log(`Total entity vectors in DB: ${finalVectors}`);

  console.log("\n=== Top Co-occurring Entity Pairs ===");
  const topPairs = db["db"]
    .prepare(
      `
    SELECT 
      e1.name as entity_a, e1.type as type_a,
      e2.name as entity_b, e2.type as type_b,
      c.cooccurrence_count
    FROM entity_cooccurrences c
    JOIN entities e1 ON c.entity_a_id = e1.id
    JOIN entities e2 ON c.entity_b_id = e2.id
    ORDER BY c.cooccurrence_count DESC
    LIMIT 10
  `,
    )
    .all() as Array<{
    entity_a: string;
    type_a: string;
    entity_b: string;
    type_b: string;
    cooccurrence_count: number;
  }>;

  for (const pair of topPairs) {
    console.log(
      `- ${pair.entity_a} [${pair.type_a}] <-> ${pair.entity_b} [${pair.type_b}]: ${pair.cooccurrence_count}`,
    );
  }

  console.log("\n=== Testing findRelatedEntities ===");
  const testEntities = db.getTopEntities(3);
  for (const entity of testEntities) {
    console.log(`\nRelated to "${entity.name}" [${entity.type}]:`);
    const related = db.findRelatedEntities(entity.id, { limit: 5 });
    for (const r of related) {
      console.log(
        `  - ${r.entity.name} [${r.entity.type}] (score: ${r.compositeScore.toFixed(3)}, cooc: ${r.cooccurrenceCount})`,
      );
    }
  }

  db.close();
}

main().catch(console.error);
