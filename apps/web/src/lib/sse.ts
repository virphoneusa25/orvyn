/** Split an SSE byte stream into JSON payloads (`data:` frames). */

export function parseSseFrame(frame: string): unknown | undefined {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n")
    .trim();
  if (!data) return undefined;
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

export function consumeSse(buffer: string): { events: unknown[]; rest: string } {
  const frames = buffer.split(/\r?\n\r?\n/);
  const rest = frames.pop() ?? "";
  const events: unknown[] = [];
  for (const frame of frames) {
    const event = parseSseFrame(frame);
    if (event !== undefined) events.push(event);
  }
  return { events, rest };
}

export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: unknown) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const consumed = consumeSse(buffer);
      buffer = consumed.rest;
      for (const event of consumed.events) onEvent(event);
      if (done) {
        const tail = consumeSse(`${buffer}\n\n`);
        for (const event of tail.events) onEvent(event);
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
