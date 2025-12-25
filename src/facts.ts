import type { Sector } from "./db";

export interface ExtractedFact {
  content: string;
  sector: Sector;
  confidence: number;
  validFrom?: string;
  validTo?: string;
}

interface FactPattern {
  pattern: RegExp;
  sector: Sector;
  confidence: number;
  extractFact: (match: RegExpExecArray) => string;
}

const FACT_PATTERNS: FactPattern[] = [
  // === Decision Patterns ===
  {
    pattern: /\b(?:we|I)\s+(?:decided|chose|agreed)\s+to\s+(.+?)(?:\.|$)/gi,
    sector: "architecture",
    confidence: 0.9,
    extractFact: (m) => `Decision: ${m[1].trim()}`,
  },
  {
    pattern:
      /\b(?:going\s+)?(?:forward|from\s+now\s+on),?\s+(?:we|I)?\s*(?:will|should|'ll)\s+(.+?)(?:\.|$)/gi,
    sector: "architecture",
    confidence: 0.85,
    extractFact: (m) => `Decision: ${m[1].trim()}`,
  },
  {
    pattern:
      /\blet'?s?\s+(?:go\s+with|use|stick\s+with)\s+(.+?)(?:\s+because|\s+since|\.|$)/gi,
    sector: "architecture",
    confidence: 0.8,
    extractFact: (m) => `Decision: use ${m[1].trim()}`,
  },

  // === Project/Codebase Patterns ===
  {
    pattern:
      /\b(?:the|this)\s+(?:project|codebase|repo(?:sitory)?)\s+uses?\s+(.+?)(?:\s+for|\.|$)/gi,
    sector: "architecture",
    confidence: 0.85,
    extractFact: (m) => `Project uses ${m[1].trim()}`,
  },
  {
    pattern:
      /\b(?:the|this)\s+(?:project|codebase)\s+(?:is\s+)?(?:built\s+with|based\s+on|written\s+in)\s+(.+?)(?:\.|$)/gi,
    sector: "architecture",
    confidence: 0.85,
    extractFact: (m) => `Project built with ${m[1].trim()}`,
  },
  {
    pattern:
      /\b(?:we|this\s+project)\s+(?:follow|use)s?\s+(?:the\s+)?(.+?)\s+(?:pattern|convention|style)(?:\.|$)/gi,
    sector: "architecture",
    confidence: 0.8,
    extractFact: (m) => `Convention: ${m[1].trim()} pattern`,
  },

  // === Avoidance/Prohibition Patterns ===
  {
    pattern:
      /\b(?:don't|do\s+not|never|avoid)\s+(.+?)(?:\s+because|\s+since|\s+as\s+it|\.|$)/gi,
    sector: "architecture",
    confidence: 0.8,
    extractFact: (m) => `Avoid: ${m[1].trim()}`,
  },
  {
    pattern:
      /\b(?:shouldn't|should\s+not|must\s+not|cannot|can't)\s+(.+?)(?:\s+because|\s+since|\.|$)/gi,
    sector: "architecture",
    confidence: 0.8,
    extractFact: (m) => `Avoid: ${m[1].trim()}`,
  },

  // === Rule/Requirement Patterns ===
  {
    pattern:
      /\b(?:always|must|should|need\s+to)\s+(.+?)(?:\s+when|\s+before|\s+after|\s+if|\.|$)/gi,
    sector: "procedural",
    confidence: 0.75,
    extractFact: (m) => `Rule: ${m[1].trim()}`,
  },
  {
    pattern:
      /\b(?:make\s+sure|ensure|remember)\s+(?:to\s+)?(.+?)(?:\s+when|\s+before|\s+after|\.|$)/gi,
    sector: "procedural",
    confidence: 0.75,
    extractFact: (m) => `Rule: ${m[1].trim()}`,
  },
  {
    pattern: /\brequires?\s+(.+?)\s+(?:to\s+be|before|in\s+order)(?:\.|$)/gi,
    sector: "procedural",
    confidence: 0.8,
    extractFact: (m) => `Requirement: ${m[1].trim()}`,
  },

  // === Debugging Patterns ===
  {
    pattern:
      /\b(?:the\s+)?(?:bug|issue|problem|error)\s+(?:was|is)\s+(?:caused\s+by|due\s+to)\s+(.+?)(?:\.|$)/gi,
    sector: "debugging",
    confidence: 0.85,
    extractFact: (m) => `Root cause: ${m[1].trim()}`,
  },
  {
    pattern:
      /\b(?:fixed|resolved|solved)\s+(?:by|with|using)\s+(.+?)(?:\.|$)/gi,
    sector: "debugging",
    confidence: 0.8,
    extractFact: (m) => `Solution: ${m[1].trim()}`,
  },
  {
    pattern:
      /\bthe\s+(?:fix|solution)\s+(?:is|was)\s+(?:to\s+)?(.+?)(?:\.|$)/gi,
    sector: "debugging",
    confidence: 0.85,
    extractFact: (m) => `Solution: ${m[1].trim()}`,
  },
  {
    pattern: /\bworkaround(?:\s+is)?\s*[:-]?\s*(.+?)(?:\.|$)/gi,
    sector: "debugging",
    confidence: 0.85,
    extractFact: (m) => `Workaround: ${m[1].trim()}`,
  },
  {
    pattern:
      /\b(?:this|the)\s+(?:happens|occurs|fails)\s+(?:when|if|because)\s+(.+?)(?:\.|$)/gi,
    sector: "debugging",
    confidence: 0.75,
    extractFact: (m) => `Failure condition: ${m[1].trim()}`,
  },

  // === Location Patterns ===
  {
    pattern:
      /\b(\w+)\s+(?:is|are)\s+(?:located|found|defined)\s+(?:in|at)\s+([^\s.]+)/gi,
    sector: "code_change",
    confidence: 0.7,
    extractFact: (m) => `${m[1]} is located in ${m[2]}`,
  },
  {
    pattern:
      /\b(?:the|this)\s+(\w+)\s+(?:lives?|resides?)\s+(?:in|at|under)\s+([^\s.]+)/gi,
    sector: "code_change",
    confidence: 0.7,
    extractFact: (m) => `${m[1]} is located in ${m[2]}`,
  },

  // === Command/Procedure Patterns ===
  {
    pattern: /\b(?:run|execute|use)\s+`([^`]+)`\s+to\s+(.+?)(?:\.|$)/gi,
    sector: "procedural",
    confidence: 0.85,
    extractFact: (m) => `Command \`${m[1]}\` to ${m[2].trim()}`,
  },
  {
    pattern: /\bto\s+(.+?),?\s+(?:run|execute|use)\s+`([^`]+)`/gi,
    sector: "procedural",
    confidence: 0.85,
    extractFact: (m) => `Command \`${m[2]}\` to ${m[1].trim()}`,
  },
  {
    pattern: /\b`([^`]+)`\s+(?:will|should|can)\s+(.+?)(?:\.|$)/gi,
    sector: "procedural",
    confidence: 0.75,
    extractFact: (m) => `Command \`${m[1]}\` will ${m[2].trim()}`,
  },

  // === API Patterns ===
  {
    pattern:
      /\b(?:the\s+)?(\w+)\s+(?:endpoint|API)\s+(?:returns?|expects?|accepts?)\s+(.+?)(?:\.|$)/gi,
    sector: "architecture",
    confidence: 0.8,
    extractFact: (m) => `${m[1]} API: ${m[2].trim()}`,
  },
  {
    pattern:
      /\b(?:the\s+)?(\w+)\s+(?:endpoint|route)\s+is\s+(?:at\s+)?[`"]?([^`"\s]+)[`"]?/gi,
    sector: "architecture",
    confidence: 0.85,
    extractFact: (m) => `${m[1]} endpoint: ${m[2]}`,
  },

  // === Configuration Patterns ===
  {
    pattern: /\b(?:port|PORT)\s*[=:]\s*(\d+)/gi,
    sector: "procedural",
    confidence: 0.9,
    extractFact: (m) => `Port configuration: ${m[1]}`,
  },
  {
    pattern:
      /\b(?:version|VERSION)\s*[=:]\s*["']?([0-9]+\.[0-9]+(?:\.[0-9]+)?)/gi,
    sector: "procedural",
    confidence: 0.9,
    extractFact: (m) => `Version: ${m[1]}`,
  },
  {
    pattern:
      /\b(\w+_(?:URL|KEY|SECRET|TOKEN|ID|PATH))\s*[=:]\s*["']?([^\s"']+)/gi,
    sector: "procedural",
    confidence: 0.85,
    extractFact: (m) => `Config ${m[1]}: ${m[2]}`,
  },
  {
    pattern: /\bset\s+(\w+)\s+to\s+["']?([^"'\s]+)["']?/gi,
    sector: "procedural",
    confidence: 0.75,
    extractFact: (m) => `Setting: ${m[1]} = ${m[2]}`,
  },

  // === Preference Patterns ===
  {
    pattern: /\b(?:prefer|recommended?)\s+(.+?)\s+over\s+(.+?)(?:\.|$)/gi,
    sector: "architecture",
    confidence: 0.8,
    extractFact: (m) => `Prefer ${m[1].trim()} over ${m[2].trim()}`,
  },
  {
    pattern:
      /\b(?:better|best)\s+(?:to\s+)?(?:use|approach)\s+(?:is\s+)?(.+?)(?:\s+rather|\s+instead|\.|$)/gi,
    sector: "architecture",
    confidence: 0.75,
    extractFact: (m) => `Best practice: ${m[1].trim()}`,
  },

  // === Dependency Patterns ===
  {
    pattern:
      /\b(\w+)\s+(?:depends?\s+on|requires?|needs?)\s+(\w+)(?:\s+to|\.|$)/gi,
    sector: "architecture",
    confidence: 0.8,
    extractFact: (m) => `Dependency: ${m[1]} requires ${m[2]}`,
  },
  {
    pattern:
      /\b(?:install|add)\s+(\w+(?:[-/]\w+)?)\s+(?:as\s+a\s+)?(?:dependency|dep)/gi,
    sector: "procedural",
    confidence: 0.85,
    extractFact: (m) => `Dependency: ${m[1]}`,
  },
  {
    pattern:
      /\busing\s+(\w+(?:[-/]\w+)?)\s+(?:version\s+)?([0-9]+\.[0-9]+(?:\.[0-9]+)?)/gi,
    sector: "procedural",
    confidence: 0.85,
    extractFact: (m) => `Dependency: ${m[1]} v${m[2]}`,
  },

  // === Limitation/Constraint Patterns ===
  {
    pattern: /\b(?:limitation|constraint|caveat|gotcha)[:\s]+(.+?)(?:\.|$)/gi,
    sector: "architecture",
    confidence: 0.85,
    extractFact: (m) => `Limitation: ${m[1].trim()}`,
  },
  {
    pattern: /\bnote\s+that\s+(.+?)(?:\.|$)/gi,
    sector: "architecture",
    confidence: 0.7,
    extractFact: (m) => `Note: ${m[1].trim()}`,
  },
  {
    pattern:
      /\b(?:be\s+aware|watch\s+out|careful)\s+(?:that\s+)?(.+?)(?:\.|$)/gi,
    sector: "debugging",
    confidence: 0.75,
    extractFact: (m) => `Caveat: ${m[1].trim()}`,
  },
  {
    pattern:
      /\b(?:this|it)\s+(?:only|doesn't)\s+(?:works?|support)\s+(.+?)(?:\.|$)/gi,
    sector: "architecture",
    confidence: 0.75,
    extractFact: (m) => `Limitation: ${m[1].trim()}`,
  },

  // === Deprecation/Breaking Change Patterns ===
  {
    pattern:
      /\b(\w+)\s+(?:is|was)\s+deprecated(?:\s+in\s+favor\s+of\s+(.+?))?(?:\.|$)/gi,
    sector: "architecture",
    confidence: 0.9,
    extractFact: (m) =>
      m[2] ? `Deprecated: ${m[1]} → ${m[2].trim()}` : `Deprecated: ${m[1]}`,
  },
  {
    pattern: /\bbreaking\s+change[:\s]+(.+?)(?:\.|$)/gi,
    sector: "architecture",
    confidence: 0.9,
    extractFact: (m) => `Breaking change: ${m[1].trim()}`,
  },
  {
    pattern:
      /\b(?:removed|deleted)\s+(.+?)\s+(?:in\s+)?(?:v|version\s+)?([0-9]+\.[0-9]+)/gi,
    sector: "architecture",
    confidence: 0.85,
    extractFact: (m) => `Removed in v${m[2]}: ${m[1].trim()}`,
  },

  // === Performance Patterns ===
  {
    pattern: /\b(?:for\s+)?(?:better\s+)?performance,?\s+(.+?)(?:\.|$)/gi,
    sector: "architecture",
    confidence: 0.75,
    extractFact: (m) => `Performance: ${m[1].trim()}`,
  },
  {
    pattern:
      /\b(\w+)\s+is\s+(?:slow|fast|expensive|cheap)\s+(?:because|when)\s+(.+?)(?:\.|$)/gi,
    sector: "architecture",
    confidence: 0.75,
    extractFact: (m) => `Performance: ${m[1]} - ${m[2].trim()}`,
  },

  // === Security Patterns ===
  {
    pattern:
      /\b(?:security\s+)?(?:risk|vulnerability|concern)[:\s]+(.+?)(?:\.|$)/gi,
    sector: "architecture",
    confidence: 0.85,
    extractFact: (m) => `Security: ${m[1].trim()}`,
  },
  {
    pattern:
      /\b(?:never|don't)\s+(?:expose|store|commit)\s+(.+?)\s+(?:in|to)(?:\.|$)/gi,
    sector: "architecture",
    confidence: 0.9,
    extractFact: (m) => `Security: never expose ${m[1].trim()}`,
  },

  // === Type/Interface Patterns ===
  {
    pattern:
      /\b(\w+)\s+(?:type|interface)\s+(?:is|has|contains)\s+(.+?)(?:\.|$)/gi,
    sector: "code_change",
    confidence: 0.75,
    extractFact: (m) => `Type ${m[1]}: ${m[2].trim()}`,
  },
  {
    pattern: /\b(\w+)\s+(?:should\s+be|is)\s+(?:of\s+)?type\s+(\w+)/gi,
    sector: "code_change",
    confidence: 0.8,
    extractFact: (m) => `Type: ${m[1]} is ${m[2]}`,
  },

  // === Refactoring Patterns ===
  {
    pattern: /\brefactored?\s+(.+?)\s+(?:to|into)\s+(.+?)(?:\.|$)/gi,
    sector: "code_change",
    confidence: 0.8,
    extractFact: (m) => `Refactored: ${m[1].trim()} → ${m[2].trim()}`,
  },
  {
    pattern: /\brenamed?\s+(\w+)\s+to\s+(\w+)/gi,
    sector: "code_change",
    confidence: 0.85,
    extractFact: (m) => `Renamed: ${m[1]} → ${m[2]}`,
  },
  {
    pattern: /\bmoved?\s+(.+?)\s+(?:from\s+)?(\S+)\s+to\s+(\S+)/gi,
    sector: "code_change",
    confidence: 0.8,
    extractFact: (m) => `Moved: ${m[1].trim()} from ${m[2]} to ${m[3]}`,
  },

  // === Default Value Patterns ===
  {
    pattern: /\bdefaults?\s+to\s+["']?([^"'\s]+)["']?/gi,
    sector: "procedural",
    confidence: 0.8,
    extractFact: (m) => `Default value: ${m[1]}`,
  },
  {
    pattern:
      /\b(?:if\s+not\s+(?:set|specified|provided)),?\s+(?:it\s+)?(?:uses?|defaults?\s+to)\s+(.+?)(?:\.|$)/gi,
    sector: "procedural",
    confidence: 0.8,
    extractFact: (m) => `Default: ${m[1].trim()}`,
  },

  // === Environment Patterns ===
  {
    pattern: /\b(?:in|for)\s+(?:production|prod),?\s+(.+?)(?:\.|$)/gi,
    sector: "procedural",
    confidence: 0.75,
    extractFact: (m) => `Production: ${m[1].trim()}`,
  },
  {
    pattern: /\b(?:in|for)\s+(?:development|dev),?\s+(.+?)(?:\.|$)/gi,
    sector: "procedural",
    confidence: 0.75,
    extractFact: (m) => `Development: ${m[1].trim()}`,
  },
];

function deduplicateFacts(facts: ExtractedFact[]): ExtractedFact[] {
  const seen = new Map<string, ExtractedFact>();

  for (const fact of facts) {
    const key = fact.content.toLowerCase().substring(0, 100);
    const existing = seen.get(key);

    if (!existing || fact.confidence > existing.confidence) {
      seen.set(key, fact);
    }
  }

  return Array.from(seen.values());
}

export function extractFacts(text: string): ExtractedFact[] {
  const facts: ExtractedFact[] = [];

  for (const { pattern, sector, confidence, extractFact } of FACT_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      const factContent = extractFact(match);

      if (factContent.length < 10 || factContent.length > 500) continue;

      facts.push({
        content: factContent,
        sector,
        confidence,
      });
    }
  }

  return deduplicateFacts(facts);
}

export function extractFactsWithContext(
  text: string,
  sessionSector: Sector,
): ExtractedFact[] {
  const facts = extractFacts(text);

  return facts.map((fact) => ({
    ...fact,
    confidence:
      fact.sector === sessionSector ? fact.confidence : fact.confidence * 0.9,
  }));
}

interface FactSubject {
  subject: string;
  normalized: string;
}

function extractFactSubject(content: string): FactSubject | null {
  const patterns = [
    /^(?:Decision|Rule|Avoid|Prefer|Deprecated|Renamed|Refactored|Moved|Dependency|Config|Setting|Default|Port|Version):\s*(.+)/i,
    /^(.+?)\s+(?:is|are|was|were|uses?|requires?|depends?)/i,
    /^(?:the\s+)?(.+?)\s+(?:endpoint|API|type|interface)/i,
  ];

  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match?.[1]) {
      const subject = match[1].trim();
      const normalized = subject.toLowerCase().replace(/[^\w]/g, "");
      if (normalized.length > 2) {
        return { subject, normalized };
      }
    }
  }

  return null;
}

interface ContradictionPattern {
  pattern: RegExp;
  antiPatternTemplates: string[];
}

const CONTRADICTION_PATTERNS: ContradictionPattern[] = [
  {
    pattern: /^Prefer\s+(.+?)\s+over\s+(.+)$/i,
    antiPatternTemplates: ["^Prefer\\s+$2\\s+over\\s+$1$"],
  },
  {
    pattern: /^Decision:\s*use\s+(.+)$/i,
    antiPatternTemplates: [
      "^Avoid:\\s*$1",
      "^Decision:\\s*(?:don't|not)\\s+use\\s+$1",
    ],
  },
  {
    pattern: /^Avoid:\s*(.+)$/i,
    antiPatternTemplates: [
      "^Decision:\\s*use\\s+$1",
      "^Rule:\\s*(?:always\\s+)?$1",
    ],
  },
  {
    pattern: /^Port configuration:\s*(\d+)$/i,
    antiPatternTemplates: ["^Port configuration:\\s*(?!$1)\\d+$"],
  },
  {
    pattern: /^Version:\s*(.+)$/i,
    antiPatternTemplates: ["^Version:\\s*(?!$1).+$"],
  },
  {
    pattern: /^Default(?:\s+value)?:\s*(.+)$/i,
    antiPatternTemplates: ["^Default(?:\\s+value)?:\\s*(?!$1).+$"],
  },
  {
    pattern: /^(.+?)\s+is\s+located\s+in\s+(.+)$/i,
    antiPatternTemplates: ["^$1\\s+is\\s+located\\s+in\\s+(?!$2).+$"],
  },
  {
    pattern: /^Renamed:\s*(.+?)\s+→\s+(.+)$/i,
    antiPatternTemplates: [],
  },
  {
    pattern: /^Deprecated:\s*(.+?)(?:\s+→|$)/i,
    antiPatternTemplates: [],
  },
];

export interface SupersessionResult {
  supersedes: boolean;
  oldFactId?: string;
  reason?: string;
}

export function checkFactSupersession(
  newFact: ExtractedFact,
  existingFacts: Array<{ id: string; content: string; sector: Sector }>,
): SupersessionResult {
  const newSubject = extractFactSubject(newFact.content);
  if (!newSubject) return { supersedes: false };

  for (const existing of existingFacts) {
    if (existing.sector !== newFact.sector) continue;

    const existingSubject = extractFactSubject(existing.content);
    if (!existingSubject) continue;

    if (newSubject.normalized === existingSubject.normalized) {
      if (newFact.content.toLowerCase() !== existing.content.toLowerCase()) {
        return {
          supersedes: true,
          oldFactId: existing.id,
          reason: `Same subject "${newSubject.subject}" with different value`,
        };
      }
    }

    for (const { pattern, antiPatternTemplates } of CONTRADICTION_PATTERNS) {
      const newMatch = newFact.content.match(pattern);
      if (!newMatch) continue;

      for (const template of antiPatternTemplates) {
        const interpolated = new RegExp(
          template
            .replace(/\$1/g, escapeRegex(newMatch[1] || ""))
            .replace(/\$2/g, escapeRegex(newMatch[2] || "")),
          "i",
        );

        if (interpolated.test(existing.content)) {
          return {
            supersedes: true,
            oldFactId: existing.id,
            reason: `Contradicting fact detected`,
          };
        }
      }
    }
  }

  return { supersedes: false };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
