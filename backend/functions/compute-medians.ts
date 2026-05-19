import { ScanCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, tableName } from "../lib/dynamo-client";
import type { Tier } from "../lib/adaptive-difficulty";

// @spec DIFF-027, DIFF-028, DIFF-029, DIFF-030

const MIN_TIME_MS = 3_000;
const MAX_TIME_MS = 600_000;
const TIERS: Tier[] = ["BEGINNER", "INTERMEDIATE", "ADVANCED"];

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : sorted[mid - 1];
}

async function scanAttempts(): Promise<{ tierId: string; timeTakenMs: number }[]> {
  const records: { tierId: string; timeTakenMs: number }[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const res = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: "begins_with(SK, :prefix)",
        ExpressionAttributeValues: { ":prefix": "ATTEMPT#" },
        ProjectionExpression: "tierId, timeTakenMs",
        ExclusiveStartKey: lastKey,
      })
    );
    for (const item of res.Items ?? []) {
      if (typeof item.tierId === "string" && typeof item.timeTakenMs === "number") {
        records.push({ tierId: item.tierId, timeTakenMs: item.timeTakenMs });
      }
    }
    lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  return records;
}

export const handler = async (): Promise<void> => {
  const attempts = await scanAttempts();

  const byTier: Record<string, number[]> = { BEGINNER: [], INTERMEDIATE: [], ADVANCED: [] };
  for (const { tierId, timeTakenMs } of attempts) {
    if (TIERS.includes(tierId as Tier) && timeTakenMs >= MIN_TIME_MS && timeTakenMs <= MAX_TIME_MS) {
      byTier[tierId].push(timeTakenMs);
    }
  }

  for (const tier of TIERS) {
    byTier[tier].sort((a, b) => a - b);
  }

  const now = new Date().toISOString();
  const value = {
    BEGINNER: median(byTier.BEGINNER),
    INTERMEDIATE: median(byTier.INTERMEDIATE),
    ADVANCED: median(byTier.ADVANCED),
    sampleSizes: {
      BEGINNER: byTier.BEGINNER.length,
      INTERMEDIATE: byTier.INTERMEDIATE.length,
      ADVANCED: byTier.ADVANCED.length,
    },
    computedAt: now,
  };

  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        PK: "CONFIG#SPEED_MEDIANS",
        SK: "V0",
        entityType: "CONFIG",
        configKey: "SPEED_MEDIANS",
        value,
        updatedAt: now,
      },
    })
  );

  console.log("ComputeMedians complete", JSON.stringify({ sampleSizes: value.sampleSizes }));
};
