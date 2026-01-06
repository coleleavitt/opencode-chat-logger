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

interface RelationPattern {
  relationType: string;
  patterns: RegExp[];
  confidence: number;
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
      // AI/ML concepts
      /\b(embeddings?|vectors?|semantic\s*search|RAG|LLM|transformers?|attention|tokeniz(?:er|ation))\b/gi,
      /\b(cosine\s*similarity|similarity\s*search|nearest\s*neighbor|KNN|HNSW|IVF)\b/gi,
      /\b(prompt(?:ing)?|fine[- ]?tun(?:e|ing)|inference|model)\b/gi,
      // Memory/storage concepts
      /\b(memory\s*(?:tier|consolidation|pruning|waypoints?)|salience|decay)\b/gi,
    ],
    contextWindow: 80,
  },
  {
    type: "project",
    patterns: [
      // GitHub repos: owner/repo format
      /\b([a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+)\b/g,
      // Known AI/ML libraries
      /\b(ollama|openai|anthropic|langchain|llamaindex|chromadb|pinecone|qdrant|weaviate|milvus)\b/gi,
      /\b(huggingface|transformers\.js|sentence[- ]?transformers|faiss|annoy)\b/gi,
      // Known npm packages (with dots or hyphens)
      /\b(better-sqlite3|drizzle-orm|prisma|typeorm|sequelize|knex)\b/gi,
      /\b(opencode|opencode-chat-logger|oh-my-opencode|openmemory|cognee)\b/gi,
      // Package manager install patterns: "install X", "add X"
      /(?:npm|yarn|bun|pnpm|cargo|pip)\s+(?:install|add|i)\s+([a-zA-Z0-9@/_.-]+)/gi,
    ],
    contextWindow: 80,
  },
];

const RELATION_PATTERNS: RelationPattern[] = [
  // === CODE SYNTAX PATTERNS (two-capture) ===
  {
    relationType: "imports",
    patterns: [
      /\bimport\s+(?:\{[^}]+\}|[a-zA-Z_][a-zA-Z0-9_]*|\*)\s+from\s+['"]([^'"]+)['"]/g,
      /\bfrom\s+['"]([^'"]+)['"]\s+import\b/g,
      /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ],
    confidence: 0.9,
  },
  {
    relationType: "extends",
    patterns: [
      /\bclass\s+([A-Z][a-zA-Z0-9_]*)\s+extends\s+([A-Z][a-zA-Z0-9_]*)\b/g,
    ],
    confidence: 0.95,
  },
  {
    relationType: "implements",
    patterns: [
      /\bclass\s+([A-Z][a-zA-Z0-9_]*)\s+implements\s+([A-Z][a-zA-Z0-9_,\s]*)\b/g,
    ],
    confidence: 0.95,
  },

  // === NATURAL LANGUAGE TWO-CAPTURE PATTERNS ===

  // "added X to Y", "add X in Y"
  {
    relationType: "added_to",
    patterns: [
      /\badd(?:s|ed|ing)?\s+`?([a-zA-Z_][a-zA-Z0-9_()]*)`?\s+to\s+`?([a-zA-Z0-9_./-]+)`?/gi,
      /\badd(?:s|ed|ing)?\s+`?([a-zA-Z_][a-zA-Z0-9_()]*)`?\s+(?:in|into)\s+`?([a-zA-Z0-9_./-]+)`?/gi,
      /\badd(?:s|ed|ing)?\s+`([^`]+)`\s+to\s+`([^`]+)`/gi,
      /\badd(?:s|ed|ing)?\s+`([^`]+)`\s+(?:in|into)\s+`([^`]+)`/gi,
    ],
    confidence: 0.8,
  },

  // "X in Y" - function/method in file
  {
    relationType: "defined_in",
    patterns: [
      /`([a-zA-Z_][a-zA-Z0-9_()]*)`\s+(?:in|inside|within)\s+`([a-zA-Z0-9_./-]+)`/gi,
      /`([a-zA-Z_][a-zA-Z0-9_()]*)`\s+(?:function|method|class)\s+(?:in|inside)\s+`([a-zA-Z0-9_./-]+)`/gi,
      /(?:function|method|class)\s+`([a-zA-Z_][a-zA-Z0-9_()]*)`\s+(?:in|inside)\s+`([a-zA-Z0-9_./-]+)`/gi,
      // Without backticks - match "X in src/path.ts" or "X in path.ts"
      /\b([a-zA-Z_][a-zA-Z0-9_()]*)\s+(?:in|inside|within)\s+((?:src|lib|packages?)\/[a-zA-Z0-9_.\/-]+\.[a-z]{2,4})/gi,
      /\b([a-zA-Z_][a-zA-Z0-9_()]*)\s+(?:in|inside|within)\s+([a-zA-Z0-9_.\/-]+\.[tj]sx?)/gi,
    ],
    confidence: 0.8,
  },

  // "Created X" where X is a file path (two-capture: action target + file)
  {
    relationType: "created_in",
    patterns: [
      // "Created src/file.ts", "created lib/module.js"
      /\bcreat(?:e|es|ed|ing)\s+((?:src|lib|packages?|scripts?)\/[a-zA-Z0-9_.\/-]+\.[a-z]{2,4})/gi,
      // "Created `src/file.ts`"
      /\bcreat(?:e|es|ed|ing)\s+`([^`]+\.[a-z]{2,4})`/gi,
    ],
    confidence: 0.75,
  },

  // "Modified/Updated/Fixed X" where X is a file path
  {
    relationType: "modified_file",
    patterns: [
      /\b(?:modif(?:y|ies|ied|ying)|updat(?:e|es|ed|ing)|fix(?:es|ed|ing)?|edit(?:s|ed|ing)?)\s+((?:src|lib|packages?)\/[a-zA-Z0-9_.\/-]+\.[a-z]{2,4})/gi,
      /\b(?:modif(?:y|ies|ied|ying)|updat(?:e|es|ed|ing)|fix(?:es|ed|ing)?|edit(?:s|ed|ing)?)\s+`([^`]+\.[a-z]{2,4})`/gi,
    ],
    confidence: 0.75,
  },

  // "change X to Y", "replace X with Y", "rename X to Y"
  {
    relationType: "replaced_by",
    patterns: [
      /\bchang(?:e|es|ing|ed)\s+`([^`]+)`\s+to\s+`([^`]+)`/gi,
      /\breplac(?:e|es|ing|ed)\s+`([^`]+)`\s+with\s+`([^`]+)`/gi,
      /\brenam(?:e|es|ing|ed)\s+`([^`]+)`\s+to\s+`([^`]+)`/gi,
      /\bchang(?:e|es|ing|ed)\s+`?([a-zA-Z_][a-zA-Z0-9_./-]*)`?\s+to\s+`?([a-zA-Z_][a-zA-Z0-9_./-]*)`?/gi,
    ],
    confidence: 0.85,
  },

  // "X uses Y", "X with Y"
  {
    relationType: "uses",
    patterns: [
      /`([a-zA-Z_][a-zA-Z0-9_]*)`\s+uses\s+`([a-zA-Z_][a-zA-Z0-9_]*)`/gi,
      /`([a-zA-Z_][a-zA-Z0-9_]*)`\s+(?:using|with)\s+`([a-zA-Z_][a-zA-Z0-9_]*)`/gi,
      /\busing\s+`?([a-zA-Z_][a-zA-Z0-9_./-]*)`?\s+(?:in|for|with)\s+`?([a-zA-Z0-9_./-]+)`?/gi,
    ],
    confidence: 0.7,
  },

  // "X calls Y", "X invokes Y"
  {
    relationType: "calls",
    patterns: [
      /`([a-zA-Z_][a-zA-Z0-9_()]*)`\s+call(?:s|ed|ing)?\s+`([a-zA-Z_][a-zA-Z0-9_()]*)`/gi,
      /`([a-zA-Z_][a-zA-Z0-9_()]*)`\s+invok(?:e|es|ed|ing)\s+`([a-zA-Z_][a-zA-Z0-9_()]*)`/gi,
      /\bcall(?:s|ing|ed)?\s+`([a-zA-Z_][a-zA-Z0-9_()]*)`\s+from\s+`([a-zA-Z0-9_./-]+)`/gi,
    ],
    confidence: 0.75,
  },

  // "X depends on Y", "X requires Y"
  {
    relationType: "depends_on",
    patterns: [
      /`([a-zA-Z_][a-zA-Z0-9_./-]*)`\s+depends?\s+on\s+`([a-zA-Z_][a-zA-Z0-9_./-]*)`/gi,
      /`([a-zA-Z_][a-zA-Z0-9_./-]*)`\s+requires?\s+`([a-zA-Z_][a-zA-Z0-9_./-]*)`/gi,
      /\bdepends?\s+on\s+`?([a-zA-Z_][a-zA-Z0-9_@/.:-]*)`?/gi,
    ],
    confidence: 0.8,
  },

  // "move X to Y", "moved X from Y"
  {
    relationType: "moved_to",
    patterns: [
      /\bmov(?:e|es|ed|ing)\s+`([^`]+)`\s+to\s+`([^`]+)`/gi,
      /\bmov(?:e|es|ed|ing)\s+`?([a-zA-Z0-9_./-]+)`?\s+to\s+`?([a-zA-Z0-9_./-]+)`?/gi,
    ],
    confidence: 0.8,
  },

  // "copy X to Y"
  {
    relationType: "copied_to",
    patterns: [
      /\bcop(?:y|ies|ied|ying)\s+`([^`]+)`\s+to\s+`([^`]+)`/gi,
      /\bcop(?:y|ies|ied|ying)\s+`?([a-zA-Z0-9_./-]+)`?\s+to\s+`?([a-zA-Z0-9_./-]+)`?/gi,
    ],
    confidence: 0.75,
  },

  // "X returns Y", "X outputs Y"
  {
    relationType: "returns",
    patterns: [
      /`([a-zA-Z_][a-zA-Z0-9_()]*)`\s+returns?\s+`([a-zA-Z_][a-zA-Z0-9_<>[\]]*)`/gi,
      /`([a-zA-Z_][a-zA-Z0-9_()]*)`\s+outputs?\s+`([a-zA-Z_][a-zA-Z0-9_<>[\]]*)`/gi,
    ],
    confidence: 0.7,
  },

  // "X accepts Y", "X takes Y as parameter"
  {
    relationType: "accepts",
    patterns: [
      /`([a-zA-Z_][a-zA-Z0-9_()]*)`\s+accepts?\s+`([a-zA-Z_][a-zA-Z0-9_<>[\]]*)`/gi,
      /`([a-zA-Z_][a-zA-Z0-9_()]*)`\s+takes?\s+`([a-zA-Z_][a-zA-Z0-9_<>[\]]*)`/gi,
    ],
    confidence: 0.7,
  },

  // "store X in Y", "save X to Y"
  {
    relationType: "stores_in",
    patterns: [
      /\bstor(?:e|es|ed|ing)\s+`([^`]+)`\s+(?:in|into)\s+`([^`]+)`/gi,
      /\bsav(?:e|es|ed|ing)\s+`([^`]+)`\s+(?:to|in|into)\s+`([^`]+)`/gi,
      /\bstor(?:e|es|ed|ing)\s+`?([a-zA-Z0-9_./-]+)`?\s+(?:in|into)\s+`?([a-zA-Z0-9_./-]+)`?/gi,
    ],
    confidence: 0.75,
  },

  // "read X from Y", "load X from Y", "get X from Y"
  {
    relationType: "reads_from",
    patterns: [
      /\bread(?:s|ing)?\s+`([^`]+)`\s+from\s+`([^`]+)`/gi,
      /\bload(?:s|ed|ing)?\s+`([^`]+)`\s+from\s+`([^`]+)`/gi,
      /\bget(?:s|ting)?\s+`([^`]+)`\s+from\s+`([^`]+)`/gi,
      /\bfetch(?:es|ed|ing)?\s+`([^`]+)`\s+from\s+`([^`]+)`/gi,
    ],
    confidence: 0.75,
  },

  // "write X to Y"
  {
    relationType: "writes_to",
    patterns: [
      /\bwrit(?:e|es|ing|ten)\s+`([^`]+)`\s+to\s+`([^`]+)`/gi,
      /\bwrit(?:e|es|ing|ten)\s+`?([a-zA-Z0-9_./-]+)`?\s+to\s+`?([a-zA-Z0-9_./-]+)`?/gi,
    ],
    confidence: 0.75,
  },

  // "update X in Y", "modify X in Y", "fix X in Y"
  {
    relationType: "modifies_in",
    patterns: [
      /\bupdat(?:e|es|ing|ed)\s+`([^`]+)`\s+in\s+`([^`]+)`/gi,
      /\bmodif(?:y|ies|ying|ied)\s+`([^`]+)`\s+in\s+`([^`]+)`/gi,
      /\bfix(?:es|ed|ing)?\s+`([^`]+)`\s+in\s+`([^`]+)`/gi,
      /\bchang(?:e|es|ing|ed)\s+`([^`]+)`\s+in\s+`([^`]+)`/gi,
    ],
    confidence: 0.8,
  },

  // "delete X from Y", "remove X from Y"
  {
    relationType: "deleted_from",
    patterns: [
      /\bdelet(?:e|es|ing|ed)\s+`([^`]+)`\s+from\s+`([^`]+)`/gi,
      /\bremov(?:e|es|ing|ed)\s+`([^`]+)`\s+from\s+`([^`]+)`/gi,
    ],
    confidence: 0.8,
  },

  // "implement X in Y", "create X in Y"
  {
    relationType: "implemented_in",
    patterns: [
      /\bimplement(?:s|ed|ing)?\s+`([^`]+)`\s+in\s+`([^`]+)`/gi,
      /\bcreat(?:e|es|ing|ed)\s+`([^`]+)`\s+in\s+`([^`]+)`/gi,
    ],
    confidence: 0.8,
  },

  // "extract X from Y", "pull X from Y"
  {
    relationType: "extracted_from",
    patterns: [
      /\bextract(?:s|ed|ing)?\s+`([^`]+)`\s+from\s+`([^`]+)`/gi,
      /\bpull(?:s|ed|ing)?\s+`([^`]+)`\s+from\s+`([^`]+)`/gi,
    ],
    confidence: 0.75,
  },

  // "merge X into Y", "combine X with Y"
  {
    relationType: "merged_into",
    patterns: [
      /\bmerg(?:e|es|ed|ing)\s+`([^`]+)`\s+into\s+`([^`]+)`/gi,
      /\bcombin(?:e|es|ed|ing)\s+`([^`]+)`\s+with\s+`([^`]+)`/gi,
    ],
    confidence: 0.75,
  },

  // === SINGLE-CAPTURE PATTERNS (fallback) ===
  {
    relationType: "calls",
    patterns: [
      /\bcall(?:s|ing|ed)?\s+`?([a-zA-Z_][a-zA-Z0-9_()]*)`?/gi,
    ],
    confidence: 0.6,
  },
  {
    relationType: "reads",
    patterns: [
      /\bread(?:s|ing)?\s+(?:from\s+)?`?([a-zA-Z0-9_./-]+\.[a-z]{2,4})`?/gi,
    ],
    confidence: 0.55,
  },
  {
    relationType: "writes",
    patterns: [
      /\bwrit(?:e|es|ing|ten)\s+(?:to\s+)?`?([a-zA-Z0-9_./-]+\.[a-z]{2,4})`?/gi,
    ],
    confidence: 0.55,
  },
  {
    relationType: "creates",
    patterns: [
      /\bcreat(?:e|es|ing|ed)\s+`([a-zA-Z0-9_./-]+)`/gi,
      /\bcreat(?:e|es|ing|ed)\s+`?([a-zA-Z0-9_./-]+\.[a-z]{2,4})`?/gi,
    ],
    confidence: 0.6,
  },
  {
    relationType: "modifies",
    patterns: [
      /\bmodif(?:y|ies|ying|ied)\s+`?([a-zA-Z0-9_./-]+\.[a-z]{2,4})`?/gi,
      /\bupdat(?:e|es|ing|ed)\s+(?:the\s+)?`([a-zA-Z0-9_./-]+)`/gi,
      /\bchang(?:e|es|ing|ed)\s+`?([a-zA-Z0-9_./-]+\.[a-z]{2,4})`?/gi,
      /\bfix(?:es|ed|ing)?\s+(?:the\s+)?`([a-zA-Z0-9_./-]+)`/gi,
      /\bedit(?:s|ed|ing)?\s+`?([a-zA-Z0-9_./-]+\.[a-z]{2,4})`?/gi,
    ],
    confidence: 0.6,
  },
  {
    relationType: "deletes",
    patterns: [
      /\bdelet(?:e|es|ing|ed)\s+`?([a-zA-Z0-9_./-]+)`?/gi,
      /\bremov(?:e|es|ing|ed)\s+`?([a-zA-Z0-9_./-]+)`?/gi,
    ],
    confidence: 0.55,
  },
  {
    relationType: "implements",
    patterns: [
      /\bimplement(?:s|ed|ing)?\s+`?([a-zA-Z_][a-zA-Z0-9_]*)`?/gi,
    ],
    confidence: 0.6,
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
  // JS/TS keywords
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
  // SQL keywords
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "CREATE",
  "DROP",
  "ALTER",
  "TABLE",
  "INDEX",
  "VIEW",
  "DATABASE",
  "SCHEMA",
  "WHERE",
  "AND",
  "OR",
  "NOT",
  "IN",
  "EXISTS",
  "BETWEEN",
  "LIKE",
  "IS",
  "JOIN",
  "LEFT",
  "RIGHT",
  "INNER",
  "OUTER",
  "FULL",
  "CROSS",
  "ON",
  "GROUP",
  "BY",
  "HAVING",
  "ORDER",
  "ASC",
  "DESC",
  "LIMIT",
  "OFFSET",
  "UNION",
  "INTERSECT",
  "EXCEPT",
  "ALL",
  "DISTINCT",
  "COUNT",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "ROUND",
  "LENGTH",
  "SUBSTR",
  "COALESCE",
  "IFNULL",
  "NULLIF",
  "CAST",
  "PRIMARY",
  "KEY",
  "FOREIGN",
  "REFERENCES",
  "UNIQUE",
  "CHECK",
  "CONSTRAINT",
  "CASCADE",
  "SET",
  "VALUES",
  "INTO",
  "INTEGER",
  "TEXT",
  "REAL",
  "BLOB",
  "BOOLEAN",
  "VARCHAR",
  "CHAR",
  "DATE",
  "DATETIME",
  "TIMESTAMP",
  "AUTOINCREMENT",
  "ROWID",
  "PRAGMA",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "TRANSACTION",
  // System/shell keywords
  "INFO",
  "DEBUG",
  "WARN",
  "ERROR",
  "FATAL",
  "PID",
  "CPU",
  "MEM",
  "RSS",
  "VSZ",
  "TTY",
  "STAT",
  "TIME",
  "CMD",
  "USER",
  "ROOT",
  "HOME",
  "PATH",
  "PWD",
  "ENV",
  "EOF",
  "EOL",
  "GNU",
  "BSD",
  "POSIX",
  "UNIX",
  "LINUX",
  // Timezone abbreviations
  "UTC",
  "GMT",
  "EST",
  "EDT",
  "CST",
  "CDT",
  "MST",
  "MDT",
  "PST",
  "PDT",
  // Generic noise
  "TODO",
  "FIXME",
  "HACK",
  "XXX",
  "NOTE",
  "OUNT", // Typo from COUNT output
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

function extractRelations(
  text: string,
  entities: ExtractedEntity[],
): ExtractedRelation[] {
  const relations: ExtractedRelation[] = [];
  const entityByName = new Map<string, ExtractedEntity>();

  for (const entity of entities) {
    entityByName.set(entity.name.toLowerCase(), entity);
  }

  const findEntity = (name: string): ExtractedEntity | undefined => {
    const normalized = name.toLowerCase();
    if (entityByName.has(normalized)) {
      return entityByName.get(normalized);
    }
    for (const [key, entity] of entityByName) {
      if (key.includes(normalized) || normalized.includes(key)) {
        return entity;
      }
    }
    return undefined;
  };

  for (const pattern of RELATION_PATTERNS) {
    for (const regex of pattern.patterns) {
      const clonedRegex = new RegExp(regex.source, regex.flags);
      let match: RegExpExecArray | null;

      while ((match = clonedRegex.exec(text)) !== null) {
        const captured = match.slice(1).filter(Boolean);
        if (captured.length === 0) continue;

        if (captured.length === 1) {
          const targetEntity = findEntity(captured[0]);
          if (targetEntity && !isCommonWord(captured[0], targetEntity.type)) {
            const contextEntity: ExtractedEntity = {
              name: "context",
              type: "concept",
              context: extractContext(text, match, 50),
              confidence: 0.5,
            };
            relations.push({
              sourceEntity: contextEntity,
              targetEntity,
              relationType: pattern.relationType,
              confidence: pattern.confidence * 0.8,
            });
          }
        } else if (captured.length >= 2) {
          const sourceEntity = findEntity(captured[0]);
          const targetEntity = findEntity(captured[1]);

          if (sourceEntity && targetEntity) {
            relations.push({
              sourceEntity,
              targetEntity,
              relationType: pattern.relationType,
              confidence: pattern.confidence,
            });
          } else if (targetEntity && !isCommonWord(captured[0], "class")) {
            const implicitSource: ExtractedEntity = {
              name: captured[0],
              type: "class",
              context: extractContext(text, match, 50),
              confidence: 0.6,
            };
            relations.push({
              sourceEntity: implicitSource,
              targetEntity,
              relationType: pattern.relationType,
              confidence: pattern.confidence * 0.7,
            });
          }
        }
      }
    }
  }

  return deduplicateRelations(relations);
}

function deduplicateRelations(
  relations: ExtractedRelation[],
): ExtractedRelation[] {
  const seen = new Map<string, ExtractedRelation>();

  for (const rel of relations) {
    const key = `${rel.sourceEntity.name}:${rel.relationType}:${rel.targetEntity.name}`;
    const existing = seen.get(key);

    if (!existing || rel.confidence > existing.confidence) {
      seen.set(key, rel);
    }
  }

  return Array.from(seen.values());
}

export function extractEntitiesAndRelations(text: string): {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
} {
  const entities = extractEntities(text);
  const relations = extractRelations(text, entities);
  return { entities, relations };
}
