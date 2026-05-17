import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

// @spec AUTH-014, AUTH-015, AUTH-016
export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
  let body: unknown;
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return error(400, "INVALID_BODY", "Request body must be valid JSON");
  }

  const refreshToken =
    body !== null &&
    typeof body === "object" &&
    "refresh_token" in body &&
    typeof (body as Record<string, unknown>).refresh_token === "string"
      ? (body as Record<string, string>).refresh_token
      : null;

  if (!refreshToken) {
    return error(400, "MISSING_REFRESH_TOKEN", "refresh_token is required");
  }

  const cookieValue = [
    `refresh_token=${refreshToken}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    "Path=/auth",
    "Max-Age=2592000",
  ].join("; ");

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": cookieValue,
    },
    body: JSON.stringify({ ok: true }),
  };
};

function error(
  statusCode: number,
  code: string,
  message: string
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: { code, message } }),
  };
}
