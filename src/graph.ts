import type { ChatLoggerDb, DbMemory, Sector } from "./db";
import type { EmbeddingProvider } from "./embedding";
import { cosineSimilarity, meanVector } from "./embedding";

export interface WaypointCandidate {
  memoryId: string;
  similarity: number;
}

export const WAYPOINT_SIMILARITY_THRESHOLD = 0.75;
export const MAX_WAYPOINTS_PER_MEMORY = 5;

export async function findWaypointCandidates(
  db: ChatLoggerDb,
  memoryId: string,
  threshold: number = WAYPOINT_SIMILARITY_THRESHOLD,
): Promise<WaypointCandidate[]> {
  const memory = db.getMemory(memoryId);
  if (!memory) return [];

  const memoryVectors = db.getMemoryVectors(memoryId);
  if (memoryVectors.length === 0) return [];

  const memoryMean = meanVector(memoryVectors.map((v) => v.vector));

  const allMemories = db.getAllMemoriesWithVectors();
  const candidates: WaypointCandidate[] = [];

  for (const other of allMemories) {
    if (other.id === memoryId) continue;
    if (other.vectors.length === 0) continue;

    const otherMean = meanVector(other.vectors.map((v) => v.vector));
    const similarity = cosineSimilarity(memoryMean, otherMean);

    if (similarity >= threshold) {
      candidates.push({ memoryId: other.id, similarity });
    }
  }

  candidates.sort((a, b) => b.similarity - a.similarity);
  return candidates.slice(0, MAX_WAYPOINTS_PER_MEMORY);
}

export async function createWaypointsForMemory(
  db: ChatLoggerDb,
  memoryId: string,
  threshold: number = WAYPOINT_SIMILARITY_THRESHOLD,
): Promise<number> {
  const candidates = await findWaypointCandidates(db, memoryId, threshold);

  for (const candidate of candidates) {
    db.insertWaypoint(memoryId, candidate.memoryId, candidate.similarity);
    db.insertWaypoint(candidate.memoryId, memoryId, candidate.similarity);
  }

  return candidates.length;
}

export interface GraphNode {
  id: string;
  memory: DbMemory;
  depth: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  weight: number;
}

export interface MemoryGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function traverseFromMemory(
  db: ChatLoggerDb,
  startId: string,
  maxDepth: number = 2,
  maxNodes: number = 20,
): MemoryGraph {
  const visited = new Set<string>();
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const queue: Array<{ id: string; depth: number }> = [
    { id: startId, depth: 0 },
  ];

  while (queue.length > 0 && nodes.length < maxNodes) {
    const current = queue.shift()!;
    if (visited.has(current.id)) continue;

    visited.add(current.id);
    const memory = db.getMemory(current.id);
    if (!memory) continue;

    nodes.push({ id: current.id, memory, depth: current.depth });

    if (current.depth < maxDepth) {
      const waypoints = db.getWaypoints(current.id);
      for (const wp of waypoints) {
        if (!visited.has(wp.dst_memory_id)) {
          queue.push({ id: wp.dst_memory_id, depth: current.depth + 1 });
          edges.push({
            source: current.id,
            target: wp.dst_memory_id,
            weight: wp.weight,
          });
        }
      }
    }
  }

  return { nodes, edges };
}

export function findRelatedMemories(
  db: ChatLoggerDb,
  memoryId: string,
  limit: number = 10,
): DbMemory[] {
  const graph = traverseFromMemory(db, memoryId, 2, limit + 1);
  return graph.nodes
    .filter((n) => n.id !== memoryId)
    .sort((a, b) => a.depth - b.depth)
    .slice(0, limit)
    .map((n) => n.memory);
}

export function getSessionGraph(
  db: ChatLoggerDb,
  sessionId: string,
): MemoryGraph {
  const memories = db.getMemoriesBySession(sessionId);
  const nodes: GraphNode[] = memories.map((m) => ({
    id: m.id,
    memory: m,
    depth: 0,
  }));
  const edges: GraphEdge[] = [];
  const memoryIds = new Set(memories.map((m) => m.id));

  for (const memory of memories) {
    const waypoints = db.getWaypoints(memory.id);
    for (const wp of waypoints) {
      if (memoryIds.has(wp.dst_memory_id)) {
        edges.push({
          source: memory.id,
          target: wp.dst_memory_id,
          weight: wp.weight,
        });
      }
    }
  }

  return { nodes, edges };
}

export async function rebuildAllWaypoints(
  db: ChatLoggerDb,
  threshold: number = WAYPOINT_SIMILARITY_THRESHOLD,
  onProgress?: (current: number, total: number) => void,
): Promise<{ processed: number; waypointsCreated: number }> {
  const allMemories = db.getAllMemoriesWithVectors();
  let waypointsCreated = 0;

  for (let i = 0; i < allMemories.length; i++) {
    const memory = allMemories[i];
    const count = await createWaypointsForMemory(db, memory.id, threshold);
    waypointsCreated += count;

    if (onProgress) {
      onProgress(i + 1, allMemories.length);
    }
  }

  return { processed: allMemories.length, waypointsCreated };
}

export function getClusterCenters(
  db: ChatLoggerDb,
  bySector: boolean = true,
): Map<Sector | "all", DbMemory[]> {
  const clusters = new Map<Sector | "all", DbMemory[]>();
  const memories = db.getAllMemoriesWithVectors();

  if (bySector) {
    const bySectorMap = new Map<Sector, typeof memories>();
    for (const m of memories) {
      const existing = bySectorMap.get(m.sector) || [];
      existing.push(m);
      bySectorMap.set(m.sector, existing);
    }

    for (const [sector, sectorMemories] of bySectorMap) {
      const sorted = sectorMemories.sort((a, b) => {
        const aWaypoints = db.getWaypoints(a.id).length;
        const bWaypoints = db.getWaypoints(b.id).length;
        return bWaypoints - aWaypoints;
      });
      clusters.set(sector, sorted.slice(0, 5));
    }
  } else {
    const sorted = memories.sort((a, b) => {
      const aWaypoints = db.getWaypoints(a.id).length;
      const bWaypoints = db.getWaypoints(b.id).length;
      return bWaypoints - aWaypoints;
    });
    clusters.set("all", sorted.slice(0, 10));
  }

  return clusters;
}
