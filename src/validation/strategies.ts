import { z } from "zod";

export const algorithmConfigSchema = z.object({
  capital: z.number().positive(),
  minAmount: z.number().positive(),
  multiplier: z.number().positive(),
  targetReturn: z.number().positive(),
  roundingOption: z
    .enum(["none", "whole", "five", "ten"])
    .optional()
    .default("none"),
  maxPlayable: z.number().positive().optional(),
});

export const sequenceStepSchema = z.object({
  amount: z.number().positive(),
  cashout: z.number().positive(),
});

export const sequenceConfigSchema = z.object({
  bets: z.array(sequenceStepSchema).min(1),
});

export const strategyConfigSchema = z
  .object({
    type: z.enum(["sequence", "algorithm"]),
    stopAfterWin: z.boolean().optional(),
    autoCashout: z.number().optional(),
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
  name: z.string().min(1),
  config: strategyConfigSchema,
  visibility: z
    .enum(["private", "public", "shared"])
    .optional()
    .default("private"),
});

export const updateStrategySchema = createStrategySchema.partial();
