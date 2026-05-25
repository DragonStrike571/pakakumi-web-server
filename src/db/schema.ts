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
} from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(), // Changed to text for Better Auth compatibility
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => new Date()),
    name: text("name").notNull(),
    email: text("email").unique().notNull(),
    phone: text("phone").unique(), // Made optional if better-auth doesn't require it initially
    passwordHash: text("password_hash"), // Made optional as auth might use Account table
    emailVerified: boolean("email_verified").default(false).notNull(),
    image: text("image"),
  },
  (table) => [
    index("email_idx").on(table.email),
    index("phone_idx").on(table.phone),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(), // Better Auth uses text IDs for sessions usually alongside UUID users? Or should I use UUID? schema generated text. I'll stick to text for session ID to avoid issues, but USER ID is UUID.
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
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
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
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
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
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
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
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
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
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
    createdAt: timestamp("created_at").defaultNow().notNull(),
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
    startedAt: timestamp("started_at").defaultNow().notNull(),
    endedAt: timestamp("ended_at"),
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
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (table) => [index("pakakumi_credentials_user_idx").on(table.userId)],
);
