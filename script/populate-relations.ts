import { ChatLoggerDb } from "../src/db";
import { extractEntitiesAndRelations } from "../src/entities";
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

  console.log("=== Populating Entity Relations ===\n");

  const stats = db.getExtendedStats();
  console.log("Current stats:");
  console.log(`- Memories: ${stats.memories}`);
  console.log(`- Entities: ${stats.entities}`);
  console.log(`- Entity Relations: ${stats.entityRelations}`);
  console.log(`- Entity Co-occurrences: ${stats.entityCooccurrences}\n`);

  const memories = db["db"]
    .prepare("SELECT id, content, session_id FROM memories")
    .all() as Array<{ id: string; content: string; session_id: string }>;

  console.log(`Processing ${memories.length} memories...\n`);

  let totalRelations = 0;
  let processedMemories = 0;
  const relationCounts: Record<string, number> = {};

  const findOrCreateEntityId = (
    name: string,
    type: "file" | "function" | "class" | "concept",
  ): string | null => {
    const normalized = name.toLowerCase().replace(/[()]/g, "");
    
    let existing = db.getEntityByName(normalized);
    if (existing) return existing.id;
    
    existing = db.getEntityByName(name);
    if (existing) return existing.id;

    if (name.includes(".") && !name.includes(" ")) {
      existing = db.getEntityByName(name, "file");
      if (existing) return existing.id;
    }

    const newId = crypto.randomUUID();
    db.upsertEntity({
      id: newId,
      name: normalized,
      type,
      metadata_json: JSON.stringify({ source: "relation_backfill" }),
    });
    
    const created = db.getEntityByName(normalized);
    return created?.id || null;
  };

  for (const memory of memories) {
    const { entities, relations } = extractEntitiesAndRelations(memory.content);

    if (relations.length === 0) continue;

    const entityNameToId = new Map<string, string>();

    for (const entity of entities) {
      const existing = db.getEntityByName(entity.name, entity.type);
      if (existing) {
        entityNameToId.set(entity.name.toLowerCase(), existing.id);
        entityNameToId.set(entity.name.toLowerCase().replace(/[()]/g, ""), existing.id);
      }
    }

    for (const relation of relations) {
      if (relation.sourceEntity.name === "context") continue;

      const srcType = relation.sourceEntity.name.includes(".")
        ? "file"
        : relation.sourceEntity.name.match(/^[A-Z]/)
          ? "class"
          : "function";
      const tgtType = relation.targetEntity.name.includes(".")
        ? "file"
        : relation.targetEntity.name.match(/^[A-Z]/)
          ? "class"
          : "function";

      let sourceId = entityNameToId.get(
        relation.sourceEntity.name.toLowerCase(),
      ) || entityNameToId.get(
        relation.sourceEntity.name.toLowerCase().replace(/[()]/g, ""),
      ) || findOrCreateEntityId(relation.sourceEntity.name, srcType);

      let targetId = entityNameToId.get(
        relation.targetEntity.name.toLowerCase(),
      ) || entityNameToId.get(
        relation.targetEntity.name.toLowerCase().replace(/[()]/g, ""),
      ) || findOrCreateEntityId(relation.targetEntity.name, tgtType);

      if (sourceId && targetId && sourceId !== targetId) {
        db.upsertEntityRelation({
          source_entity_id: sourceId,
          target_entity_id: targetId,
          relation_type: relation.relationType,
          weight: relation.confidence,
        });
        totalRelations++;
        relationCounts[relation.relationType] =
          (relationCounts[relation.relationType] || 0) + 1;
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
  console.log(`Relations recorded: ${totalRelations}`);

  console.log("\n=== Relations by Type ===");
  const sortedTypes = Object.entries(relationCounts).sort((a, b) => b[1] - a[1]);
  for (const [type, count] of sortedTypes) {
    console.log(`- ${type}: ${count}`);
  }

  const finalRelations = (
    db["db"]
      .prepare("SELECT COUNT(*) as count FROM entity_relations")
      .get() as { count: number }
  ).count;
  console.log(`\nTotal relations in DB: ${finalRelations}`);

  console.log("\n=== Top Entity Relations ===");
  const topRelations = db["db"]
    .prepare(
      `
    SELECT 
      e1.name as source, e1.type as source_type,
      r.relation_type,
      e2.name as target, e2.type as target_type,
      r.mention_count
    FROM entity_relations r
    JOIN entities e1 ON r.source_entity_id = e1.id
    JOIN entities e2 ON r.target_entity_id = e2.id
    ORDER BY r.mention_count DESC, r.weight DESC
    LIMIT 15
  `,
    )
    .all() as Array<{
    source: string;
    source_type: string;
    relation_type: string;
    target: string;
    target_type: string;
    mention_count: number;
  }>;

  for (const rel of topRelations) {
    console.log(
      `- ${rel.source} [${rel.source_type}] --${rel.relation_type}--> ${rel.target} [${rel.target_type}] (×${rel.mention_count})`,
    );
  }

  db.close();
}

main().catch(console.error);
