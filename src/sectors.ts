import type { Sector } from "./db";
import { SECTOR_DECAY_RATES } from "./db";

export interface ClassificationResult {
  sector: Sector;
  confidence: number;
  secondarySectors: Sector[];
}

interface SectorPattern {
  sector: Sector;
  patterns: RegExp[];
  keywords: string[];
}

const SECTOR_PATTERNS: SectorPattern[] = [
  {
    sector: "code_change",
    patterns: [
      /\b(edit|modify|change|update|refactor|rename|move|delete|add|create|implement)\b.*\b(file|function|class|method|variable|component|module)\b/i,
      /\b(fixed|updated|changed|modified|added|removed|deleted)\b/i,
      /\.(ts|tsx|js|jsx|py|rs|go|java|c|cpp|h|hpp|rb|php|swift|kt)\b/i,
      /\b(commit|push|pull|merge|rebase|branch)\b/i,
      /\b(src|lib|packages?|components?)\//i,
    ],
    keywords: [
      "edit",
      "write",
      "modify",
      "change",
      "update",
      "refactor",
      "rename",
      "implement",
      "add",
      "create",
      "delete",
      "remove",
      "fix",
      "patch",
      "commit",
      "push",
      "merge",
      "diff",
      "file",
      "function",
      "class",
    ],
  },
  {
    sector: "debugging",
    patterns: [
      /\b(error|bug|issue|problem|crash|fail|broken|wrong|unexpected)\b/i,
      /\b(debug|trace|log|stack\s*trace|exception|throw|catch)\b/i,
      /\b(fix|solve|resolve|investigate|diagnose|troubleshoot)\b.*\b(error|bug|issue|problem)\b/i,
      /\bTypeError|ReferenceError|SyntaxError|RuntimeError\b/i,
      /\b(null|undefined|NaN)\s*(error|exception|reference)?\b/i,
      /\bsegfault|segmentation\s*fault|core\s*dump\b/i,
    ],
    keywords: [
      "error",
      "bug",
      "issue",
      "problem",
      "crash",
      "fail",
      "broken",
      "debug",
      "trace",
      "stack",
      "exception",
      "fix",
      "solve",
      "investigate",
      "diagnose",
      "troubleshoot",
      "undefined",
      "null",
      "NaN",
    ],
  },
  {
    sector: "architecture",
    patterns: [
      /\b(design|architect|structure|pattern|system|infrastructure)\b/i,
      /\b(microservice|monolith|serverless|distributed|scalab)\b/i,
      /\b(database|schema|model|entity|relation|migration)\b/i,
      /\b(api|endpoint|route|controller|service|repository)\b/i,
      /\b(dependency|injection|interface|abstract|inheritance)\b/i,
      /\b(tradeoff|decision|approach|strategy|plan)\b/i,
    ],
    keywords: [
      "design",
      "architecture",
      "structure",
      "pattern",
      "system",
      "infrastructure",
      "database",
      "schema",
      "api",
      "interface",
      "dependency",
      "tradeoff",
      "decision",
      "approach",
      "strategy",
      "scalable",
      "maintainable",
      "modular",
      "layer",
      "tier",
    ],
  },
  {
    sector: "discussion",
    patterns: [
      /\b(think|consider|opinion|suggest|recommend|prefer|believe)\b/i,
      /\b(what\s+if|how\s+about|should\s+we|could\s+we|would\s+it)\b/i,
      /\b(explain|clarify|understand|meaning|context|background)\b/i,
      /\b(pros?\s+and\s+cons?|advantages?|disadvantages?|benefits?)\b/i,
      /\?\s*$/m,
    ],
    keywords: [
      "think",
      "consider",
      "opinion",
      "suggest",
      "recommend",
      "prefer",
      "explain",
      "clarify",
      "understand",
      "question",
      "discuss",
      "pros",
      "cons",
      "advantage",
      "disadvantage",
      "alternative",
    ],
  },
  {
    sector: "procedural",
    patterns: [
      /\b(step|process|procedure|workflow|pipeline|instruction)\b/i,
      /\b(first|then|next|after|finally|before)\b.*\b(do|run|execute|perform)\b/i,
      /\b(install|setup|configure|deploy|build|test|run)\b/i,
      /\b(command|script|terminal|shell|bash|npm|yarn|bun|pip|cargo)\b/i,
      /^\s*\d+\.\s+/m,
      /^\s*[-*]\s+/m,
    ],
    keywords: [
      "step",
      "process",
      "procedure",
      "workflow",
      "pipeline",
      "install",
      "setup",
      "configure",
      "deploy",
      "build",
      "test",
      "command",
      "script",
      "run",
      "execute",
      "instruction",
      "guide",
    ],
  },
  {
    sector: "emotional",
    patterns: [
      /\b(frustrat|annoy|angry|upset|confus|stuck|lost|overwhelm)\w*/i,
      /\b(excit|happy|great|awesome|love|enjoy|satisf|proud)\w*/i,
      /\b(worried|concern|anxious|nervous|uncertain|doubt)\w*/i,
      /\b(bored|tired|exhaust|burnt?\s*out)\w*/i,
      /\b(thank|grateful|appreciate)\w*/i,
      /[!]{2,}|\?{2,}/,
      /\b(ugh|argh|yay|wow|omg|wtf)\b/i,
    ],
    keywords: [
      "frustrated",
      "annoyed",
      "confused",
      "stuck",
      "lost",
      "overwhelmed",
      "excited",
      "happy",
      "great",
      "awesome",
      "love",
      "worried",
      "concerned",
      "anxious",
      "tired",
      "exhausted",
      "grateful",
      "thanks",
      "appreciate",
    ],
  },
];

function countPatternMatches(content: string, patterns: RegExp[]): number {
  return patterns.reduce((count, pattern) => {
    const matches = content.match(new RegExp(pattern, "gi"));
    return count + (matches ? matches.length : 0);
  }, 0);
}

function countKeywordMatches(content: string, keywords: string[]): number {
  const lower = content.toLowerCase();
  return keywords.reduce((count, keyword) => {
    const regex = new RegExp(`\\b${keyword}\\b`, "gi");
    const matches = lower.match(regex);
    return count + (matches ? matches.length : 0);
  }, 0);
}

export function classifySector(content: string): ClassificationResult {
  const scores: Array<{ sector: Sector; score: number }> = [];

  for (const sp of SECTOR_PATTERNS) {
    const patternScore = countPatternMatches(content, sp.patterns);
    const keywordScore = countKeywordMatches(content, sp.keywords);
    const totalScore = patternScore * 2 + keywordScore;
    scores.push({ sector: sp.sector, score: totalScore });
  }

  scores.sort((a, b) => b.score - a.score);

  const topScore = scores[0].score;
  const totalScore = scores.reduce((sum, s) => sum + s.score, 0);

  const confidence = totalScore > 0 ? topScore / totalScore : 0.2;

  const secondarySectors = scores
    .slice(1)
    .filter((s) => s.score > topScore * 0.3)
    .map((s) => s.sector);

  return {
    sector: scores[0].sector,
    confidence: Math.min(confidence, 1.0),
    secondarySectors,
  };
}

export function classifyFromToolCall(
  tool: string,
  args: Record<string, unknown>,
): ClassificationResult {
  const editTools = [
    "edit",
    "write",
    "Edit",
    "Write",
    "multiEdit",
    "ast_grep_replace",
  ];
  const readTools = [
    "read",
    "Read",
    "glob",
    "Glob",
    "grep",
    "Grep",
    "ast_grep_search",
  ];
  const bashTools = ["bash", "Bash", "shell", "terminal"];
  const debugTools = [
    "lsp_diagnostics",
    "cargo_check",
    "cargo_clippy",
    "cargo_test",
  ];

  if (editTools.includes(tool)) {
    return { sector: "code_change", confidence: 0.9, secondarySectors: [] };
  }

  if (debugTools.includes(tool)) {
    return {
      sector: "debugging",
      confidence: 0.8,
      secondarySectors: ["code_change"],
    };
  }

  if (bashTools.includes(tool)) {
    const command = String(args.command || "");
    if (
      /\b(npm|yarn|bun|pip|cargo)\s+(install|add|build|test)\b/.test(command)
    ) {
      return { sector: "procedural", confidence: 0.8, secondarySectors: [] };
    }
    if (/\b(git)\s+(commit|push|pull|merge)\b/.test(command)) {
      return { sector: "code_change", confidence: 0.7, secondarySectors: [] };
    }
  }

  if (readTools.includes(tool)) {
    return {
      sector: "discussion",
      confidence: 0.5,
      secondarySectors: ["code_change"],
    };
  }

  return { sector: "discussion", confidence: 0.3, secondarySectors: [] };
}

export function getSectorDecayRate(sector: Sector): number {
  return SECTOR_DECAY_RATES[sector];
}

export function estimateInitialSalience(
  content: string,
  sector: Sector,
  metadata?: {
    isUserMessage?: boolean;
    hasCodeBlock?: boolean;
    toolCount?: number;
  },
): number {
  let salience = 0.5;

  if (metadata?.isUserMessage) {
    salience += 0.1;
  }

  if (metadata?.hasCodeBlock) {
    salience += 0.15;
  }

  if (metadata?.toolCount && metadata.toolCount > 0) {
    salience += Math.min(metadata.toolCount * 0.05, 0.2);
  }

  if (sector === "architecture") {
    salience += 0.1;
  } else if (sector === "code_change") {
    salience += 0.05;
  }

  if (content.length > 1000) {
    salience += 0.05;
  }

  return Math.min(salience, 1.0);
}

export function getAllSectors(): Sector[] {
  return [
    "code_change",
    "debugging",
    "architecture",
    "discussion",
    "procedural",
    "emotional",
  ];
}
