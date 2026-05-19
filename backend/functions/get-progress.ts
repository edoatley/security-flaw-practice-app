import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, tableName } from "../lib/dynamo-client";
import {
  computeCompositeScore,
  DEFAULT_ALGO_PARAMS,
  type AttemptRecord,
  type SpeedMedians,
  type Tier,
} from "../lib/adaptive-difficulty";

const MAX_TIME_MS = 600_000;
const TIER_ORDER: Tier[] = ["BEGINNER", "INTERMEDIATE", "ADVANCED"];

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> => {
  const userId = event.requestContext.authorizer.jwt.claims["sub"] as string;

  const [profileRes, mediansRes] = await Promise.all([
    docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: `USER#${userId}`, SK: "PROFILE" },
      })
    ),
    docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: "CONFIG#SPEED_MEDIANS", SK: "V0" },
      })
    ),
  ]);

  if (!profileRes.Item) {
    return json(404, { error: { code: "USER_NOT_FOUND", message: "User profile not found" } });
  }

  const profile = profileRes.Item;
  const currentTier = profile.currentTier as Tier;
  const lastTransitionTimestamp = (profile.lastTransitionTimestamp as string) ?? "0";

  // Query attempts at the current tier since the last tier transition — mirrors the
  // rolling-window logic in submit-answer.ts so windowSize stays consistent.
  const attemptsRes = await docClient.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      FilterExpression: "tierId = :tier AND #ts > :lastTransition",
      ExpressionAttributeValues: {
        ":pk": `USER#${userId}`,
        ":prefix": "ATTEMPT#",
        ":tier": currentTier,
        ":lastTransition": lastTransitionTimestamp,
      },
      ExpressionAttributeNames: { "#ts": "timestamp" },
      ScanIndexForward: false,
      Limit: 100,
      ProjectionExpression: "snippetId, correct, timeTakenMs, tierId, #ts",
    })
  );

  const window = ((attemptsRes.Items ?? []) as AttemptRecord[])
    .reverse()
    .slice(-DEFAULT_ALGO_PARAMS.tierUpWindow);

  const medians: SpeedMedians = mediansRes.Item
    ? {
        BEGINNER: (mediansRes.Item.medians?.BEGINNER as number) ?? null,
        INTERMEDIATE: (mediansRes.Item.medians?.INTERMEDIATE as number) ?? null,
        ADVANCED: (mediansRes.Item.medians?.ADVANCED as number) ?? null,
        sampleSizes: mediansRes.Item.sampleSizes ?? { BEGINNER: 0, INTERMEDIATE: 0, ADVANCED: 0 },
      }
    : {
        BEGINNER: null,
        INTERMEDIATE: null,
        ADVANCED: null,
        sampleSizes: { BEGINNER: 0, INTERMEDIATE: 0, ADVANCED: 0 },
      };

  const compositeScore = computeCompositeScore(window, medians, DEFAULT_ALGO_PARAMS);

  const correctRate =
    window.length > 0 ? window.filter((a) => a.correct).length / window.length : 0;

  const speedScores = window.map((a) => {
    const sampleSize = medians.sampleSizes[a.tierId] ?? 0;
    const median = medians[a.tierId];
    if (sampleSize < 100 || !median || median <= 0) return 0.5;
    return Math.min(2, Math.max(0, median / a.timeTakenMs)) / 2;
  });
  const rollingSpeedScore =
    speedScores.length > 0
      ? speedScores.reduce((s, v) => s + v, 0) / speedScores.length
      : 0.5;

  const tierIndex = TIER_ORDER.indexOf(currentTier);

  // Forward-simulate attempts until upgrade
  let attemptsUntilUpgrade: number | null = null;
  if (tierIndex < TIER_ORDER.length - 1) {
    if (
      window.length === DEFAULT_ALGO_PARAMS.tierUpWindow &&
      compositeScore >= DEFAULT_ALGO_PARAMS.tierUpThreshold
    ) {
      attemptsUntilUpgrade = 0;
    } else {
      const perfectAttempt: AttemptRecord = {
        correct: true,
        timeTakenMs: 1000,
        tierId: currentTier,
        timestamp: new Date().toISOString(),
      };
      let simWindow = [...window];
      for (let i = 1; i <= 20; i++) {
        simWindow = [...simWindow, perfectAttempt].slice(-DEFAULT_ALGO_PARAMS.tierUpWindow);
        const simScore = computeCompositeScore(simWindow, medians, DEFAULT_ALGO_PARAMS);
        if (
          simWindow.length === DEFAULT_ALGO_PARAMS.tierUpWindow &&
          simScore >= DEFAULT_ALGO_PARAMS.tierUpThreshold
        ) {
          attemptsUntilUpgrade = i;
          break;
        }
      }
    }
  }

  // Forward-simulate attempts until downgrade
  let attemptsUntilDowngrade: number | null = null;
  if (tierIndex > 0) {
    const badAttempt: AttemptRecord = {
      correct: false,
      timeTakenMs: MAX_TIME_MS,
      tierId: currentTier,
      timestamp: new Date().toISOString(),
    };
    let simWindow = [...window];
    for (let i = 1; i <= 10; i++) {
      simWindow = [...simWindow, badAttempt].slice(-DEFAULT_ALGO_PARAMS.tierDownWindow);
      const simScore = computeCompositeScore(simWindow, medians, DEFAULT_ALGO_PARAMS);
      if (
        simWindow.length === DEFAULT_ALGO_PARAMS.tierDownWindow &&
        simScore < DEFAULT_ALGO_PARAMS.tierDownThreshold
      ) {
        attemptsUntilDowngrade = i;
        break;
      }
    }
  }

  const recentAttempts = [...window]
    .reverse()
    .slice(0, 10)
    .map((a) => ({
      snippetId: (a as unknown as Record<string, unknown>).snippetId,
      correct: a.correct,
      tierId: a.tierId,
      timestamp: a.timestamp,
    }));

  return json(200, {
    userId,
    currentTier,
    totalAttempts: profile.totalAttempts ?? 0,
    correctAttempts: profile.correctAttempts ?? 0,
    lifetimeCorrectRate:
      profile.totalAttempts > 0
        ? Math.round((profile.correctAttempts / profile.totalAttempts) * 1000) / 1000
        : 0,
    rolling: {
      windowSize: window.length,
      correctRate: Math.round(correctRate * 1000) / 1000,
      speedScore: Math.round(rollingSpeedScore * 1000) / 1000,
      compositeScore: Math.round(compositeScore * 1000) / 1000,
      attemptsUntilUpgrade,
      attemptsUntilDowngrade,
    },
    recentAttempts,
  });
};
