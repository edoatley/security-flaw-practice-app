import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

const COGNITO_DOMAIN = process.env.COGNITO_DOMAIN!;
const COGNITO_CLIENT_ID = process.env.COGNITO_CLIENT_ID!;

const CLEAR_COOKIE = [
  "refresh_token=",
  "HttpOnly",
  "Secure",
  "SameSite=Strict",
  "Path=/auth",
  "Max-Age=0",
].join("; ");

// @spec AUTH-055, AUTH-056, AUTH-057, AUTH-058
export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
  const refreshToken = parseCookie(event.headers["cookie"] ?? "", "refresh_token");

  if (refreshToken) {
    const params = new URLSearchParams({
      token: refreshToken,
      client_id: COGNITO_CLIENT_ID,
    });
    try {
      await fetch(`${COGNITO_DOMAIN}/oauth2/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // best-effort — always clear the cookie regardless
    }
  }

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": CLEAR_COOKIE,
    },
    body: JSON.stringify({ ok: true }),
  };
};

function parseCookie(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key.trim() === name) return rest.join("=").trim();
  }
  return null;
}
