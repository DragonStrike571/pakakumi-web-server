import { z } from "zod";

export const algorithmConfigSchema = z.object({
  capital: z.number().positive().finite().max(1_000_000_000),
  minAmount: z.number().positive().finite().max(1_000_000_000),
  multiplier: z.number().gt(1).finite().max(1_000_000),
  targetReturn: z.number().positive().finite().max(1_000_000),
  roundingOption: z
    .enum(["none", "whole", "five", "ten"])
    .optional()
    .default("none"),
  maxPlayable: z.number().positive().finite().max(1_000_000_000).optional(),
});

export const sequenceStepSchema = z.object({
  amount: z.number().positive().finite().max(1_000_000_000),
  cashout: z.number().gt(1).finite().max(1_000_000),
});

export const sequenceConfigSchema = z.object({
  bets: z.array(sequenceStepSchema).min(1).max(10_000),
});

export const outcomeDirectiveSchema = z.object({
  action: z.enum(["strategy", "continue", "reset", "pause", "stop"]),
  pauseRounds: z.number().int().min(0).max(100_000).optional(),
});

export const executionRuleSchema = z.object({
  id: z.string().trim().min(1).max(100),
  event: z.enum(["any", "win", "loss"]).optional().default("any"),
  match: z.enum(["all", "any"]).optional().default("all"),
  conditions: z.array(z.object({
    metric: z.enum([
      "bust", "capital", "profit", "drawdown", "consecutiveWins",
      "consecutiveLosses", "roundsSinceWin", "roundsSinceLoss",
      "roundsSinceLast3000", "totalReserveFunds", "roundIndex",
    ]),
    operator: z.enum(["eq", "neq", "gt", "gte", "lt", "lte"]),
    value: z.number().finite(),
  })).min(1).max(20),
  action: z.object({
    type: z.enum(["stop", "pause", "reset", "continue", "jump"]),
    rounds: z.number().int().min(0).max(100_000).optional(),
    step: z.number().int().min(0).max(10_000).optional(),
  }),
  once: z.boolean().optional().default(false),
});

export const executionConfigSchema = z.object({
  afterWin: outcomeDirectiveSchema.optional(),
  afterLoss: outcomeDirectiveSchema.optional(),
  rules: z.array(executionRuleSchema).max(100).optional(),
  maxBets: z.number().int().positive().max(1_000_000).optional(),
  stopLoss: z.number().positive().finite().max(1_000_000_000).optional(),
  takeProfit: z.number().positive().finite().max(1_000_000_000).optional(),
});

export const strategyConfigSchema = z
  .object({
    type: z.enum(["sequence", "algorithm"]),
    stopAfterWin: z.boolean().optional(),
    autoCashout: z.number().gt(1).finite().max(1_000_000).optional(),
    execution: executionConfigSchema.optional(),
    algorithm: algorithmConfigSchema.optional(),
    sequence: sequenceConfigSchema.optional(),
  })
  .refine(
    (data) => {
      if (data.type === "algorithm") return !!data.algorithm;
      if (data.type === "sequence") return !!data.sequence;
      return false;
    },
    {
      message: "Invalid config for the selected type",
      path: ["config"],
    },
  );

export const createStrategySchema = z.object({
  name: z.string().trim().min(1).max(120),
  config: strategyConfigSchema,
  visibility: z
    .enum(["private", "public", "shared"])
    .optional()
    .default("private"),
});

export const updateStrategySchema = createStrategySchema.partial();
