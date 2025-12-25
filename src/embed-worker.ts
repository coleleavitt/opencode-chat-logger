import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";

const MODEL = "Xenova/all-MiniLM-L6-v2";

interface Request {
  id: string;
  text: string;
}

interface Response {
  id: string;
  embedding?: number[];
  error?: string;
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

async function embed(text: string): Promise<number[]> {
  const ext = await getExtractor();
  const output = await ext(text, { pooling: "mean", normalize: true });
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
    res.embedding = await embed(req.text);
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
