import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { docClient, tableName } from "../lib/dynamo-client";
import {
  computeCompositeScore,
  evaluateTierTransition,
  DEFAULT_ALGO_PARAMS,
  TIER_ORDER,
  type AttemptRecord,
  type SpeedMedians,
  type Tier,
} from "../lib/adaptive-difficulty";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TIME_MS = 600_000;

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

// Module-level cache for speed medians (5-min TTL)
let cachedMedians: SpeedMedians | null = null;
let mediansExpiry = 0;

async function getSpeedMedians(): Promise<SpeedMedians> {
  if (cachedMedians && Date.now() < mediansExpiry) return cachedMedians;

  const fallback: SpeedMedians = {
    BEGINNER: null,
    INTERMEDIATE: null,
    ADVANCED: null,
    sampleSizes: { BEGINNER: 0, INTERMEDIATE: 0, ADVANCED: 0 },
  };

  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: "CONFIG#SPEED_MEDIANS", SK: "V0" },
      })
    );
    if (result.Item) {
      const item = result.Item;
      cachedMedians = {
        BEGINNER: (item.value?.BEGINNER as number) ?? null,
        INTERMEDIATE: (item.value?.INTERMEDIATE as number) ?? null,
        ADVANCED: (item.value?.ADVANCED as number) ?? null,
        sampleSizes: item.value?.sampleSizes ?? { BEGINNER: 0, INTERMEDIATE: 0, ADVANCED: 0 },
      };
    } else {
      cachedMedians = fallback;
    }
  } catch {
    cachedMedians = fallback;
  }

  mediansExpiry = Date.now() + 5 * 60 * 1000;
  return cachedMedians;
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> => {
  const userId = event.requestContext.authorizer.jwt.claims["sub"] as string;

  // Step 1: Parse and validate body
  let body: { snippetId?: unknown; selectedLines?: unknown; timeTakenMs?: unknown };
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return json(400, { error: { code: "INVALID_REQUEST_BODY", message: "Body must be valid JSON" } });
  }

  const { snippetId, selectedLines, timeTakenMs } = body;

  if (!snippetId || typeof snippetId !== "string" || !UUID_RE.test(snippetId)) {
    return json(400, { error: { code: "INVALID_SNIPPET_ID", message: "snippetId must be a valid UUID" } });
  }

  if (!Array.isArray(selectedLines) || selectedLines.length === 0) {
    return json(400, { error: { code: "INVALID_SELECTED_LINES", message: "selectedLines must be a non-empty array" } });
  }

  for (const line of selectedLines) {
    if (!Number.isInteger(line) || line < 1) {
      return json(400, { error: { code: "INVALID_LINE_NUMBER", message: `Invalid line number: ${line}` } });
    }
  }

  if (timeTakenMs === undefined || timeTakenMs === null || !Number.isInteger(timeTakenMs) || (timeTakenMs as number) < 0) {
    return json(400, { error: { code: "INVALID_TIME_TAKEN", message: "timeTakenMs must be a non-negative integer" } });
  }

  const clampedTimeTaken = Math.min(timeTakenMs as number, MAX_TIME_MS);

  // Step 2: Parallel fetches — snippet metadata + user profile + speed medians
  const [snippetRes, profileRes, medians] = await Promise.all([
    docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: `SNIPPET#${snippetId}`, SK: "METADATA" },
        ConsistentRead: true,
      })
    ),
    docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: `USER#${userId}`, SK: "PROFILE" },
        ConsistentRead: true,
      })
    ),
    getSpeedMedians(),
  ]);

  if (!snippetRes.Item) {
    return json(404, { error: { code: "SNIPPET_NOT_FOUND", message: "Snippet not found" } });
  }
  if (!profileRes.Item) {
    return json(404, { error: { code: "USER_NOT_FOUND", message: "User profile not found" } });
  }

  const snippet = snippetRes.Item;
  const profile = profileRes.Item;
  const currentTier = profile.currentTier as Tier;

  // Step 3: Post-fetch validation
  const lineCount = snippet.lineCount as number;
  const vulnerableLineCount = snippet.vulnerableLineCount as number;

  for (const line of selectedLines as number[]) {
    if (line > lineCount) {
      return json(400, { error: { code: "LINE_OUT_OF_RANGE", message: `Line ${line} exceeds snippet line count ${lineCount}` } });
    }
  }

  if ((selectedLines as number[]).length > vulnerableLineCount) {
    return json(400, { error: { code: "TOO_MANY_LINES", message: `Too many lines selected; max is ${vulnerableLineCount}` } });
  }

  // Step 4: Score correctness (set equality)
  const vulnerableLines = (snippet.vulnerableLines as number[]).slice().sort((a, b) => a - b);
  const submitted = (selectedLines as number[]).slice().sort((a, b) => a - b);
  const correct =
    submitted.length === vulnerableLines.length &&
    submitted.every((line, i) => line === vulnerableLines[i]);

  // Step 5: Query rolling window (last 20 attempts at current tier since last transition)
  const lastTransitionTimestamp = (profile.lastTransitionTimestamp as string) ?? "0";

  const windowResult = await docClient.send(
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
      Limit: 20,
      ProjectionExpression: "correct, timeTakenMs, tierId, #ts",
    })
  );

  const historicalWindow = ((windowResult.Items ?? []) as AttemptRecord[]).reverse();

  // Include the current attempt at the front of the effective window
  const timestamp = new Date().toISOString();
  const currentAttempt: AttemptRecord = {
    correct,
    timeTakenMs: clampedTimeTaken,
    tierId: currentTier,
    timestamp,
  };

  const effectiveWindow20 = [currentAttempt, ...historicalWindow].slice(0, 20);
  const effectiveWindow10 = effectiveWindow20.slice(0, 10);

  // Step 6: Compute composite scores
  const composite20 = computeCompositeScore(effectiveWindow20, medians, DEFAULT_ALGO_PARAMS);
  const composite10 = computeCompositeScore(effectiveWindow10, medians, DEFAULT_ALGO_PARAMS);

  // Step 7: Evaluate tier transition
  const transition = evaluateTierTransition(
    currentTier,
    effectiveWindow20,
    effectiveWindow10,
    composite20,
    composite10,
    DEFAULT_ALGO_PARAMS
  );

  // Step 8: Transactionally write attempt + update profile
  const attemptSK = `ATTEMPT#${timestamp}#${snippetId}`;
  const newTier = transition.newTier;

  let updateExpression =
    "SET currentTier = :tier, updatedAt = :now, totalAttempts = totalAttempts + :one";
  const expressionValues: Record<string, unknown> = {
    ":tier": newTier,
    ":now": timestamp,
    ":one": 1,
  };

  if (correct) {
    updateExpression += ", correctAttempts = correctAttempts + :one";
  }

  if (transition.changed) {
    updateExpression += ", lastTransitionTimestamp = :now, lastTransitionType = :transType";
    expressionValues[":transType"] = TIER_ORDER.indexOf(newTier) > TIER_ORDER.indexOf(currentTier) ? "PROMOTION" : "DEMOTION";
  }

  try {
    await docClient.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: {
                PK: `USER#${userId}`,
                SK: attemptSK,
                snippetId,
                correct,
                submittedLines: submitted,
                timeTakenMs: clampedTimeTaken,
                tierId: currentTier,
                timestamp,
              },
              ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
            },
          },
          {
            Update: {
              TableName: tableName,
              Key: { PK: `USER#${userId}`, SK: "PROFILE" },
              UpdateExpression: updateExpression,
              ExpressionAttributeValues: expressionValues,
            },
          },
        ],
      })
    );
  } catch (err: unknown) {
    if (err instanceof TransactionCanceledException) {
      const reasons = err.CancellationReasons ?? [];
      if (reasons.some((r) => r.Code === "ConditionalCheckFailed")) {
        return json(409, { error: { code: "ALREADY_SUBMITTED", message: "This answer has already been submitted" } });
      }
    }
    console.error(JSON.stringify({ level: "error", message: "transact_write_failed", error: String(err) }));
    return json(500, { error: { code: "DYNAMO_ERROR", message: "Failed to record attempt" } });
  }

  // Step 9: Build response
  const correctRate = effectiveWindow20.filter((a) => a.correct).length / effectiveWindow20.length;
  const speedScores = effectiveWindow20.map((a) => {
    const sampleSize = medians.sampleSizes[a.tierId] ?? 0;
    const median = medians[a.tierId];
    if (sampleSize < 100 || !median || median <= 0) return 0.5;
    return Math.min(2, Math.max(0, median / a.timeTakenMs)) / 2;
  });
  const rollingSpeedScore = speedScores.reduce((s, v) => s + v, 0) / speedScores.length;

  const response: Record<string, unknown> = {
    correct,
    score: {
      rollingCorrectRate: Math.round(correctRate * 1000) / 1000,
      rollingSpeedScore: Math.round(rollingSpeedScore * 1000) / 1000,
      compositeScore: Math.round(composite20 * 1000) / 1000,
      windowSize: effectiveWindow20.length,
    },
    tierChange: {
      previous: currentTier,
      current: newTier,
      changed: transition.changed,
    },
  };

  if (correct) {
    response.snippet = {
      vulnerableLines,
      owaspCategory: snippet.owaspCategory,
      explanation: snippet.explanation,
    };
  }

  return json(200, response);
};
