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
  {
    pattern: /\b(?:we|I)\s+(?:decided|chose|agreed)\s+to\s+(.+?)(?:\.|$)/gi,
    sector: "architecture",
    confidence: 0.9,
    extractFact: (m) => `Decision: ${m[1].trim()}`,
  },
  {
    pattern:
      /\b(?:the|this)\s+(?:project|codebase|repo)\s+uses?\s+(.+?)(?:\s+for|\.|$)/gi,
    sector: "architecture",
    confidence: 0.85,
    extractFact: (m) => `Project uses ${m[1].trim()}`,
  },
  {
    pattern: /\b(?:don't|do not|never|avoid)\s+(.+?)(?:\s+because|\.|$)/gi,
    sector: "architecture",
    confidence: 0.8,
    extractFact: (m) => `Avoid: ${m[1].trim()}`,
  },
  {
    pattern:
      /\b(?:always|must|should)\s+(.+?)(?:\s+when|\s+before|\s+after|\.|$)/gi,
    sector: "procedural",
    confidence: 0.75,
    extractFact: (m) => `Rule: ${m[1].trim()}`,
  },
  {
    pattern:
      /\b(?:the\s+)?(?:bug|issue|problem)\s+(?:was|is)\s+(?:caused\s+by|due\s+to)\s+(.+?)(?:\.|$)/gi,
    sector: "debugging",
    confidence: 0.85,
    extractFact: (m) => `Root cause: ${m[1].trim()}`,
  },
  {
    pattern: /\b(?:fixed|resolved|solved)\s+(?:by|with)\s+(.+?)(?:\.|$)/gi,
    sector: "debugging",
    confidence: 0.8,
    extractFact: (m) => `Solution: ${m[1].trim()}`,
  },
  {
    pattern:
      /\b(\w+)\s+(?:is|are)\s+(?:located|found|defined)\s+(?:in|at)\s+([^\s.]+)/gi,
    sector: "code_change",
    confidence: 0.7,
    extractFact: (m) => `${m[1]} is located in ${m[2]}`,
  },
  {
    pattern: /\b(?:run|execute|use)\s+`([^`]+)`\s+to\s+(.+?)(?:\.|$)/gi,
    sector: "procedural",
    confidence: 0.85,
    extractFact: (m) => `Command \`${m[1]}\` to ${m[2].trim()}`,
  },
  {
    pattern:
      /\b(?:the\s+)?(\w+)\s+(?:endpoint|API)\s+(?:returns?|expects?)\s+(.+?)(?:\.|$)/gi,
    sector: "architecture",
    confidence: 0.8,
    extractFact: (m) => `${m[1]} API: ${m[2].trim()}`,
  },
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
    pattern: /\bworkaround(?:\s+is)?\s*[:-]?\s*(.+?)(?:\.|$)/gi,
    sector: "debugging",
    confidence: 0.85,
    extractFact: (m) => `Workaround: ${m[1].trim()}`,
  },
  {
    pattern: /\b(?:prefer|recommended)\s+(.+?)\s+over\s+(.+?)(?:\.|$)/gi,
    sector: "architecture",
    confidence: 0.8,
    extractFact: (m) => `Prefer ${m[1].trim()} over ${m[2].trim()}`,
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
