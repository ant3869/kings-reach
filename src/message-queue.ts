/**
 * FIFO message queue per chat. Prevents race conditions when
 * messages arrive faster than Claude can respond.
 */

type QueuedTask = () => Promise<void>;

const queues = new Map<string, QueuedTask[]>();
const processing = new Set<string>();

export async function enqueue(chatId: string, task: QueuedTask): Promise<void> {
  const q = queues.get(chatId) ?? [];
  q.push(task);
  queues.set(chatId, q);
  if (processing.has(chatId)) {
    return;
  }
  processing.add(chatId);
  try {
    while (queues.get(chatId)?.length) {
      const next = queues.get(chatId)?.shift();
      if (!next) {
        break;
      }
      try {
        await next();
      } catch {
        // Swallow per-task errors so the queue keeps flowing.
        // Callers should handle/log inside their own task.
      }
    }
  } finally {
    processing.delete(chatId);
    if (!queues.get(chatId)?.length) {
      queues.delete(chatId);
    }
  }
}

/** Drop everything waiting behind the message that is running now (it is not in the queue); returns how many were dropped. */
export function clearQueue(chatId: string): number {
  const queue = queues.get(chatId);
  if (!queue) return 0;
  const waiting = queue.length;
  queue.length = 0; // in place: the loop draining this chat holds the same array
  return waiting;
}
