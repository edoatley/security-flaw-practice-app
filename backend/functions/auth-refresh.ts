import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

const COGNITO_DOMAIN = process.env.COGNITO_DOMAIN!;
const COGNITO_CLIENT_ID = process.env.COGNITO_CLIENT_ID!;

// @spec AUTH-023, AUTH-024, AUTH-025, AUTH-026
export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
  const refreshToken = parseCookie(event.headers["cookie"] ?? "", "refresh_token");
  if (!refreshToken) {
    return error(401, "NO_REFRESH_TOKEN", "No refresh token cookie present");
  }

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: COGNITO_CLIENT_ID,
    refresh_token: refreshToken,
  });

  let cognitoRes: Response;
  try {
    cognitoRes = await fetch(`${COGNITO_DOMAIN}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return error(502, "COGNITO_UNREACHABLE", "Failed to reach Cognito token endpoint");
  }

  if (!cognitoRes.ok) {
    return error(401, "REFRESH_FAILED", "Refresh token rejected by Cognito");
  }

  const tokens = (await cognitoRes.json()) as {
    access_token: string;
    expires_in: number;
    id_token?: string;
  };

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      access_token: tokens.access_token,
      expires_in: tokens.expires_in,
    }),
  };
};

function parseCookie(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key.trim() === name) return rest.join("=").trim();
  }
  return null;
}

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
