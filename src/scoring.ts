import type { DbMemory, ChatLoggerDb, Sector } from "./db";
import type { EmbeddingProvider } from "./embedding";
import { cosineSimilarity } from "./embedding";

export interface ScoringWeights {
  similarity: number;
  salience: number;
  recency: number;
  waypoint: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  similarity: 0.6,
  salience: 0.2,
  recency: 0.1,
  waypoint: 0.1,
};

export interface ScoredMemory {
  memory: DbMemory;
  similarity: number;
  effectiveSalience: number;
  recencyScore: number;
  waypointBoost: number;
  compositeScore: number;
}

export function calculateDecayedSalience(memory: DbMemory): number {
  const daysSinceAccess =
    (Date.now() - new Date(memory.last_accessed).getTime()) /
    (1000 * 60 * 60 * 24);
  return memory.salience * Math.exp(-memory.decay_lambda * daysSinceAccess);
}

export function calculateRecencyScore(
  memory: DbMemory,
  maxDays: number = 30,
): number {
  const daysSinceAccess =
    (Date.now() - new Date(memory.last_accessed).getTime()) /
    (1000 * 60 * 60 * 24);
  return Math.max(0, 1 - daysSinceAccess / maxDays);
}

export function calculateWaypointBoost(
  db: ChatLoggerDb,
  memoryId: string,
  retrievedIds: Set<string>,
): number {
  const waypoints = db.getWaypoints(memoryId);
  if (waypoints.length === 0) return 0;

  let boost = 0;
  for (const wp of waypoints) {
    if (retrievedIds.has(wp.dst_memory_id)) {
      boost += wp.weight * 0.1;
    }
  }

  return Math.min(boost, 0.5);
}

export async function scoreMemory(
  memory: DbMemory,
  queryVector: Float32Array,
  db: ChatLoggerDb,
  retrievedIds: Set<string>,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): Promise<ScoredMemory> {
  const vectors = db.getMemoryVectors(memory.id);

  let maxSimilarity = 0;
  for (const v of vectors) {
    const sim = cosineSimilarity(queryVector, v.vector);
    if (sim > maxSimilarity) maxSimilarity = sim;
  }

  const effectiveSalience = calculateDecayedSalience(memory);
  const recencyScore = calculateRecencyScore(memory);
  const waypointBoost = calculateWaypointBoost(db, memory.id, retrievedIds);

  const compositeScore =
    weights.similarity * maxSimilarity +
    weights.salience * effectiveSalience +
    weights.recency * recencyScore +
    weights.waypoint * waypointBoost;

  return {
    memory,
    similarity: maxSimilarity,
    effectiveSalience,
    recencyScore,
    waypointBoost,
    compositeScore,
  };
}

export interface SearchOptions {
  limit?: number;
  minSimilarity?: number;
  minSalience?: number;
  sectors?: Sector[];
  weights?: ScoringWeights;
  includeWaypointExpansion?: boolean;
}

export async function searchMemories(
  db: ChatLoggerDb,
  embedder: EmbeddingProvider,
  query: string,
  options: SearchOptions = {},
): Promise<ScoredMemory[]> {
  const {
    limit = 10,
    minSimilarity = 0.3,
    minSalience = 0.01,
    sectors,
    weights = DEFAULT_WEIGHTS,
    includeWaypointExpansion = true,
  } = options;

  const queryVector = await embedder.embed(query);
  const allMemories = db.getAllMemoriesWithVectors();

  const candidateMemories = allMemories.filter((m) => {
    if (sectors && !sectors.includes(m.sector)) return false;
    const effectiveSalience = calculateDecayedSalience(m);
    return effectiveSalience >= minSalience;
  });

  const retrievedIds = new Set<string>();
  const scoredMemories: ScoredMemory[] = [];

  for (const memory of candidateMemories) {
    const scored = await scoreMemory(
      memory,
      queryVector,
      db,
      retrievedIds,
      weights,
    );
    if (scored.similarity >= minSimilarity) {
      scoredMemories.push(scored);
      retrievedIds.add(memory.id);
    }
  }

  scoredMemories.sort((a, b) => b.compositeScore - a.compositeScore);

  if (includeWaypointExpansion && scoredMemories.length > 0) {
    const topMemoryIds = new Set(
      scoredMemories.slice(0, 5).map((s) => s.memory.id),
    );

    for (const scored of scoredMemories.slice(0, 5)) {
      const waypoints = db.getWaypoints(scored.memory.id);
      for (const wp of waypoints) {
        if (!retrievedIds.has(wp.dst_memory_id)) {
          const linkedMemory = db.getMemory(wp.dst_memory_id);
          if (linkedMemory) {
            const linkedScored = await scoreMemory(
              linkedMemory,
              queryVector,
              db,
              topMemoryIds,
              weights,
            );
            linkedScored.waypointBoost += wp.weight * 0.15;
            linkedScored.compositeScore =
              weights.similarity * linkedScored.similarity +
              weights.salience * linkedScored.effectiveSalience +
              weights.recency * linkedScored.recencyScore +
              weights.waypoint * linkedScored.waypointBoost;

            scoredMemories.push(linkedScored);
            retrievedIds.add(wp.dst_memory_id);
          }
        }
      }
    }

    scoredMemories.sort((a, b) => b.compositeScore - a.compositeScore);
  }

  return scoredMemories.slice(0, limit);
}

export function reinforceRetrievedMemories(
  db: ChatLoggerDb,
  memories: ScoredMemory[],
  salienceBoost: number = 0.1,
): void {
  const retrievedIds = new Set(memories.map((m) => m.memory.id));

  for (const scored of memories) {
    db.reinforceMemory(scored.memory.id, salienceBoost);

    const waypoints = db.getWaypoints(scored.memory.id);
    for (const wp of waypoints) {
      if (retrievedIds.has(wp.dst_memory_id)) {
        db.boostWaypointWeight(scored.memory.id, wp.dst_memory_id, 0.05);
      }
    }
  }
}

export function formatMemoriesForContext(
  memories: ScoredMemory[],
  maxChars: number = 4000,
): string {
  const lines: string[] = [];
  let charCount = 0;

  for (const scored of memories) {
    const line = `[${scored.memory.sector}] ${scored.memory.content.substring(0, 200)}${scored.memory.content.length > 200 ? "..." : ""}`;

    if (charCount + line.length > maxChars) break;

    lines.push(line);
    charCount += line.length;
  }

  return lines.join("\n\n");
}
