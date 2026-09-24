// Fireworks FLUX Kontext is async. A request id is not an image.

export interface KontextPollResult {
  url?: string;
  error?: string;
  pending?: boolean;
}

export function interpretKontextPoll(body: unknown): KontextPollResult {
  const row = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const status = String(row.status ?? "");
  if (status === "Error" || status === "Failed") {
    return { error: `Fireworks image generation failed with status ${status}.` };
  }
  if (status === "Ready") {
    const result = row.result && typeof row.result === "object" ? (row.result as Record<string, unknown>) : {};
    const sample = result.sample;
    if (typeof sample === "string" && sample.length > 0) return { url: sample };
    return { error: "Fireworks poll response is Ready but missing result.sample." };
  }
  return { pending: true };
}

export async function fireworksKontextImage(input: {
  endpoint: string;
  apiKey: string;
  modelId: string;
  prompt: string;
  inputImage?: string;
  aspectRatio?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxPolls?: number;
  signal?: AbortSignal;
}): Promise<{ bytes: Buffer; providerRequestId: string; mimeType: string }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const maxPolls = input.maxPolls ?? 20;
  const base = input.endpoint.replace(/\/$/, "");
  const headers = {
    Authorization: `Bearer ${input.apiKey}`,
    "Content-Type": "application/json",
  };
  const body: Record<string, unknown> = {
    prompt: input.prompt,
    output_format: "png",
    safety_tolerance: 2,
  };
  if (input.aspectRatio) body.aspect_ratio = input.aspectRatio;
  if (input.inputImage) body.input_image = input.inputImage;

  const submit = await fetchImpl(`${base}/v1/workflows/${input.modelId}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!submit.ok) {
    throw new Error(`Fireworks image submit HTTP ${submit.status}.`);
  }
  const submitted = (await submit.json()) as { request_id?: string };
  const requestId = submitted.request_id;
  if (!requestId) throw new Error("Fireworks image submit did not return a request id.");

  for (let i = 0; i < maxPolls; i++) {
    const poll = await fetchImpl(`${base}/v1/workflows/${input.modelId}/get_result`, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: requestId }),
    });
    if (!poll.ok) throw new Error(`Fireworks image poll HTTP ${poll.status}.`);
    const interpreted = interpretKontextPoll(await poll.json());
    if (interpreted.url) {
      const file = await fetchImpl(interpreted.url);
      if (!file.ok) throw new Error(`Fireworks image download HTTP ${file.status}.`);
      const bytes = Buffer.from(await file.arrayBuffer());
      if (!bytes.length) throw new Error("Fireworks image download returned zero bytes.");
      const sig = bytes.subarray(0, 12);
      const png = sig[0] === 0x89 && sig[1] === 0x50 && sig[2] === 0x4e && sig[3] === 0x47;
      const jpeg = sig[0] === 0xff && sig[1] === 0xd8 && sig[2] === 0xff;
      const webp = sig.subarray(0, 4).toString("ascii") === "RIFF" && sig.subarray(8, 12).toString("ascii") === "WEBP";
      if (!png && !jpeg && !webp) throw new Error("Fireworks image bytes are not a PNG, JPEG, or WebP.");
      return { bytes, providerRequestId: requestId, mimeType: png ? "image/png" : jpeg ? "image/jpeg" : "image/webp" };
    }
    if (interpreted.error) throw new Error(interpreted.error);
    if (input.signal?.aborted) throw new Error("Fireworks image job cancelled.");
    await sleep(Math.min(1000 * (i + 1), 5000));
  }
  throw new Error("Fireworks image generation timed out before bytes were ready.");
}

export class FireworksKontextProvider {
  constructor(private opts: { endpoint: string; apiKey: string; modelId: string; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> }) {}

  generateImage(prompt: string, signal?: AbortSignal) {
    return fireworksKontextImage({ ...this.opts, prompt, signal });
  }

  editImage(prompt: string, inputImage: string, signal?: AbortSignal) {
    if (!inputImage.trim()) throw new Error("Image edit requires a source image.");
    return fireworksKontextImage({ ...this.opts, prompt, inputImage, signal });
  }

  cancelImageJob(controller: AbortController) {
    controller.abort();
  }
}
