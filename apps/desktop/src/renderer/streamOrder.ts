// Chronological order for the work stream.
//
// Chat follow-ups are appended to the session, but the attached run's
// activity is a separate block. Painting every chat bubble above that
// block puts a new message at the top of an older mission. Messages
// stamped after run.started belong under the activity, at the bottom.

export interface StreamOrderMessage {
  createdAt?: number;
}

export interface StreamOrderEvent {
  type: string;
  timestamp: number;
}

export interface StreamPartition<T> {
  /** Turns that already existed when this run started. Oldest first. */
  earlier: T[];
  /** Turns sent after this run started. Oldest first, rendered last. */
  later: T[];
}

export function partitionStreamMessages<T extends StreamOrderMessage>(
  messages: T[],
  events: StreamOrderEvent[],
): StreamPartition<T> {
  const started = events.find((e) => e.type === "run.started");
  if (!started) return { earlier: messages, later: [] };
  const runStart = started.timestamp;
  const earlier: T[] = [];
  const later: T[] = [];
  for (const message of messages) {
    if (typeof message.createdAt === "number" && message.createdAt > runStart) later.push(message);
    else earlier.push(message);
  }
  return { earlier, later };
}
