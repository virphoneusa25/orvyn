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
}): Promise<{ url: string }> {
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
    if (interpreted.url) return { url: interpreted.url };
    if (interpreted.error) throw new Error(interpreted.error);
    await sleep(i === 0 ? 0 : 500);
  }
  throw new Error("Fireworks image generation timed out before bytes were ready.");
}
