import { ChatLoggerDb } from "../src/db";
import { extractEntitiesAndRelations } from "../src/entities";
import * as crypto from "crypto";
import * as os from "os";
import * as path from "path";

const logDir = path.join(os.homedir(), ".local", "share", "opencode", "chat-logs");
const db = new ChatLoggerDb(logDir);

const memories = db.db.prepare("SELECT id, session_id, content FROM memories").all() as { id: string; session_id: string; content: string }[];

console.log(`Processing ${memories.length} memories...`);

let totalEntities = 0;
let totalRelations = 0;

for (const memory of memories) {
  const { entities, relations } = extractEntitiesAndRelations(memory.content);
  
  for (const entity of entities) {
    try {
      const existing = db.getEntityByName(entity.name, entity.type);
      if (existing) {
        db.db.prepare(`UPDATE entities SET last_seen = datetime('now'), mention_count = mention_count + 1 WHERE id = ?`).run(existing.id);
        try {
          db.insertEntityMention({
            entity_id: existing.id,
            memory_id: memory.id,
            session_id: memory.session_id,
            context: entity.context.substring(0, 500),
          });
        } catch {}
      } else {
        const entityId = crypto.randomUUID();
        db.db.prepare(`INSERT OR IGNORE INTO entities (id, name, type, metadata_json) VALUES (?, ?, ?, ?)`).run(
          entityId, entity.name, entity.type, JSON.stringify({ confidence: entity.confidence })
        );
        const inserted = db.getEntityByName(entity.name, entity.type);
        if (inserted) {
          try {
            db.insertEntityMention({
              entity_id: inserted.id,
              memory_id: memory.id,
              session_id: memory.session_id,
              context: entity.context.substring(0, 500),
            });
          } catch {}
        }
      }
      totalEntities++;
    } catch (e) {
      console.error(`Error processing entity ${entity.name}:`, e);
    }
  }
  
  for (const relation of relations) {
    try {
      const source = db.getEntityByName(relation.sourceEntity.name, relation.sourceEntity.type);
      const target = db.getEntityByName(relation.targetEntity.name, relation.targetEntity.type);
      
      if (source && target) {
        db.upsertEntityRelation({
          source_entity_id: source.id,
          target_entity_id: target.id,
          relation_type: relation.relationType,
          weight: relation.confidence,
        });
        totalRelations++;
      }
    } catch {}
  }
}

console.log(`Extracted ${totalEntities} entity mentions, ${totalRelations} relations`);

const stats = db.getExtendedStats();
console.log(`Database now has: ${stats.entities} entities, ${stats.entityRelations} relations`);

const topEntities = db.db.prepare("SELECT name, type, mention_count FROM entities ORDER BY mention_count DESC LIMIT 15").all();
console.log("\nTop entities by mentions:");
for (const e of topEntities as { name: string; type: string; mention_count: number }[]) {
  console.log(`  ${e.name} (${e.type}): ${e.mention_count}`);
}

db.close();
