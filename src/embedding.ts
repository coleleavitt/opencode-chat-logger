import type { Sector } from "./db";

export interface EmbeddingProvider {
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  dimension: number;
}

export type ToastCallback = (message: string) => void;

export interface OllamaEmbeddingConfig {
  model?: string;
  baseUrl?: string;
}

const DEFAULT_OLLAMA_MODEL = "nomic-embed-text";
const DEFAULT_OLLAMA_URL = "http://localhost:11434";

export class OllamaEmbedding implements EmbeddingProvider {
  private model: string;
  private baseUrl: string;
  dimension: number = 768;

  constructor(config: OllamaEmbeddingConfig = {}) {
    this.model = config.model || DEFAULT_OLLAMA_MODEL;
    this.baseUrl = config.baseUrl || DEFAULT_OLLAMA_URL;
  }

  async embed(text: string): Promise<Float32Array> {
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: text }),
    });

    if (!response.ok) {
      throw new Error(`Ollama embedding failed: ${response.statusText}`);
    }

    const data = (await response.json()) as { embeddings: number[][] };
    const embedding = data.embeddings[0];
    this.dimension = embedding.length;
    return new Float32Array(embedding);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: texts }),
    });

    if (!response.ok) {
      throw new Error(`Ollama batch embedding failed: ${response.statusText}`);
    }

    const data = (await response.json()) as { embeddings: number[][] };
    if (data.embeddings.length > 0) {
      this.dimension = data.embeddings[0].length;
    }
    return data.embeddings.map((e) => new Float32Array(e));
  }
}

export class SyntheticEmbedding implements EmbeddingProvider {
  dimension: number = 384;

  async embed(text: string): Promise<Float32Array> {
    return this.hashToVector(text);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.hashToVector(t));
  }

  private hashToVector(text: string): Float32Array {
    const vector = new Float32Array(this.dimension);
    const words = text.toLowerCase().split(/\s+/);

    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      for (let j = 0; j < word.length; j++) {
        const idx = (word.charCodeAt(j) * (i + 1) * (j + 1)) % this.dimension;
        vector[idx] += 1.0 / (1 + Math.log(words.length));
      }
    }

    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < vector.length; i++) {
        vector[i] /= norm;
      }
    }

    return vector;
  }
}

interface WorkerResponse {
  id: string;
  embedding?: number[];
  error?: string;
}

export class SubprocessEmbedding implements EmbeddingProvider {
  dimension: number = 384;
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private pending = new Map<
    string,
    { resolve: (v: Float32Array) => void; reject: (e: Error) => void }
  >();
  private buffer = "";
  private workerPath: string;
  private starting: Promise<void> | null = null;

  constructor(workerPath: string) {
    this.workerPath = workerPath;
  }

  private async ensureProcess(): Promise<void> {
    if (this.proc) return;
    if (this.starting) return this.starting;

    this.starting = (async () => {
      this.proc = Bun.spawn(["bun", "run", this.workerPath], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      });

      this.readLoop();
    })();

    await this.starting;
    this.starting = null;
  }

  private async readLoop(): Promise<void> {
    const stdout = this.proc?.stdout;
    if (!stdout || typeof stdout === "number") return;

    const reader = stdout.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      this.buffer += decoder.decode(value, { stream: true });
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const res: WorkerResponse = JSON.parse(line);
          const handler = this.pending.get(res.id);
          if (handler) {
            this.pending.delete(res.id);
            if (res.error) {
              handler.reject(new Error(res.error));
            } else if (res.embedding) {
              handler.resolve(new Float32Array(res.embedding));
            }
          }
        } catch {}
      }
    }
  }

  async embed(text: string): Promise<Float32Array> {
    await this.ensureProcess();
    const stdin = this.proc?.stdin;
    if (!stdin || typeof stdin === "number")
      throw new Error("Worker process not available");

    const id = crypto.randomUUID();
    const request = JSON.stringify({ id, text }) + "\n";

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      stdin.write(request);

      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("Embedding request timed out"));
        }
      }, 30000);
    });
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const results: Float32Array[] = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }

  shutdown(): void {
    this.proc?.kill();
    this.proc = null;
  }
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

export function meanVector(vectors: Float32Array[]): Float32Array {
  if (vectors.length === 0) return new Float32Array(0);

  const dim = vectors[0].length;
  const mean = new Float32Array(dim);

  for (const vec of vectors) {
    for (let i = 0; i < dim; i++) {
      mean[i] += vec[i];
    }
  }

  for (let i = 0; i < dim; i++) {
    mean[i] /= vectors.length;
  }

  return mean;
}

export interface SectorEmbeddings {
  sector: Sector;
  vector: Float32Array;
}

export async function embedWithSectorContext(
  provider: EmbeddingProvider,
  content: string,
  sector: Sector,
): Promise<SectorEmbeddings> {
  const sectorPrefixes: Record<Sector, string> = {
    code_change: "Code modification: ",
    debugging: "Debugging issue: ",
    architecture: "Architecture decision: ",
    discussion: "Discussion: ",
    procedural: "Process or procedure: ",
  };

  const prefixedContent = sectorPrefixes[sector] + content;
  const vector = await provider.embed(prefixedContent);

  return { sector, vector };
}

export async function embedMultiSector(
  provider: EmbeddingProvider,
  content: string,
  sectors: Sector[],
): Promise<SectorEmbeddings[]> {
  const results: SectorEmbeddings[] = [];

  for (const sector of sectors) {
    const embedding = await embedWithSectorContext(provider, content, sector);
    results.push(embedding);
  }

  return results;
}

export interface EmbeddingProviderOptions {
  toast?: ToastCallback;
  ollamaConfig?: OllamaEmbeddingConfig;
  workerPath?: string;
}

export async function createEmbeddingProvider(
  options: EmbeddingProviderOptions = {},
): Promise<EmbeddingProvider> {
  const { toast, ollamaConfig, workerPath } = options;

  if (workerPath) {
    try {
      const subprocess = new SubprocessEmbedding(workerPath);
      await subprocess.embed("test");
      return subprocess;
    } catch {}
  }

  try {
    const ollama = new OllamaEmbedding(ollamaConfig);
    await ollama.embed("test");
    return ollama;
  } catch {}

  if (toast) {
    toast("Using synthetic embeddings (local ML and Ollama unavailable)");
  }
  return new SyntheticEmbedding();
}
