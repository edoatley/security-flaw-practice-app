# E2E Integration Tests

HTTP-level integration tests against the live edoatley stage API. Tests authenticate with Cognito directly (bypassing the Hosted UI) and call API Gateway endpoints with real JWTs.

## Prerequisites

1. **Deployed stage** — run `AWS_PROFILE=sandbox npx sst deploy --stage edoatley` first.
2. **Test user in Cognito** — create a permanent test user:
   ```bash
   AWS_PROFILE=sandbox aws cognito-idp admin-create-user \
     --user-pool-id eu-west-2_VVP8q00KT \
     --username e2e-test@example.com \
     --temporary-password TempPass123! \
     --message-action SUPPRESS

   AWS_PROFILE=sandbox aws cognito-idp admin-set-user-password \
     --user-pool-id eu-west-2_VVP8q00KT \
     --username e2e-test@example.com \
     --password E2eTestPass123! \
     --permanent
   ```
3. **Snippets seeded** — run `python scripts/load_snippets.py ...` so at least one snippet exists per tier.

## Running

```bash
# From repo root
E2E_TEST_USER_PASSWORD=E2eTestPass123! AWS_PROFILE=sandbox npm run test:e2e
```

The tests read API URLs and Cognito IDs from `.sst/outputs.json` automatically.

## Test suites

| File | Coverage |
|---|---|
| `auth.test.ts` | POST /auth/session, /auth/refresh, /auth/logout — cookie attributes, error codes |
| `game.test.ts` | GET /api/snippet, POST /api/answer — validation, correctness, 409 duplicate defence |
| `progress.test.ts` | GET /api/progress — profile creation, rolling window stats, field redaction |
| `adaptive.test.ts` | Tier promotion/demotion, speed median fallback, window reset after transition |

## Test isolation

Each suite purges the test user's DynamoDB data in `beforeAll`/`afterAll`. The `adaptive.test.ts` suite directly writes seeded attempt history to DynamoDB to avoid making 20+ live API calls per test.

## Notes

- Tests run serially (single fork) — they share a DynamoDB table and a Cognito user.
- `ALLOW_USER_PASSWORD_AUTH` is enabled on the Cognito app client for non-production stages via `sst.config.ts`.
- Do not run against the `production` stage.
