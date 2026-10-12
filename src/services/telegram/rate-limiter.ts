/**
 * Global Telegram Rate Limiter
 *
 * All outbound Telegram API calls across the entire bot funnel through this
 * module. It enforces:
 *   - Global cap:    25 messages/second (below Telegram's 30/s hard limit)
 *   - Per-chat cap:  1 message/second per chat (below Telegram's 20/min per group)
 *   - Priority queue: high > normal > low
 *   - Automatic retry on 429 (Too Many Requests) responses
 *
 * Usage:
 *   import { rateLimitedSend, rateLimitedEdit } from "./rate-limiter.js";
 *   await rateLimitedSend(chatId, text, options, "high");
 */

import { bot } from "./bot.js";
import { runQueueWorker } from "./queue-worker.js";

// Grammy doesn't re-export its internal 'Other' type from the main module.
// Since we're just passing options through to bot.api methods, we use 'any'
// for the options parameter. Type checking happens at the consumer call site.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TelegramOptions = any;

// ─── Priority Levels ────────────────────────────────────────────────────────

export type MessagePriority = "high" | "normal" | "low";

const PRIORITY_ORDER: Record<MessagePriority, number> = {
  high: 0,   // Payment confirmations, hit proofs
  normal: 1, // Alerts, command responses
  low: 2,    // Expiry kicks, teasers, non-critical notifications
};

// ─── Queue Item ─────────────────────────────────────────────────────────────

interface QueueItem<T = unknown> {
  priority: MessagePriority;
  chatId: string | number;
  execute: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  enqueuedAt: number;
}

// ─── Rate Limiter State ─────────────────────────────────────────────────────

const GLOBAL_INTERVAL_MS = 40;         // 25 msgs/sec → 1 msg every 40ms
const PER_CHAT_INTERVAL_MS = 1000;     // 1 msg/sec per chat
const MAX_QUEUE_SIZE = 500;            // Safety cap to prevent unbounded memory
const MAX_RETRIES = 3;
const STALE_ITEM_MS = 5 * 60 * 1000;  // Discard items older than 5 minutes

const queue: QueueItem[] = [];
const perChatLastSend = new Map<string, number>();
let isProcessing = false;
let lastGlobalSend = 0;

// Periodic cleanup of stale per-chat entries
const PER_CHAT_CLEANUP_INTERVAL = 60_000;
const PER_CHAT_MAX_SIZE = 5_000;

setInterval(() => {
  if (perChatLastSend.size > PER_CHAT_MAX_SIZE) {
    const now = Date.now();
    for (const [key, timestamp] of perChatLastSend.entries()) {
      if (now - timestamp > 60_000) {
        perChatLastSend.delete(key);
      }
    }
  }
}, PER_CHAT_CLEANUP_INTERVAL).unref();

// ─── Queue Processing ───────────────────────────────────────────────────────

function enqueue<T>(
  chatId: string | number,
  priority: MessagePriority,
  execute: () => Promise<T>,
): Promise<T> {
  if (
    !((typeof chatId === "string" && chatId.trim()) ||
      (typeof chatId === "number" && Number.isSafeInteger(chatId)))
  ) {
    return Promise.reject(new Error("Invalid Telegram chat ID"));
  }
  if (!bot) {
    return Promise.reject(new Error("Bot is not initialized"));
  }

  // Safety: reject if queue is at capacity
  if (queue.length >= MAX_QUEUE_SIZE) {
    return Promise.reject(
      new Error(`Rate limiter queue full (${MAX_QUEUE_SIZE} items). Message dropped.`),
    );
  }

  return new Promise<T>((resolve, reject) => {
    const item: QueueItem<T> = {
      priority,
      chatId,
      execute,
      resolve: resolve as (value: unknown) => void,
      reject,
      enqueuedAt: Date.now(),
    };

    // Insert in priority order (stable: same-priority items stay FIFO)
    const insertIndex = queue.findIndex(
      (existing) =>
        PRIORITY_ORDER[existing.priority] > PRIORITY_ORDER[priority],
    );

    if (insertIndex === -1) {
      queue.push(item as QueueItem);
    } else {
      queue.splice(insertIndex, 0, item as QueueItem);
    }

    scheduleProcessing();
  });
}

function scheduleProcessing() {
  if (isProcessing) return;
  isProcessing = true;
  runWorker();
}

function runWorker() {
  runQueueWorker(processNext, () => {
    isProcessing = false;
    // Restore queue processing after an error outside the per-message handler.
    if (queue.length > 0) setTimeout(scheduleProcessing, GLOBAL_INTERVAL_MS);
  });
}

async function processNext() {
  if (queue.length === 0) {
    isProcessing = false;
    return;
  }

  const now = Date.now();

  // ── Discard stale items ──────────────────────────────────────────────
  while (queue.length > 0 && now - queue[0].enqueuedAt > STALE_ITEM_MS) {
    const stale = queue.shift()!;
    stale.reject(new Error("Rate limiter: item expired (stale for 5+ minutes)"));
  }

  if (queue.length === 0) {
    isProcessing = false;
    return;
  }

  // ── Global rate limit ────────────────────────────────────────────────
  const globalWait = Math.max(0, GLOBAL_INTERVAL_MS - (now - lastGlobalSend));

  // ── Find the first item that satisfies per-chat limit ────────────────
  let selectedIndex = -1;
  let minPerChatWait = Infinity;

  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    const chatKey = item.chatId.toString();
    const lastSend = perChatLastSend.get(chatKey) || 0;
    const chatWait = Math.max(0, PER_CHAT_INTERVAL_MS - (now - lastSend));

    if (chatWait === 0) {
      selectedIndex = i;
      break;
    }

    if (chatWait < minPerChatWait) {
      minPerChatWait = chatWait;
      selectedIndex = i;
    }
  }

  if (selectedIndex === -1) {
    // Queue has items but all are chat-throttled — wait for the shortest
    setTimeout(runWorker, Math.min(minPerChatWait, PER_CHAT_INTERVAL_MS));
    return;
  }

  const item = queue[selectedIndex];
  const chatKey = item.chatId.toString();
  const lastSend = perChatLastSend.get(chatKey) || 0;
  const chatWait = Math.max(0, PER_CHAT_INTERVAL_MS - (now - lastSend));
  const totalWait = Math.max(globalWait, chatWait);

  if (totalWait > 0) {
    setTimeout(runWorker, totalWait);
    return;
  }

  // ── Execute ──────────────────────────────────────────────────────────
  queue.splice(selectedIndex, 1);
  lastGlobalSend = Date.now();
  perChatLastSend.set(chatKey, Date.now());

  try {
    const result = await executeWithRetry(item.execute, MAX_RETRIES);
    item.resolve(result);
  } catch (err) {
    item.reject(err);
  }

  // Schedule next item with minimal delay
  setTimeout(runWorker, GLOBAL_INTERVAL_MS);
}

// ─── Retry Logic (handles 429) ──────────────────────────────────────────────

async function executeWithRetry<T>(
  fn: () => Promise<T>,
  retriesLeft: number,
): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    // Grammy wraps Telegram errors; check for retry_after
    if (
      retriesLeft > 0 &&
      err instanceof Error &&
      "error_code" in (err as any) &&
      (err as any).error_code === 429
    ) {
      const retryAfter =
        ((err as any).parameters?.retry_after || 5) * 1000;
      console.warn(
        `⚠️ Rate limiter: 429 from Telegram, backing off ${retryAfter}ms (${retriesLeft} retries left)`,
      );
      await sleep(retryAfter);
      return executeWithRetry(fn, retriesLeft - 1);
    }
    throw err;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Send a message through the rate-limited queue.
 */
export function rateLimitedSend(
  chatId: string | number,
  text: string,
  options?: TelegramOptions,
  priority: MessagePriority = "normal",
) {
  return enqueue(chatId, priority, () =>
    bot!.api.sendMessage(chatId, text, options),
  );
}

/**
 * Edit a message through the rate-limited queue.
 */
export function rateLimitedEdit(
  chatId: string | number,
  messageId: number,
  text: string,
  options?: TelegramOptions,
  priority: MessagePriority = "normal",
) {
  return enqueue(chatId, priority, () =>
    bot!.api.editMessageText(chatId, messageId, text, options),
  );
}

/**
 * Ban a chat member through the rate-limited queue.
 */
export function rateLimitedBan(
  chatId: string | number,
  userId: number,
  priority: MessagePriority = "low",
) {
  return enqueue(chatId, priority, () =>
    bot!.api.banChatMember(chatId, userId),
  );
}

/**
 * Unban a chat member through the rate-limited queue.
 */
export function rateLimitedUnban(
  chatId: string | number,
  userId: number,
  priority: MessagePriority = "low",
) {
  return enqueue(chatId, priority, () =>
    bot!.api.unbanChatMember(chatId, userId, { only_if_banned: true }),
  );
}

/**
 * Get chat member info (admin check etc.) through the rate-limited queue.
 */
export function rateLimitedGetChatMember(
  chatId: string | number,
  userId: number,
  priority: MessagePriority = "normal",
) {
  return enqueue(chatId, priority, () =>
    bot!.api.getChatMember(chatId, userId),
  );
}

/**
 * Create a chat invite link through the rate-limited queue.
 */
export function rateLimitedCreateInviteLink(
  chatId: string | number,
  options?: TelegramOptions,
  priority: MessagePriority = "high",
) {
  return enqueue(chatId, priority, () =>
    bot!.api.createChatInviteLink(chatId, options),
  );
}

/**
 * Get current queue depth (for health checks / monitoring).
 */
export function getQueueDepth(): number {
  return queue.length;
}
