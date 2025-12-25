import type { EntityType } from "./db";

export interface ExtractedEntity {
  name: string;
  type: EntityType;
  context: string;
  confidence: number;
}

export interface ExtractedRelation {
  sourceEntity: ExtractedEntity;
  targetEntity: ExtractedEntity;
  relationType: string;
  confidence: number;
}

interface EntityPattern {
  type: EntityType;
  patterns: RegExp[];
  contextWindow: number;
}

const ENTITY_PATTERNS: EntityPattern[] = [
  {
    type: "file",
    patterns: [
      /(?:^|[\s"'`(])([a-zA-Z0-9_\-./]+\.(ts|tsx|js|jsx|py|rs|go|java|c|cpp|h|hpp|rb|php|swift|kt|json|yaml|yml|toml|md|css|scss|html|xml|sql))\b/g, // file.ext
      /(?:^|[\s"'`(])(\.\/[a-zA-Z0-9_\-./]+)\b/g, // ./relative/path
      /(?:^|[\s"'`(])(\/[a-zA-Z0-9_\-./]+\.[a-zA-Z]{1,5})\b/g, // /absolute/path.ext
      /\b((?:src|lib|packages?|components?|utils?|hooks?|services?|api)\/[a-zA-Z0-9_\-./]+)\b/g, // src/path
    ],
    contextWindow: 100,
  },
  {
    type: "class",
    patterns: [
      /\bclass\s+([A-Z][a-zA-Z0-9_]*)\b/g, // class ClassName
      /\b([A-Z][a-zA-Z0-9]*(?:Component|Provider|Context|Hook|Service|Controller|Handler|Manager|Factory|Builder|Adapter|Wrapper))\b/g, // SomethingComponent
      /\bextends\s+([A-Z][a-zA-Z0-9_]*)\b/g, // extends BaseClass
      /\bimplements\s+([A-Z][a-zA-Z0-9_]*)\b/g, // implements Interface
    ],
    contextWindow: 80,
  },
  {
    type: "function",
    patterns: [
      /\bfunction\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g, // function name(
      /\b(?:const|let)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(?:async\s*)?\(/g, // const fn = (
      /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\([^)]*\)\s*(?:=>|{)/g, // name(...) => or name(...) {
      /\bdef\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g, // def name( (Python)
      /\bfn\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[<(]/g, // fn name< or fn name( (Rust)
    ],
    contextWindow: 60,
  },
  {
    type: "variable",
    patterns: [
      /\b([A-Z][A-Z0-9_]{2,})\b/g, // CONSTANT_CASE
      /\bconst\s+([A-Z][A-Z0-9_]{2,})\s*=/g, // const CONSTANT =
    ],
    contextWindow: 40,
  },
  {
    type: "tool",
    patterns: [
      /\b(npm|yarn|bun|pnpm|cargo|pip|poetry|go|rustc|tsc|node|python|ruby|git|docker|kubectl|terraform|aws|gcloud|az)\b/g,
      /\b(webpack|vite|rollup|esbuild|parcel|turbo|nx|lerna|jest|vitest|mocha|pytest|cargo-test)\b/g,
    ],
    contextWindow: 50,
  },
  {
    type: "error",
    patterns: [
      /\b(TypeError|ReferenceError|SyntaxError|RuntimeError|ValueError|KeyError|IndexError|NullPointerException|IOException)\b/g,
      /\b(E[A-Z]{2,}[0-9]*|ERR_[A-Z_]+)\b/g, // ENOENT, ERR_MODULE_NOT_FOUND
      /\b(4[0-9]{2}|5[0-9]{2})\s*(?:error|status|response)\b/gi, // 404 error
    ],
    contextWindow: 100,
  },
  {
    type: "concept",
    patterns: [
      /\b(API|REST|GraphQL|WebSocket|OAuth|JWT|CORS|SSR|CSR|SSG|ISR)\b/g,
      /\b(microservices?|monolith|serverless|event[- ]driven|CQRS|DDD|clean\s*architecture)\b/gi,
      /\b(SQL|NoSQL|PostgreSQL|MySQL|MongoDB|Redis|Elasticsearch|DynamoDB)\b/g,
    ],
    contextWindow: 80,
  },
];

const RELATION_PATTERNS = [
  {
    pattern: /\b(\w+)\s+(?:imports?|requires?|depends?\s*on|uses?)\s+(\w+)\b/gi,
    relationType: "imports",
  },
  {
    pattern: /\b(\w+)\s+(?:extends?|inherits?\s*from)\s+(\w+)\b/gi,
    relationType: "extends",
  },
  {
    pattern: /\b(\w+)\s+(?:implements?|realizes?)\s+(\w+)\b/gi,
    relationType: "implements",
  },
  {
    pattern: /\b(\w+)\s+(?:calls?|invokes?)\s+(\w+)\b/gi,
    relationType: "calls",
  },
  {
    pattern: /\b(\w+)\s+(?:returns?|produces?|creates?)\s+(\w+)\b/gi,
    relationType: "produces",
  },
  {
    pattern: /\b(\w+)\s+(?:contains?|has|includes?)\s+(\w+)\b/gi,
    relationType: "contains",
  },
];

const COMMON_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "must",
  "shall",
  "can",
  "need",
  "dare",
  "ought",
  "used",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "at",
  "by",
  "from",
  "as",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "under",
  "again",
  "further",
  "then",
  "once",
  "here",
  "there",
  "when",
  "where",
  "why",
  "how",
  "all",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "nor",
  "not",
  "only",
  "own",
  "same",
  "so",
  "than",
  "too",
  "very",
  "just",
  "but",
  "and",
  "or",
  "if",
  "because",
  "while",
  "although",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "you",
  "your",
  "we",
  "our",
  "they",
  "their",
  "he",
  "she",
  "him",
  "her",
  "his",
  "I",
  "me",
  "my",
]);

const PROGRAMMING_KEYWORDS = new Set([
  "TRUE",
  "FALSE",
  "NULL",
  "UNDEFINED",
  "NAN",
  "INFINITY",
  "NEW",
  "DELETE",
  "RETURN",
  "BREAK",
  "CONTINUE",
  "IF",
  "ELSE",
  "FOR",
  "WHILE",
  "DO",
  "SWITCH",
  "CASE",
  "DEFAULT",
  "TRY",
  "CATCH",
  "FINALLY",
  "THROW",
  "ASYNC",
  "AWAIT",
  "YIELD",
  "CLASS",
  "EXTENDS",
  "IMPLEMENTS",
  "INTERFACE",
  "TYPE",
  "ENUM",
  "CONST",
  "LET",
  "VAR",
  "FUNCTION",
  "IMPORT",
  "EXPORT",
  "FROM",
  "AS",
]);

function extractContext(
  text: string,
  match: RegExpExecArray,
  windowSize: number,
): string {
  const start = Math.max(0, match.index - windowSize);
  const end = Math.min(text.length, match.index + match[0].length + windowSize);
  return text.substring(start, end).replace(/\s+/g, " ").trim();
}

function deduplicateEntities(entities: ExtractedEntity[]): ExtractedEntity[] {
  const seen = new Map<string, ExtractedEntity>();

  for (const entity of entities) {
    const key = `${entity.type}:${entity.name.toLowerCase()}`;
    const existing = seen.get(key);

    if (!existing || entity.confidence > existing.confidence) {
      seen.set(key, entity);
    }
  }

  return Array.from(seen.values());
}

function isCommonWord(word: string, type: EntityType): boolean {
  if (type === "variable") {
    return (
      COMMON_WORDS.has(word.toLowerCase()) || PROGRAMMING_KEYWORDS.has(word)
    );
  }
  return COMMON_WORDS.has(word.toLowerCase());
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function calculateEntityConfidence(
  name: string,
  type: EntityType,
  context: string,
): number {
  let confidence = 0.5;

  const hasLongName = name.length > 5;
  const hasVeryLongName = name.length > 10;
  const hasFileExtension = type === "file" && /\.[a-z]{2,4}$/i.test(name);
  const hasPascalCase = type === "class" && /^[A-Z][a-z]+[A-Z]/.test(name);
  const hasCamelCase = type === "function" && /^[a-z]+[A-Z]/.test(name);
  const mentionCount = (
    context.match(new RegExp(escapeRegex(name), "gi")) || []
  ).length;
  const hasErrorSuffix = type === "error" && /Error|Exception/.test(name);

  if (hasLongName) confidence += 0.1;
  if (hasVeryLongName) confidence += 0.1;
  if (hasFileExtension) confidence += 0.2;
  if (hasPascalCase) confidence += 0.15;
  if (hasCamelCase) confidence += 0.1;
  if (mentionCount > 1) confidence += 0.1;
  if (hasErrorSuffix) confidence += 0.2;

  return Math.min(confidence, 1.0);
}

export function extractEntities(text: string): ExtractedEntity[] {
  const entities: ExtractedEntity[] = [];

  for (const pattern of ENTITY_PATTERNS) {
    for (const regex of pattern.patterns) {
      const clonedRegex = new RegExp(regex.source, regex.flags);
      let match: RegExpExecArray | null;

      while ((match = clonedRegex.exec(text)) !== null) {
        const name = match[1];

        if (!name || name.length < 2 || name.length > 200) continue;
        if (isCommonWord(name, pattern.type)) continue;

        const context = extractContext(text, match, pattern.contextWindow);
        const confidence = calculateEntityConfidence(
          name,
          pattern.type,
          context,
        );

        entities.push({
          name,
          type: pattern.type,
          context,
          confidence,
        });
      }
    }
  }

  return deduplicateEntities(entities);
}

export function extractRelations(
  entities: ExtractedEntity[],
  text: string,
): ExtractedRelation[] {
  const relations: ExtractedRelation[] = [];
  const entityMap = new Map<string, ExtractedEntity>();

  for (const entity of entities) {
    entityMap.set(entity.name.toLowerCase(), entity);
  }

  for (const { pattern, relationType } of RELATION_PATTERNS) {
    const clonedPattern = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;

    while ((match = clonedPattern.exec(text)) !== null) {
      const sourceName = match[1]?.toLowerCase();
      const targetName = match[2]?.toLowerCase();

      if (!sourceName || !targetName) continue;

      const sourceEntity = entityMap.get(sourceName);
      const targetEntity = entityMap.get(targetName);

      if (sourceEntity && targetEntity) {
        relations.push({
          sourceEntity,
          targetEntity,
          relationType,
          confidence: Math.min(
            sourceEntity.confidence,
            targetEntity.confidence,
          ),
        });
      }
    }
  }

  return relations;
}

export function extractEntitiesAndRelations(text: string): {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
} {
  const entities = extractEntities(text);
  const relations = extractRelations(entities, text);
  return { entities, relations };
}
