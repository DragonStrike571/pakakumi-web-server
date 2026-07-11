import {
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  numeric,
  index,
  jsonb,
  boolean,
  real,
} from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(), // Changed to text for Better Auth compatibility
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => new Date()),
    name: text("name").notNull(),
    email: text("email").unique().notNull(),
    phone: text("phone").unique(), // Made optional if better-auth doesn't require it initially
    passwordHash: text("password_hash"), // Made optional as auth might use Account table
    emailVerified: boolean("email_verified").default(false).notNull(),
    image: text("image"),
    role: text("role").default("user").notNull(),
    accessStatus: text("access_status").default("pending").notNull(),
  },
  (table) => [
    index("email_idx").on(table.email),
    index("phone_idx").on(table.phone),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => new Date()),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id") // Changed to text
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_user_idx").on(table.userId)],
);

export const accounts = pgTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id") // Changed to text
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      mode: "date",
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      mode: "date",
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (table) => [index("account_user_idx").on(table.userId)],
);

export const verifications = pgTable(
  "verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const rounds = pgTable(
  "rounds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => new Date()),
    bust: numeric("bust", { mode: "number" }).notNull(),
    bustId: text("bust_id").notNull(),
    playersOnline: integer("players_online"),
    playersPlaying: integer("players_playing"),
    totalAmountPlayed: numeric("total_amount_played", { mode: "number" }),
    totalAmountWon: numeric("total_amount_won", { mode: "number" }),
    totalAmountLost: numeric("total_amount_lost", { mode: "number" }),
    averageAmountPlayed: numeric("average_amount_played", { mode: "number" }),
    maxAmountPlayed: numeric("max_amount_played", { mode: "number" }),
    // This specifically covers the total
    // amount they have since the last 3,000 was observed
    totalReserveFunds: numeric("total_reserve_funds", { mode: "number" }),
    roundsSinceLast3000: integer("rounds_since_last_3000"),
    gapDetected: boolean("gap_detected").default(false).notNull(),
  },
  (table) => [
    index("created_at_idx").on(table.createdAt),
    index("bust_id_idx").on(table.bustId),
  ],
);

export const strategies = pgTable(
  "strategies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id") // Changed to text
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    type: text("type").notNull(), // 'sequence' | 'algorithm'
    config: jsonb("config").notNull(), // Flexible configuration
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => new Date()),
    visibility: text("visibility").notNull().default("private"), // 'private', 'public', 'shared'
  },
  (table) => [index("strategies_user_idx").on(table.userId)],
);

export const strategyAccess = pgTable(
  "strategy_access",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    strategyId: uuid("strategy_id")
      .notNull()
      .references(() => strategies.id, { onDelete: "cascade" }),
    userId: text("user_id") // Changed to text
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("strategy_access_strategy_idx").on(table.strategyId),
    index("strategy_access_user_idx").on(table.userId),
  ],
);

export const botSessions = pgTable(
  "bot_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id") // Changed to text
      .notNull()
      .references(() => users.id),
    strategyId: uuid("strategy_id")
      .notNull()
      .references(() => strategies.id),
    status: text("status").notNull(), // 'active', 'stopped', 'completed', 'failed'
    initialCapital: numeric("initial_capital", { mode: "number" }).notNull(),
    currentCapital: numeric("current_capital", { mode: "number" }).notNull(),
    totalProfit: numeric("total_profit", { mode: "number" }).notNull(),
    logs: jsonb("logs").$type<string[]>(), // Array of log strings
    currentStep: integer("current_step").default(0), // Track progress in sequence
    startedAt: timestamp("started_at", { mode: "date" }).defaultNow().notNull(),
    endedAt: timestamp("ended_at", { mode: "date" }),
  },
  (table) => [
    index("bot_sessions_user_idx").on(table.userId),
    index("bot_sessions_status_idx").on(table.status),
  ],
);

export const pakakumiCredentials = pgTable(
  "pakakumi_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    label: text("label").notNull(), // e.g. "My Main Account"
    phone: text("phone").notNull(), // encrypted
    password: text("password").notNull(), // encrypted
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (table) => [index("pakakumi_credentials_user_idx").on(table.userId)],
);

export const telegramUsers = pgTable(
  "telegram_users",
  {
    chatId: text("chat_id").primaryKey(),
    username: text("username"),
    expiryTimestamp: timestamp("expiry_timestamp", { mode: "date" }),
    sessionState: text("session_state").notNull().default("command"), // 'command' | 'support'
    language: text("language").notNull().default("en"), // 'en' | 'sw' — for Swahili toggle
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (table) => [index("telegram_users_session_idx").on(table.sessionState)],
);

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chatId: text("chat_id")
      .notNull()
      .references(() => telegramUsers.chatId),
    amount: integer("amount").notNull(),
    status: text("status").default("pending").notNull(), // 'pending', 'success', 'failed'
    durationPaidFor: numeric("duration_paid_for", { mode: "number" }).notNull(), // in days
    reference: text("reference").notNull().unique(), // Paystack reference
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (table) => [
    index("payments_chat_id_idx").on(table.chatId),
    index("payments_reference_idx").on(table.reference),
  ],
);

export const supportTickets = pgTable(
  "support_tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chatId: text("chat_id")
      .notNull()
      .references(() => telegramUsers.chatId),
    message: text("message").notNull(),
    status: text("status").default("open").notNull(), // 'open', 'resolved'
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (table) => [
    index("support_tickets_chat_id_idx").on(table.chatId),
    index("support_tickets_status_idx").on(table.status),
  ],
);

export const systemStats = pgTable("system_stats", {
  id: integer("id").primaryKey().default(1), // Single row table
  hits: integer("hits").notNull().default(0),
  signals: integer("signals").notNull().default(0),
  lastAlertRound: integer("last_alert_round").notNull().default(0),
});

export const pendingSignals = pgTable("pending_signals", {
  id: text("id").primaryKey(), // We'll use the target as the ID to avoid duplicates
  target: real("target").notNull(),
  confidence: integer("confidence").notNull(),
  roundsElapsed: integer("rounds_elapsed").notNull().default(0),
  maxLifespan: integer("max_lifespan").notNull(),
  cooldownExpiry: integer("cooldown_expiry").notNull().default(0), // round index at which cooldown expires
  reason: text("reason"), // Human-readable reason for the signal
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
});

export const signalHistory = pgTable(
  "signal_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    target: real("target").notNull(),
    confidence: integer("confidence").notNull(),
    outcome: text("outcome").notNull().default("pending"), // 'pending', 'hit', 'missed'
    reason: text("reason"), // Why was this alert sent
    expectedRoundsRemaining: integer("expected_rounds_remaining"),
    actualRoundsToHit: integer("actual_rounds_to_hit"), // filled when resolved
    bustValue: real("bust_value"), // the bust that resolved this signal
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { mode: "date" }),
  },
  (table) => [
    index("signal_history_target_idx").on(table.target),
    index("signal_history_outcome_idx").on(table.outcome),
    index("signal_history_created_idx").on(table.createdAt),
  ],
);

export const analysisSnapshots = pgTable("analysis_snapshots", {
  id: integer("id").primaryKey().default(1), // Single row — always the latest snapshot
  activeSignals: jsonb("active_signals").$type<
    {
      target: number;
      confidence: number;
      expectedRoundsRemaining: number;
      status: string;
      reason: string;
      roundsElapsed: number;
    }[]
  >(),
  upcomingOpportunities: jsonb("upcoming_opportunities").$type<
    {
      target: number;
      confidence: number;
      expectedRoundsRemaining: number;
      reason: string;
    }[]
  >(),
  stats: jsonb("stats").$type<{
    totalSignals: number;
    totalHits: number;
    accuracy: number;
    roundsAnalyzed: number;
  }>(),
  updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull(),
});

export const dailyStats = pgTable("daily_stats", {
  date: text("date").primaryKey(), // "2026-06-27" in EAT timezone
  totalPredictions: integer("total_predictions").default(0).notNull(),
  totalHits: integer("total_hits").default(0).notNull(),
  totalMisses: integer("total_misses").default(0).notNull(),
  targets: jsonb("targets")
    .$type<
      {
        target: number;
        hit: boolean;
        resolved: boolean;
        roundsToHit?: number;
        createdAt: string;
        resolvedAt?: string;
      }[]
    >()
    .default([])
    .notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull(),
});

export const autoPlayConfig = pgTable(
  "auto_play_config",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    strategyId: uuid("strategy_id").references(() => strategies.id),
    credentialId: uuid("credential_id").references(() => pakakumiCredentials.id),
    maxLossPerPlay: numeric("max_loss_per_play", { mode: "number" }), // Max capital to risk per auto-play
    maxDailyLoss: numeric("max_daily_loss", { mode: "number" }), // Global daily loss cap
    capitalPercentage: real("capital_percentage").notNull().default(5), // 5-10% of capital
    cooldownMinutes: integer("cooldown_minutes").notNull().default(30),
    minClusterSize: integer("min_cluster_size").notNull().default(3), // Minimum correlation targets
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (table) => [index("auto_play_config_user_idx").on(table.userId)],
);

export const autoPlayOpportunities = pgTable(
  "auto_play_opportunities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clusterTargets: jsonb("cluster_targets").$type<number[]>().notNull(), // e.g. [30, 35, 40, 45]
    selectedTarget: real("selected_target").notNull(), // The lower-set target below median
    medianTarget: real("median_target").notNull(),
    clusterSize: integer("cluster_size").notNull(),
    avgConfidence: integer("avg_confidence").notNull(),
    status: text("status").notNull().default("pending"), // 'pending' | 'claimed' | 'completed' | 'expired'
    claimedBy: text("claimed_by").references(() => users.id),
    sessionId: uuid("session_id").references(() => botSessions.id),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
  },
  (table) => [
    index("auto_play_opp_status_idx").on(table.status),
    index("auto_play_opp_created_idx").on(table.createdAt),
  ],
);
