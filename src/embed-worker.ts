import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";

const MODEL = "Xenova/bge-small-en-v1.5";

interface Request {
  id: string;
  text: string;
}

interface Response {
  id: string;
  embedding?: number[];
  error?: string;
}

const SKIP_PATTERNS = [
  /^\[BACKGROUND TASK/i,
  /^\[search-mode\]/i,
  /^\[analyze-mode\]/i,
  /^┌──\[/,
  /^└─[❯>]/,
  /^Thinking:/i,
  /^→\s*(Read|Edit|Write|Glob|Grep)/i,
];

const NOISE_PATTERNS = [
  /\[BACKGROUND TASK COMPLETED\][^\n]*/g,
  /^Thinking:.*$/gm,
  /^→\s*(Read|Edit|Write|Glob|Grep)[^\n]*/gm,
  /┌──\[[^\]]+\]─[^\n]*/g,
  /└─[❯>][^\n]*/g,
  /```[\s\S]*?```/g,
];

function shouldSkip(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 20) return true;
  if (/^(continue|yes|no|ok|done|thanks|y|n)$/i.test(trimmed)) return true;
  return SKIP_PATTERNS.some((p) => p.test(trimmed));
}

function preprocess(text: string): string {
  let cleaned = text;
  for (const pattern of NOISE_PATTERNS) {
    cleaned = cleaned.replace(pattern, " ");
  }
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  if (cleaned.length > 1000) {
    cleaned = cleaned.substring(0, 1000);
  }
  return cleaned;
}

let extractor: FeatureExtractionPipeline | null = null;

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractor) {
    extractor = await pipeline("feature-extraction", MODEL, {
      quantized: true,
    });
  }
  return extractor;
}

async function embed(text: string): Promise<number[] | null> {
  if (shouldSkip(text)) return null;
  const cleaned = preprocess(text);
  if (cleaned.length < 20) return null;

  const ext = await getExtractor();
  const output = await ext(cleaned, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array);
}

async function processLine(line: string): Promise<void> {
  if (!line.trim()) return;

  let req: Request;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }

  const res: Response = { id: req.id };

  try {
    const embedding = await embed(req.text);
    if (embedding) {
      res.embedding = embedding;
    } else {
      res.error = "skipped";
    }
  } catch (e) {
    res.error = e instanceof Error ? e.message : String(e);
  }

  console.log(JSON.stringify(res));
}

const decoder = new TextDecoder();
const reader = Bun.stdin.stream().getReader();
let buffer = "";

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";

  for (const line of lines) {
    await processLine(line);
  }
}

if (buffer.trim()) {
  await processLine(buffer);
}
