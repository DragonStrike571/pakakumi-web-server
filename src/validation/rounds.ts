import { z } from "zod";

// Base Schema matching the DB structure (loose types for potential inputs)
export const roundSchema = z.object({
  id: z.uuid(),
  createdAt: z.date(),
  updatedAt: z.date(),
  bust: z.number(), // numeric in DB is string in JS
  bustId: z.string(),
  playersOnline: z.number().int().nullable().optional(),
  playersPlaying: z.number().int().nullable().optional(),
  totalAmountPlayed: z.number().nullable().optional(),
  totalAmountWon: z.number().nullable().optional(),
  totalAmountLost: z.number().nullable().optional(),
  averageAmountPlayed: z.number().nullable().optional(),
  maxAmountPlayed: z.number().nullable().optional(),
  totalReserveFunds: z.number().nullable().optional(),
  roundsSinceLast3000: z.number().int().nullable().optional(),
  gapDetected: z.boolean().optional(),
});

// Schema for creating a new round (omitting system managed fields)
export const insertRoundSchema = z.object({
  bust: z.coerce.number().nonnegative(),
  bustId: z.string().min(1),
  playersOnline: z.number().int().nonnegative().optional(),
  playersPlaying: z.number().int().nonnegative().optional(),
  totalAmountPlayed: z.coerce.number().nonnegative().optional(),
  totalAmountWon: z.coerce.number().nonnegative().optional(),
  totalAmountLost: z.coerce.number().nonnegative().optional(),
  averageAmountPlayed: z.coerce.number().nonnegative().optional(),
  maxAmountPlayed: z.coerce.number().nonnegative().optional(),
  totalReserveFunds: z.coerce.number().nonnegative().optional(),
  roundsSinceLast3000: z.number().int().nonnegative().optional(),
  gapDetected: z.boolean().optional(),
});

// Schema for updating a round
export const updateRoundSchema = insertRoundSchema.partial();

// Schema for analyzing/querying rounds
export const getRoundsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(50),
  page: z.coerce.number().int().min(1).default(1),
  startDate: z.iso.datetime().optional(), // standard ISO string
  endDate: z.iso.datetime().optional(),
  minBust: z.coerce.number().nonnegative().optional(),
  maxBust: z.coerce.number().nonnegative().optional(),
  bustId: z.string().optional(),
  sort: z.enum(["asc", "desc"]).default("desc"),
});

// Schema for validating round ID in params
export const roundIdSchema = z.object({
  id: z.uuid(),
});

// Types inferred from Schemas
export type Round = z.infer<typeof roundSchema>;
export type InsertRound = z.infer<typeof insertRoundSchema>;
export type GetRoundsQuery = z.infer<typeof getRoundsQuerySchema>;
