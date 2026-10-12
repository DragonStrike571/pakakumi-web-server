import { db } from "../db/index.js";
import { rounds } from "../db/schema.js";
import { desc, eq } from "drizzle-orm";
import { trycatch } from "../utils/try-catch.js";

export interface ScrapedRoundData {
  bust: number;
  bustId: string;
  playersOnline: number | null;
  playersPlaying: number | null;
  totalAmountPlayed: number | null;
  totalAmountWon: number | null;
  totalAmountLost: number | null;
  averageAmountPlayed: number | null;
  maxAmountPlayed: number | null;
  metricsComplete: boolean;
  ingestionId?: string;
  sourceGap?: boolean;
}

// How many consecutive non-overlapping bustIds before we declare a gap.
// Each bustId is 10 consecutive bust values joined by "-".
// Consecutive rounds share 9 overlapping segments (last 9 of prev = first 9 of next).
// If 4+ rounds show zero overlap → the scraper was down and we missed rounds.
const OVERLAP_GAP_THRESHOLD = 4;

export class RoundService {
  private lastRoundState: {
    totalReserveFunds: number | null;
    roundsSinceLast3000: number | null;
    lastBustId: string | null;
    consecutiveNonOverlapping: number;
  } = {
    totalReserveFunds: 0,
    roundsSinceLast3000: null,
    lastBustId: null,
    consecutiveNonOverlapping: 0,
  };

  private isInitialized = false;
  private lastSavedTime = 0;

  // Concurrency guard: serializes processRound calls
  private processingQueue: Promise<void> = Promise.resolve();

  constructor(private database: typeof db = db) {}

  /**
   * Initialize the service by fetching the latest round state from the DB.
   * This ensures that server restarts don't reset critical counters.
   */
  async initialize() {
    const { data: lastRound, error } = await trycatch(async () => {
      return await this.database.query.rounds.findFirst({
        orderBy: [desc(rounds.createdAt)],
      });
    });

    if (error) {
      console.error("❌ Failed to initialize RoundService:", error);
      throw error;
    }

    if (lastRound) {
      this.lastSavedTime = lastRound.createdAt.getTime();
      this.lastRoundState = {
        totalReserveFunds: lastRound.totalReserveFunds === null
          ? null
          : Number(lastRound.totalReserveFunds),
        roundsSinceLast3000: lastRound.roundsSinceLast3000,
        lastBustId: lastRound.bustId,
        consecutiveNonOverlapping: 0,
      };
      console.log(
        "✅ RoundService initialized with state:",
        this.lastRoundState,
      );
    } else {
      console.log("⚠️ No previous rounds found. Starting fresh.");
    }

    this.isInitialized = true;
  }

  /**
   * Check if two bustIds have overlapping segments.
   * A bustId is 10 bust values joined by "-", ordered newest-first.
   * Consecutive rounds share 9 overlapping values:
   *   prev: [B_n,   B_n-1, B_n-2, ..., B_n-9]
   *   next: [B_n+1, B_n,   B_n-1, ..., B_n-8]
   *
   * So prev's FIRST 9 segments should equal next's LAST 9 segments.
   */
  private bustIdsOverlap(prevId: string, nextId: string): boolean {
    const prevSegments = prevId.split("-");
    const nextSegments = nextId.split("-");

    // Check overlap for N from 9 down to 4
    for (let n = Math.min(9, prevSegments.length - 1); n >= 4; n--) {
      const prevPrefix = prevSegments.slice(0, n).join("-");
      const nextSuffix = nextSegments.slice(-n).join("-");
      if (prevPrefix === nextSuffix) {
        return true;
      }
    }

    return false;
  }

  /**
   * Process a new round: calculate derived metrics, save to DB, and update state.
   * Uses an internal queue to serialize concurrent calls and protect in-memory state.
   */
  async processRound(data: ScrapedRoundData) {
    // Chain onto the processing queue so calls are serialized
    const resultPromise = this.processingQueue.then(() =>
      this._processRoundInternal(data),
    );

    // Update the queue tail (swallow errors so the chain doesn't break)
    this.processingQueue = resultPromise.then(
      () => {},
      () => {},
    );

    return resultPromise;
  }

  private async _processRoundInternal(data: ScrapedRoundData) {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (data.ingestionId) {
      const existing = await this.database.query.rounds.findFirst({ where: eq(rounds.id, data.ingestionId) });
      if (existing) {
        if (existing.createdAt.getTime() > this.lastSavedTime) {
          this.lastSavedTime = existing.createdAt.getTime();
          this.lastRoundState = { totalReserveFunds: existing.totalReserveFunds, roundsSinceLast3000: existing.roundsSinceLast3000,
            lastBustId: existing.bustId, consecutiveNonOverlapping: 0 };
        }
        return existing;
      }
    }
    const previous = this.lastRoundState;
    const nextState = { ...previous };
    let gapDetected = data.sourceGap === true;
    if (gapDetected) { nextState.totalReserveFunds = null; nextState.roundsSinceLast3000 = null; }

    // ── Gap detection via bustId overlap ─────────────────────────────
    // Compare the suffix of the last bustId with the prefix of the new bustId.
    // If they don't overlap, increment the non-overlapping counter.
    // If the counter reaches the threshold, we declare a data gap.
    if (this.lastRoundState.lastBustId) {
      const overlaps = this.bustIdsOverlap(
        this.lastRoundState.lastBustId,
        data.bustId,
      );

      if (!overlaps) {
        nextState.consecutiveNonOverlapping += 1;

        if (
          nextState.consecutiveNonOverlapping >= OVERLAP_GAP_THRESHOLD
        ) {
          console.warn(
            `⚠️ Data gap detected: ${this.lastRoundState.consecutiveNonOverlapping} consecutive non-overlapping bustIds. Resetting reserve funds.`,
          );
          nextState.totalReserveFunds = null;
          nextState.roundsSinceLast3000 = null;
          gapDetected = true;
          // Reset counter after declaring gap
          nextState.consecutiveNonOverlapping = 0;
        }
      } else {
        // Overlap found — reset counter
        nextState.consecutiveNonOverlapping = 0;
      }
    }

    let newTotalReserveFunds: number | null = nextState.totalReserveFunds;
    let newRoundsSinceLast3000 = nextState.roundsSinceLast3000;

    if (data.bust >= 3000) {
      newTotalReserveFunds = 0;
      newRoundsSinceLast3000 = 0;
    } else {
      if (
        !data.metricsComplete ||
        data.totalAmountLost === null ||
        data.totalAmountWon === null
      ) {
        // Once financial continuity is lost it stays unknown until the next
        // 3000x reset; treating missing values as zero would fabricate reserve.
        newTotalReserveFunds = null;
        gapDetected = true;
      } else if (newTotalReserveFunds !== null) {
        const roundNetRevenue = data.totalAmountLost - data.totalAmountWon;
        newTotalReserveFunds += roundNetRevenue;
      }

      if (newRoundsSinceLast3000 !== null) {
        newRoundsSinceLast3000 += 1;
      }
    }

    const roundPayload: typeof rounds.$inferInsert = {
      id: data.ingestionId,
      createdAt: new Date(Math.max(Date.now(), this.lastSavedTime + 1)),
      bust: data.bust,
      bustId: data.bustId,
      playersOnline: data.playersOnline,
      playersPlaying: data.playersPlaying,
      totalAmountPlayed: data.totalAmountPlayed,
      totalAmountWon: data.totalAmountWon,
      totalAmountLost: data.totalAmountLost,
      averageAmountPlayed: data.averageAmountPlayed,
      maxAmountPlayed: data.maxAmountPlayed,
      totalReserveFunds: newTotalReserveFunds,
      roundsSinceLast3000: newRoundsSinceLast3000,
      gapDetected,
      metricsComplete: data.metricsComplete,
    };

    const { data: savedRound, error } = await trycatch(async () => {
      const result = await this.database.insert(rounds).values(roundPayload).returning();
      return result[0];
    });

    if (error || !savedRound) {
      console.error("❌ Error saving round to DB:", error);
      throw error || new Error("Round insert returned no record");
    }

    const gapLabel = gapDetected ? " [GAP]" : "";
    console.log(
      `💾 Saved round ${data.bust}x (ID: ${data.bustId.substring(0, 20)}...)${gapLabel} | Res: ${newTotalReserveFunds} | Since3k: ${newRoundsSinceLast3000}`,
    );

    // Update in-memory state ONLY after successful save
    this.lastRoundState = {
      totalReserveFunds: newTotalReserveFunds,
      roundsSinceLast3000: newRoundsSinceLast3000,
      lastBustId: data.bustId,
      consecutiveNonOverlapping: nextState.consecutiveNonOverlapping,
    };
    this.lastSavedTime = savedRound.createdAt.getTime();

    return savedRound;
  }

  /**
   * Get the current state (for health checks or internal use)
   */
  getState() {
    return { ...this.lastRoundState };
  }
}

export const roundService = new RoundService();
