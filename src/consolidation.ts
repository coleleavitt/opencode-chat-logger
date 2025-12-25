import type { ChatLoggerDb, DbMemory, Sector } from "./db";
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
}

const SIMILARITY_THRESHOLD = 0.85;
const MIN_AGE_HOURS = 24;

function getMemoryAge(memory: DbMemory): number {
  const created = new Date(memory.created_at).getTime();
  const now = Date.now();
  return (now - created) / (1000 * 60 * 60);
}

function mergeMemoryContent(m1: DbMemory, m2: DbMemory): string {
  if (m1.content === m2.content) return m1.content;

  const newer = new Date(m1.created_at) > new Date(m2.created_at) ? m1 : m2;
  const older = newer === m1 ? m2 : m1;

  if (newer.content.includes(older.content)) return newer.content;
  if (older.content.includes(newer.content)) return older.content;

  return newer.content.length > older.content.length
    ? newer.content
    : older.content;
}

function combineSalience(m1: DbMemory, m2: DbMemory): number {
  return Math.min(Math.max(m1.salience, m2.salience) * 1.1, 1.0);
}

function selectSector(m1: DbMemory, m2: DbMemory): Sector {
  const sectorPriority: Record<Sector, number> = {
    architecture: 5,
    code_change: 4,
    debugging: 3,
    procedural: 2,
    discussion: 1,
    emotional: 0,
  };

  return sectorPriority[m1.sector] >= sectorPriority[m2.sector]
    ? m1.sector
    : m2.sector;
}

export function findSimilarMemories(
  db: ChatLoggerDb,
  threshold: number = SIMILARITY_THRESHOLD,
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

      let maxSimilarity = 0;
      for (const v1 of m1.vectors) {
        for (const v2 of m2.vectors) {
          const sim = cosineSimilarity(v1.vector, v2.vector);
          if (sim > maxSimilarity) maxSimilarity = sim;
        }
      }

      if (maxSimilarity >= threshold) {
        pairs.push({
          memory1: m1.memory,
          memory2: m2.memory,
          similarity: maxSimilarity,
        });
      }
    }
  }

  return pairs.sort((a, b) => b.similarity - a.similarity);
}

export function consolidateMemoryPair(
  db: ChatLoggerDb,
  pair: SimilarMemoryPair,
): string | null {
  const { memory1, memory2 } = pair;

  const age1 = getMemoryAge(memory1);
  const age2 = getMemoryAge(memory2);
  if (age1 < MIN_AGE_HOURS && age2 < MIN_AGE_HOURS) {
    return null;
  }

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
    reason: `Merged similar memories (similarity: ${pair.similarity.toFixed(3)})`,
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

  const pairs = findSimilarMemories(db);
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
  const potentialMerges = findSimilarMemories(db, 0.8).length;

  return { unconsolidated, consolidated, potentialMerges };
}

export interface TierPromotionResult {
  sessionToProject: number;
  projectToPersonal: number;
}

const TIER_PROMOTION_THRESHOLDS = {
  sessionToProject: {
    minAccessCount: 3,
    minSalience: 0.4,
    minCrossSessionCount: 2,
  },
  projectToPersonal: {
    minAccessCount: 5,
    minSalience: 0.6,
    minCrossSessionCount: 3,
  },
};

export function runTierPromotion(
  db: ChatLoggerDb,
  maxPromotions: number = 20,
): TierPromotionResult {
  const result: TierPromotionResult = {
    sessionToProject: 0,
    projectToPersonal: 0,
  };

  const sessionCandidates = db.getPromotionCandidates(
    "session",
    TIER_PROMOTION_THRESHOLDS.sessionToProject.minAccessCount,
    TIER_PROMOTION_THRESHOLDS.sessionToProject.minSalience,
    maxPromotions,
  );

  for (const memory of sessionCandidates) {
    if (result.sessionToProject >= maxPromotions / 2) break;

    const crossSessionCount = db.getCrossSessionMemoryCount(memory.content);
    if (
      crossSessionCount >=
      TIER_PROMOTION_THRESHOLDS.sessionToProject.minCrossSessionCount
    ) {
      db.promoteMemoryTier(memory.id, "project");
      db.logConsolidation({
        action: "update",
        source_ids: [memory.id],
        result_id: memory.id,
        reason: `Promoted session→project (access=${memory.access_count}, salience=${memory.salience.toFixed(2)}, cross-session=${crossSessionCount})`,
      });
      result.sessionToProject++;
    }
  }

  const projectCandidates = db.getPromotionCandidates(
    "project",
    TIER_PROMOTION_THRESHOLDS.projectToPersonal.minAccessCount,
    TIER_PROMOTION_THRESHOLDS.projectToPersonal.minSalience,
    maxPromotions,
  );

  for (const memory of projectCandidates) {
    if (result.projectToPersonal >= maxPromotions / 2) break;

    const crossSessionCount = db.getCrossSessionMemoryCount(memory.content);
    if (
      crossSessionCount >=
      TIER_PROMOTION_THRESHOLDS.projectToPersonal.minCrossSessionCount
    ) {
      db.promoteMemoryTier(memory.id, "personal");
      db.logConsolidation({
        action: "update",
        source_ids: [memory.id],
        result_id: memory.id,
        reason: `Promoted project→personal (access=${memory.access_count}, salience=${memory.salience.toFixed(2)}, cross-session=${crossSessionCount})`,
      });
      result.projectToPersonal++;
    }
  }

  return result;
}
