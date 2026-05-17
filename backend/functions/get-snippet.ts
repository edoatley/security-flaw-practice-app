import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, tableName } from "../lib/dynamo-client";
import type { Tier } from "../lib/adaptive-difficulty";

const CLOUDFRONT_DOMAIN = process.env.CLOUDFRONT_DOMAIN!;

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

  // Step 1: Resolve user tier (lazy create profile on first visit)
  let tier: Tier = "BEGINNER";
  try {
    const profileResult = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: `USER#${userId}`, SK: "PROFILE" },
        ConsistentRead: true,
      })
    );

    if (profileResult.Item) {
      tier = profileResult.Item.currentTier as Tier;
    } else {
      // First visit — lazily create profile
      const now = new Date().toISOString();
      try {
        await docClient.send(
          new PutCommand({
            TableName: tableName,
            Item: {
              PK: `USER#${userId}`,
              SK: "PROFILE",
              userId,
              currentTier: "BEGINNER",
              totalAttempts: 0,
              correctAttempts: 0,
              createdAt: now,
              updatedAt: now,
            },
            ConditionExpression: "attribute_not_exists(PK)",
          })
        );
      } catch (err: unknown) {
        // Concurrent creation — retry GetItem once
        if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
          const retry = await docClient.send(
            new GetCommand({
              TableName: tableName,
              Key: { PK: `USER#${userId}`, SK: "PROFILE" },
              ConsistentRead: true,
            })
          );
          if (retry.Item) {
            tier = retry.Item.currentTier as Tier;
          }
        } else {
          throw err;
        }
      }
    }
  } catch (err: unknown) {
    console.error(JSON.stringify({ level: "error", message: "profile_fetch_failed", error: String(err) }));
    return json(500, { error: { code: "PROFILE_INIT_FAILED", message: "Failed to initialise user profile" } });
  }

  // Step 2: Query snippets GSI by difficulty
  let allSnippets: Record<string, unknown>[] = [];
  try {
    const snippetResult = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: "GSI1PK-GSI1SK-index",
        KeyConditionExpression: "GSI1PK = :gsi1pk",
        ExpressionAttributeValues: { ":gsi1pk": `DIFFICULTY#${tier}` },
        ProjectionExpression: "snippetId, contentKey, lineCount, vulnerableLineCount, title, #lang, owaspCategory, difficulty",
        ExpressionAttributeNames: { "#lang": "language" },
        Limit: 200,
      })
    );
    allSnippets = (snippetResult.Items ?? []) as Record<string, unknown>[];
  } catch (err: unknown) {
    console.error(JSON.stringify({ level: "error", message: "snippet_query_failed", error: String(err) }));
    return json(500, { error: { code: "DYNAMO_ERROR", message: "Failed to query snippets" } });
  }

  // Step 4: Handle TIER_COMPLETE (zero snippets before exclusion)
  if (allSnippets.length === 0) {
    return json(200, { status: "TIER_COMPLETE", tier, canReset: true });
  }

  // Step 3: Exclude recently seen snippets (best-effort)
  let exclusionSet = new Set<string>();
  try {
    const recentResult = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: { ":pk": `USER#${userId}`, ":prefix": "ATTEMPT#" },
        ScanIndexForward: false,
        Limit: 5,
        ProjectionExpression: "snippetId",
      })
    );
    exclusionSet = new Set(
      (recentResult.Items ?? []).map((i) => i.snippetId as string)
    );
  } catch {
    // Non-fatal — continue without exclusion
  }

  // Step 5: Random selection after exclusion filter
  let candidates = allSnippets.filter((s) => !exclusionSet.has(s.snippetId as string));
  if (candidates.length === 0) {
    candidates = allSnippets;
  }

  const snippet = candidates[Math.floor(Math.random() * candidates.length)];

  // Step 6: Build response
  const contentUrl = `https://${CLOUDFRONT_DOMAIN}/${snippet.contentKey}`;

  return json(200, {
    snippetId: snippet.snippetId,
    title: snippet.title,
    language: snippet.language,
    owaspCategory: snippet.owaspCategory,
    difficulty: snippet.difficulty,
    lineCount: snippet.lineCount,
    vulnerableLineCount: snippet.vulnerableLineCount,
    contentUrl,
    expiresAt: null,
  });
};
