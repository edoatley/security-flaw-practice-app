import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  AdminDeleteUserCommand,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { ENV } from "./env";

const cognito = new CognitoIdentityProviderClient({ region: ENV.AWS_REGION });

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
}

/**
 * Authenticates a test user via USER_PASSWORD_AUTH flow.
 * Requires ALLOW_USER_PASSWORD_AUTH to be enabled on the Cognito app client
 * (sst.config.ts adds this for non-production stages).
 */
export async function authenticateTestUser(
  email = ENV.TEST_USER_EMAIL,
  password = ENV.TEST_USER_PASSWORD
): Promise<AuthTokens> {
  const res = await cognito.send(
    new InitiateAuthCommand({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: ENV.COGNITO_CLIENT_ID,
      AuthParameters: { USERNAME: email, PASSWORD: password },
    })
  );

  const result = res.AuthenticationResult;
  if (!result?.AccessToken || !result.RefreshToken || !result.IdToken) {
    throw new Error(`Cognito auth failed: ${JSON.stringify(res)}`);
  }

  return {
    accessToken: result.AccessToken,
    refreshToken: result.RefreshToken,
    idToken: result.IdToken,
  };
}

/**
 * Creates a disposable test user in Cognito for isolated test scenarios.
 * The caller is responsible for cleanup via deleteTestUser().
 */
export async function createTestUser(email: string, password: string): Promise<void> {
  await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: ENV.COGNITO_USER_POOL,
      Username: email,
      TemporaryPassword: password,
      MessageAction: "SUPPRESS",
    })
  );
  await cognito.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: ENV.COGNITO_USER_POOL,
      Username: email,
      Password: password,
      Permanent: true,
    })
  );
}

export async function deleteTestUser(email: string): Promise<void> {
  try {
    await cognito.send(
      new AdminDeleteUserCommand({ UserPoolId: ENV.COGNITO_USER_POOL, Username: email })
    );
  } catch {
    // best-effort cleanup
  }
}
