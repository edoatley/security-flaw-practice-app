import { readFileSync } from "fs";
import { resolve } from "path";

// Load .sst/outputs.json so tests don't need manual env vars
function loadOutputs(): Record<string, string> {
  try {
    const raw = readFileSync(resolve(__dirname, "../../.sst/outputs.json"), "utf-8");
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

const outputs = loadOutputs();

export const ENV = {
  API_URL:           process.env.E2E_API_URL          ?? outputs.apiUrl          ?? "",
  COGNITO_USER_POOL: process.env.E2E_COGNITO_USER_POOL ?? outputs.cognitoUserPoolId ?? "",
  COGNITO_CLIENT_ID: process.env.E2E_COGNITO_CLIENT_ID ?? outputs.cognitoClientId  ?? "",
  TABLE_NAME:        process.env.E2E_TABLE_NAME        ?? outputs.tableName        ?? "",
  SNIPPET_CDN:       process.env.E2E_SNIPPET_CDN       ?? outputs.snippetCdnDomain ?? "",

  // Test user credentials — must be pre-created in Cognito (see docs/runbook.md)
  TEST_USER_EMAIL:    process.env.E2E_TEST_USER_EMAIL    ?? "e2e-test@example.com",
  TEST_USER_PASSWORD: process.env.E2E_TEST_USER_PASSWORD ?? "",

  AWS_REGION: process.env.AWS_REGION ?? "eu-west-2",
  AWS_PROFILE: process.env.AWS_PROFILE ?? "sandbox",
};

export function assertEnv() {
  const required: (keyof typeof ENV)[] = [
    "API_URL", "COGNITO_USER_POOL", "COGNITO_CLIENT_ID", "TABLE_NAME", "TEST_USER_PASSWORD",
  ];
  const missing = required.filter((k) => !ENV[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required e2e environment variables: ${missing.join(", ")}\n` +
      "Set them via E2E_* env vars or ensure .sst/outputs.json exists.\n" +
      "Set E2E_TEST_USER_PASSWORD for the test Cognito user."
    );
  }
}
