import { ChatLoggerDb } from "../src/db";
import { getConsolidationStats, findSimilarMemories, runConsolidationPass, runTierPromotion } from "../src/consolidation";
import * as os from "os";
import * as path from "path";

const logDir = path.join(os.homedir(), ".local", "share", "opencode", "chat-logs");
const db = new ChatLoggerDb(logDir);

console.log("=== Consolidation Stats ===");
const stats = getConsolidationStats(db);
console.log(`Unconsolidated memories: ${stats.unconsolidated}`);
console.log(`Previous consolidations: ${stats.consolidated}`);
console.log(`Potential merges (similarity >= 0.8): ${stats.potentialMerges}`);

console.log("\n=== Similar Memory Pairs ===");
const pairs = findSimilarMemories(db, 0.75);
console.log(`Found ${pairs.length} pairs with similarity >= 0.75`);
for (const pair of pairs.slice(0, 5)) {
  console.log(`\n[${pair.similarity.toFixed(3)}]`);
  console.log(`  1: ${pair.memory1.content.substring(0, 80)}...`);
  console.log(`  2: ${pair.memory2.content.substring(0, 80)}...`);
}

if (pairs.length > 0) {
  console.log("\n=== Running Consolidation (dry run preview) ===");
  console.log("Would merge the most similar pairs...");
  
  console.log("\n=== Running Actual Consolidation ===");
  const result = runConsolidationPass(db, 3);
  console.log(`Merged: ${result.merged}`);
  
  console.log("\n=== Running Tier Promotion ===");
  const promotionResult = runTierPromotion(db, 5);
  console.log(`Session → Project: ${promotionResult.sessionToProject}`);
  console.log(`Project → Personal: ${promotionResult.projectToPersonal}`);
}

db.close();
