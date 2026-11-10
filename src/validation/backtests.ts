import { z } from "zod";
import { executionConfigSchema, strategyConfigSchema } from "./strategies.js";

const backtestScenarioSchema = executionConfigSchema.extend({
  maxBets: z.number().int().min(0).max(1_000_000).optional(),
  stopLoss: z.number().nonnegative().finite().max(1_000_000_000).optional(),
  takeProfit: z.number().nonnegative().finite().max(1_000_000_000).optional(),
});

export const runBacktestSchema = z.object({
  strategyId: z.uuid().optional(),
  strategy: strategyConfigSchema.optional(),
  name: z.string().trim().min(1).max(120).optional(),
  initialCapital: z.number().positive().finite().max(1_000_000_000),
  source: z.enum(["recorded", "examples"]).default("recorded"),
  exampleRounds: z.array(z.number().finite().min(1).max(1_000_000)).min(1).max(10_000).optional(),
  range: z.object({
    startDate: z.iso.datetime().optional(),
    endDate: z.iso.datetime().optional(),
    limit: z.number().int().min(1).max(250_000).default(50_000),
    all: z.boolean().optional(),
  }).default({ limit: 50_000 }),
  scenario: backtestScenarioSchema.optional(),
  includeLedger: z.boolean().optional().default(false),
}).superRefine((value, context) => {
  if (Boolean(value.strategyId) === Boolean(value.strategy)) {
    context.addIssue({
      code: "custom",
      path: ["strategyId"],
      message: "Provide exactly one of strategyId or strategy",
    });
  }
  if (value.range.startDate && value.range.endDate &&
      value.range.startDate > value.range.endDate) {
    context.addIssue({
      code: "custom",
      path: ["range", "endDate"],
      message: "endDate must be after startDate",
    });
  }
});
