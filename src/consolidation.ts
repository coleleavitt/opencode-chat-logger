import type { ChatLoggerDb, DbMemory } from "./db";
import { cosineSimilarity } from "./embedding";

export interface ConsolidationResult {
  merged: number;
  updated: number;
  deleted: number;
  created: number;
}

export interface SimilarMemoryPair {
  memory1: DbMemory;
  memory2: DbMemory;
  similarity: number;
  sharedEntities: number;
}

const SIMILARITY_THRESHOLD = 0.75;

function combineSalience(m1: DbMemory, m2: DbMemory): number {
  return Math.min(Math.max(m1.salience, m2.salience) * 1.1, 1.0);
}

function countSharedEntities(
  db: ChatLoggerDb,
  m1Id: string,
  m2Id: string,
): number {
  const entities1 = db.getEntitiesInMemory(m1Id);
  const entities2 = db.getEntitiesInMemory(m2Id);

  const ids1 = new Set(entities1.map((e) => e.id));
  return entities2.filter((e) => ids1.has(e.id)).length;
}

export function findSimilarMemories(
  db: ChatLoggerDb,
  threshold: number = SIMILARITY_THRESHOLD,
  requireEntityOverlap: boolean = false,
): SimilarMemoryPair[] {
  const pairs: SimilarMemoryPair[] = [];
  const memories = db.getUnconsolidatedMemories(500);

  const memoriesWithVectors = memories
    .map((m) => ({
      memory: m,
      vectors: db.getMemoryVectors(m.id),
    }))
    .filter((m) => m.vectors.length > 0);

  for (let i = 0; i < memoriesWithVectors.length; i++) {
    for (let j = i + 1; j < memoriesWithVectors.length; j++) {
      const m1 = memoriesWithVectors[i];
      const m2 = memoriesWithVectors[j];

      if (m1.memory.sector !== m2.memory.sector) continue;

      let maxSimilarity = 0;
      for (const v1 of m1.vectors) {
        for (const v2 of m2.vectors) {
          const sim = cosineSimilarity(v1.vector, v2.vector);
          if (sim > maxSimilarity) maxSimilarity = sim;
        }
      }

      if (maxSimilarity < threshold) continue;

      const sharedEntities = countSharedEntities(
        db,
        m1.memory.id,
        m2.memory.id,
      );

      if (requireEntityOverlap && sharedEntities === 0) continue;

      pairs.push({
        memory1: m1.memory,
        memory2: m2.memory,
        similarity: maxSimilarity,
        sharedEntities,
      });
    }
  }

  return pairs.sort((a, b) => {
    const scoreA = a.similarity + a.sharedEntities * 0.1;
    const scoreB = b.similarity + b.sharedEntities * 0.1;
    return scoreB - scoreA;
  });
}

export function consolidateMemoryPair(
  db: ChatLoggerDb,
  pair: SimilarMemoryPair,
): string | null {
  const { memory1, memory2 } = pair;

  const mergedSalience = combineSalience(memory1, memory2);
  const newer = new Date(memory1.created_at) > new Date(memory2.created_at);
  const keepMemory = newer ? memory1 : memory2;
  const deleteMemory = newer ? memory2 : memory1;

  const salienceBoost = mergedSalience - keepMemory.salience;
  db.reinforceMemory(keepMemory.id, salienceBoost > 0 ? salienceBoost : 0.05);
  db.markMemoryConsolidated(keepMemory.id);
  db.markMemoryConsolidated(deleteMemory.id);

  db.logConsolidation({
    action: "merge",
    source_ids: [memory1.id, memory2.id],
    result_id: keepMemory.id,
    reason: `Merged (similarity: ${pair.similarity.toFixed(3)}, shared entities: ${pair.sharedEntities})`,
  });

  return keepMemory.id;
}

export function runConsolidationPass(
  db: ChatLoggerDb,
  maxMerges: number = 10,
): ConsolidationResult {
  const result: ConsolidationResult = {
    merged: 0,
    updated: 0,
    deleted: 0,
    created: 0,
  };

  const pairs = findSimilarMemories(db, SIMILARITY_THRESHOLD, false);
  const processedIds = new Set<string>();

  for (const pair of pairs) {
    if (result.merged >= maxMerges) break;

    if (
      processedIds.has(pair.memory1.id) ||
      processedIds.has(pair.memory2.id)
    ) {
      continue;
    }

    const mergedId = consolidateMemoryPair(db, pair);
    if (mergedId) {
      processedIds.add(pair.memory1.id);
      processedIds.add(pair.memory2.id);
      result.merged++;
    }
  }

  return result;
}

export function getConsolidationStats(db: ChatLoggerDb): {
  unconsolidated: number;
  consolidated: number;
  potentialMerges: number;
} {
  const unconsolidated = db.getUnconsolidatedMemories(1000).length;
  const logs = db.getConsolidationLogs(100);
  const consolidated = logs.filter((l) => l.action === "merge").length;
  const potentialMerges = findSimilarMemories(db, 0.75, false).length;

  return { unconsolidated, consolidated, potentialMerges };
}

export interface TierPromotionResult {
  sessionToProject: number;
  projectToPersonal: number;
}

export function runTierPromotion(
  db: ChatLoggerDb,
  maxPromotions: number = 20,
): TierPromotionResult {
  const result: TierPromotionResult = {
    sessionToProject: 0,
    projectToPersonal: 0,
  };

  const sessionMemories = db.getMemoriesByTier("session", 200);

  for (const memory of sessionMemories) {
    if (result.sessionToProject >= maxPromotions / 2) break;

    const crossSessionCount = db.getCrossSessionMemoryCount(memory.content);
    if (crossSessionCount >= 2) {
      db.promoteMemoryTier(memory.id, "project");
      db.logConsolidation({
        action: "update",
        source_ids: [memory.id],
        result_id: memory.id,
        reason: `Promoted session→project (cross-session=${crossSessionCount})`,
      });
      result.sessionToProject++;
    }
  }

  const projectMemories = db.getMemoriesByTier("project", 200);

  for (const memory of projectMemories) {
    if (result.projectToPersonal >= maxPromotions / 2) break;

    const effectiveSalience = db.getDecayedSalience(memory);
    if (effectiveSalience > 0.7) {
      db.promoteMemoryTier(memory.id, "personal");
      db.logConsolidation({
        action: "update",
        source_ids: [memory.id],
        result_id: memory.id,
        reason: `Promoted project→personal (effective salience=${effectiveSalience.toFixed(2)})`,
      });
      result.projectToPersonal++;
    }
  }

  return result;
}

export function runSessionEndConsolidation(db: ChatLoggerDb): {
  consolidation: ConsolidationResult;
  promotion: TierPromotionResult;
} {
  const consolidation = runConsolidationPass(db, 20);
  const promotion = runTierPromotion(db, 20);

  return { consolidation, promotion };
}
