import { DynamoDBClient, QueryCommand, DeleteItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { ENV } from "./env";

const client = new DynamoDBClient({ region: ENV.AWS_REGION });

/** Delete all DynamoDB items for a user (profile + all attempts). */
export async function purgeUserData(userId: string): Promise<void> {
  const res = await client.send(
    new QueryCommand({
      TableName: ENV.TABLE_NAME,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: marshall({ ":pk": `USER#${userId}` }),
      ProjectionExpression: "PK, SK",
    })
  );
  for (const item of res.Items ?? []) {
    const { PK, SK } = unmarshall(item);
    await client.send(
      new DeleteItemCommand({
        TableName: ENV.TABLE_NAME,
        Key: marshall({ PK, SK }),
      })
    );
  }
}

/** Seed a minimum speed medians config so speed scores are not all neutral. */
export async function seedSpeedMedians(): Promise<void> {
  await client.send(
    new PutItemCommand({
      TableName: ENV.TABLE_NAME,
      Item: marshall({
        PK: "CONFIG#SPEED_MEDIANS",
        SK: "V0",
        entityType: "CONFIG",
        configKey: "SPEED_MEDIANS",
        value: {
          BEGINNER: 60_000,
          INTERMEDIATE: 90_000,
          ADVANCED: 180_000,
          sampleSizes: { BEGINNER: 150, INTERMEDIATE: 120, ADVANCED: 100 },
          computedAt: new Date().toISOString(),
        },
        updatedAt: new Date().toISOString(),
      }),
    })
  );
}

/** Read the current user profile from DynamoDB (for tier verification). */
export async function getUserProfile(userId: string): Promise<Record<string, unknown> | null> {
  const { Items } = await client.send(
    new QueryCommand({
      TableName: ENV.TABLE_NAME,
      KeyConditionExpression: "PK = :pk AND SK = :sk",
      ExpressionAttributeValues: marshall({ ":pk": `USER#${userId}`, ":sk": "PROFILE" }),
    })
  );
  return Items && Items.length > 0 ? unmarshall(Items[0]) : null;
}

/** Count attempt records for a user. */
export async function countAttempts(userId: string): Promise<number> {
  const res = await client.send(
    new QueryCommand({
      TableName: ENV.TABLE_NAME,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: marshall({ ":pk": `USER#${userId}`, ":prefix": "ATTEMPT#" }),
      Select: "COUNT",
    })
  );
  return res.Count ?? 0;
}
