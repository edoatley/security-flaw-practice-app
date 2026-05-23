# Content Specifications: Snippet Loader & Data Model Constraints

**Spec Set:** CONTENT
**Version:** 1.0 (Draft)
**Date:** 2026-05-16
**Author:** edoatley@gmail.com
**Source documents:**
- `docs/llds/snippet-loader.md` v1.0
- `docs/llds/data-model.md` v0.1

---

## Status Key

| Marker | Meaning |
|--------|---------|
| `[ ]` | Active — not yet implemented |
| `[x]` | Implemented |
| `[D]` | Deferred — out of scope for current iteration |

---

## 1. metadata.json Required Fields

**CONTENT-001** `[x]`
The snippet loader shall reject any `metadata.json` entry that does not include a `snippetId` field containing a non-empty, valid UUID v4 string.

**CONTENT-002** `[x]`
The snippet loader shall reject any `metadata.json` entry that does not include a `title` field containing between 1 and 120 characters (inclusive).

**CONTENT-003** `[x]`
The snippet loader shall reject any `metadata.json` entry that does not include a `file` field containing a non-empty string ending with `.java`.

**CONTENT-004** `[x]`
The snippet loader shall reject any `metadata.json` entry that does not include a `difficulty` field.

**CONTENT-005** `[x]`
The snippet loader shall reject any `metadata.json` entry that does not include an `owaspCategory` field.

**CONTENT-006** `[x]`
The snippet loader shall reject any `metadata.json` entry that does not include a `vulnerableLines` field.

**CONTENT-007** `[x]`
The snippet loader shall reject any `metadata.json` entry that does not include an `explanation` field containing between 1 and 2000 characters (inclusive).

**CONTENT-008** `[x]`
The snippet loader shall reject any `metadata.json` entry that does not include a `source` field containing between 1 and 300 characters (inclusive).

---

## 2. difficulty Enum Constraint

**CONTENT-009** `[x]`
The snippet loader shall reject any `metadata.json` entry whose `difficulty` field is not exactly one of the following values: `BEGINNER`, `INTERMEDIATE`, `ADVANCED`.

---

## 3. owaspCategory Enum Constraint

**CONTENT-010** `[x]`
The snippet loader shall reject any `metadata.json` entry whose `owaspCategory` field is not exactly one of the following ten underscore-enum values:

| Value | OWASP 2021 Name |
|-------|----------------|
| `A01_BROKEN_ACCESS_CONTROL` | Broken Access Control |
| `A02_CRYPTOGRAPHIC_FAILURES` | Cryptographic Failures |
| `A03_INJECTION` | Injection |
| `A04_INSECURE_DESIGN` | Insecure Design |
| `A05_SECURITY_MISCONFIGURATION` | Security Misconfiguration |
| `A06_VULNERABLE_AND_OUTDATED_COMPONENTS` | Vulnerable and Outdated Components |
| `A07_IDENTIFICATION_AND_AUTHENTICATION_FAILURES` | Identification and Authentication Failures |
| `A08_SOFTWARE_AND_DATA_INTEGRITY_FAILURES` | Software and Data Integrity Failures |
| `A09_SECURITY_LOGGING_AND_MONITORING_FAILURES` | Security Logging and Monitoring Failures |
| `A10_SERVER_SIDE_REQUEST_FORGERY` | Server-Side Request Forgery |

> **Resolved:** The format conflict between `snippet-loader.md` (colon-and-hyphen) and `data-model.md` (underscore-enum) is resolved in favour of underscore-enum, which is the format used throughout the implementation, seeder script, and existing snippet data. See Consistency Report §A (removed).

---

## 4. vulnerableLines Line-Number Validity

**CONTENT-011** `[x]`
The snippet loader shall reject any `metadata.json` entry whose `vulnerableLines` field is not a non-empty array of integers.

**CONTENT-012** `[x]`
The snippet loader shall reject any `metadata.json` entry that contains a `vulnerableLines` array with duplicate integer values.

**CONTENT-013** `[x]`
The snippet loader shall reject any `metadata.json` entry that contains a `vulnerableLines` value less than 1.

**CONTENT-014** `[x]`
When validating a snippet entry, the snippet loader shall read the `.java` file identified by the `file` field and shall reject the entry if any value in `vulnerableLines` exceeds the total number of lines in that file.

---

## 5. vulnerableLineCount is Loader-Computed

**CONTENT-015** `[x]`
The snippet loader shall compute the `vulnerableLineCount` attribute as `len(vulnerableLines)` and shall write this computed value to DynamoDB; `vulnerableLineCount` shall not be read from `metadata.json`.

**CONTENT-016** `[x]`
The data model shall store `vulnerableLineCount` as a DynamoDB Number attribute on every Snippet item.

---

## 6. contentKey is Loader-Computed

**CONTENT-017** `[x]`
The snippet loader shall compute the `contentKey` attribute as `snippets/java/<difficulty_lowercase>/<snippetId>.java` — where `<difficulty_lowercase>` is the lowercase form of the `difficulty` value and `<snippetId>` is the UUID from `metadata.json` — and shall write this computed value to DynamoDB; `contentKey` shall not be read from `metadata.json`.

**CONTENT-018** `[x]`
The snippet loader shall ensure that every `contentKey` value written to DynamoDB matches the regular expression `^snippets/java/(beginner|intermediate|advanced)/[0-9a-f-]{36}\.java$`.

> **Note — conflict with snippet-loader.md (see Consistency Report §B):** `snippet-loader.md` §6 and §12.3 specify the flat key format `snippets/{snippetId}.java`, whereas `data-model.md` §6.2 specifies the hierarchical format `snippets/java/<difficulty_lowercase>/<snippetId>.java`. CONTENT-017 and CONTENT-018 adopt the hierarchical format from `data-model.md` as it is the more detailed authoritative data-model document. This conflict must be resolved before implementation.

---

## 7. Validate-All-First

**CONTENT-019** `[x]`
The snippet loader shall complete validation of every entry in `metadata.json` before making any call to S3 or DynamoDB.

**CONTENT-020** `[x]`
When any validation error is detected across any entry, the snippet loader shall collect all validation errors from all entries, print them all, and exit with code 1 without writing any data to S3 or DynamoDB.

---

## 8. Duplicate snippetId is a Validation Error

**CONTENT-021** `[x]`
When two or more entries in `metadata.json` share the same `snippetId` value, the snippet loader shall treat this as a validation error, include an error message identifying the duplicated `snippetId`, and halt processing with exit code 1 before making any AWS call.

---

## 9. Missing .java File is a Validation Error

**CONTENT-022** `[x]`
When a `file` path in a `metadata.json` entry, resolved relative to the directory containing `metadata.json`, does not exist on disk, the snippet loader shall treat this as a validation error, include an error message identifying the missing path, and halt processing with exit code 1 before making any AWS call.

**CONTENT-023** `[x]`
If a `file` field value does not end with `.java`, the snippet loader shall treat this as a validation error before attempting to resolve or read the file.

---

## 10. Idempotency — Re-run Upserts Existing Records

**CONTENT-024** `[x]`
When the snippet loader is re-run against a `metadata.json` file that contains a `snippetId` already present in DynamoDB, the snippet loader shall overwrite the existing DynamoDB item with the current values from `metadata.json` and shall not skip the entry or raise an error.

**CONTENT-025** `[x]`
When the snippet loader is re-run and the S3 object key for a snippet already exists in the target bucket, the snippet loader shall overwrite the existing S3 object with the current file content and shall not skip the upload or raise an error.

> **Note — conflict with data-model.md (see Consistency Report §C):** `data-model.md` §6.4 describes a conditional `PutItem` with `attribute_not_exists(PK)` and a `--force` flag. `snippet-loader.md` §7.2 and §8 specify an unconditional upsert with no `--force` flag. CONTENT-024 and CONTENT-025 adopt the unconditional-upsert model from `snippet-loader.md`. This conflict must be resolved before implementation.

---

## 11. --dry-run Flag

**CONTENT-026** `[x]`
When the `--dry-run` flag is passed to the snippet loader, the snippet loader shall execute the full validation pass over all entries in `metadata.json`.

**CONTENT-027** `[x]`
When the `--dry-run` flag is passed and all validation passes, the snippet loader shall print a summary of what would be uploaded to S3 and written to DynamoDB, and shall exit with code 0 without making any S3 or DynamoDB call.

**CONTENT-028** `[x]`
When the `--dry-run` flag is passed and validation errors are found, the snippet loader shall print all validation errors and exit with code 1 without making any S3 or DynamoDB call.

---

## 12. S3 Object Key Format

**CONTENT-029** `[x]`
The snippet loader shall upload each snippet's `.java` file to S3 using the object key `snippets/java/<difficulty_lowercase>/<snippetId>.java`, where `<difficulty_lowercase>` is the lowercase form of the snippet's `difficulty` value and `<snippetId>` is the UUID v4 from `metadata.json`.

**CONTENT-030** `[x]`
The snippet loader shall not include the S3 bucket name or any `s3://` prefix in the object key written to DynamoDB as `contentKey`.

**CONTENT-031** `[x]`
The snippet loader shall not use uppercase characters, spaces, or special characters other than hyphens and dots in any S3 object key it writes.

---

## 13. Answer Keys Stored in DynamoDB Only

**CONTENT-032** `[x]`
The snippet loader shall store the `vulnerableLines` array only in DynamoDB and shall not include it in the S3 object content or S3 object metadata.

**CONTENT-033** `[x]`
The snippet loader shall store the `explanation` string only in DynamoDB and shall not include it in the S3 object content or S3 object metadata.

**CONTENT-034** `[x]`
While serving a `GetSnippet` response, the system shall not return the `vulnerableLines` or `explanation` attributes to the client prior to the user submitting an answer.

---

## 14. Snippet Content Served as text/plain; charset=utf-8

**CONTENT-035** `[x]`
The snippet loader shall upload each `.java` file to S3 with the `Content-Type` header set to `text/plain; charset=utf-8`.

**CONTENT-036** `[x]`
The snippet loader shall read each `.java` file from disk as UTF-8 and shall skip the entry with a warning — recording exit code 2 — if the file cannot be decoded as UTF-8.

---

## 15. Exit Codes

**CONTENT-037** `[x]`
When all snippet entries are processed successfully (or when `--dry-run` completes with no validation errors), the snippet loader shall exit with code 0.

**CONTENT-038** `[x]`
When any validation error is detected — including missing required fields, invalid enum values, out-of-range line numbers, duplicate `snippetId` values, or missing `.java` files — the snippet loader shall exit with code 1.

**CONTENT-039** `[x]`
When validation passes but one or more entries cannot be written due to a runtime AWS error (S3 `ClientError`, DynamoDB `ClientError`, or unresolvable credentials), the snippet loader shall exit with code 2 after processing all remaining entries.

**CONTENT-040** `[x]`
When AWS credentials cannot be resolved at session initialisation time, the snippet loader shall print a clear error message and exit with code 1 before attempting any S3 or DynamoDB call.

> **Note — credentials exit code (see Consistency Report §D):** `snippet-loader.md` §9 places unresolvable credentials under exit code 1 (hard failure before processing), while the general AWS error category is exit code 2. CONTENT-040 follows the LLD precisely. This distinction should be made explicit in the implementation.

---

## Consistency Report

### A. owaspCategory Value Format — Resolved

The format conflict between `snippet-loader.md` (colon-and-hyphen) and `data-model.md` (underscore-enum) is resolved. The underscore-enum format (`A03_INJECTION`) is canonical throughout the implementation: `metadata.json`, the seeder script, DynamoDB, and all Lambda code use this format. `data-model.md` §7.1 and `snippet-loader.md` should be updated to reflect this if not already done.

---

### B. S3 contentKey / Object Key Format Conflict

**Documents in conflict:** `snippet-loader.md` §6 (S3 Upload), §12.3 (Decision), and the derived-fields table in §2.2 vs. `data-model.md` §6.2 and §7.2.

`snippet-loader.md` specifies the flat key `snippets/{snippetId}.java` in every relevant section (the derived-fields table, the S3 upload section, the flow diagram step 5a, and the decision rationale). `data-model.md` specifies the hierarchical key `snippets/java/<difficulty_lowercase>/<snippetId>.java` including a validation regex. These produce different S3 keys and therefore different `contentKey` values in DynamoDB — meaning the two documents cannot both be correct at the same time.

The hierarchical format is adopted in CONTENT-017, CONTENT-018, and CONTENT-029 because `data-model.md` is the authoritative physical data-model document and its regex constitutes a tighter, more testable constraint. However, `snippet-loader.md` must be updated to reflect this, as its current text will mislead implementors.

**Implicit scoping issue:** The decision rationale in `snippet-loader.md` §12.3 explicitly argues *against* a hierarchical key on the grounds that adding difficulty to the key risks mismatch if difficulty is later corrected in DynamoDB without re-uploading. This concern remains valid under the hierarchical format and should be addressed in the idempotency design.

---

### C. Idempotency Strategy Conflict

**Documents in conflict:** `snippet-loader.md` §7.2, §8 vs. `data-model.md` §6.4.

`snippet-loader.md` specifies an unconditional `put_item` upsert with no guard flags. `data-model.md` §6.4 specifies a conditional `PutItem` with `attribute_not_exists(PK)` as the default, plus a `--force` flag to override it. The `--force` flag does not appear anywhere in `snippet-loader.md`'s CLI interface (§3) or flow (§4).

These are fundamentally different idempotency models. The unconditional upsert is adopted in CONTENT-024 and CONTENT-025 because `snippet-loader.md` provides more detailed rationale (§8 explains why skip-if-exists is actively harmful for a correction-driven workflow). However, the `data-model.md` conditional-write concern — that an accidental re-run overwrites clean data — is legitimate and should be resolved by either: (a) confirming the unconditional upsert and updating `data-model.md`, or (b) introducing the `--force` flag into `snippet-loader.md`'s CLI spec.

---

### D. AWS Credentials Error Exit Code Ambiguity

**Document:** `snippet-loader.md` §9.

The error-handling table places `NoCredentialsError` under exit code 1 (hard failure), which is consistent with it occurring before any processing. However, this is a runtime AWS failure in the same class as S3/DynamoDB errors (which use code 2). CONTENT-040 formalises the current LLD behaviour (code 1 for credentials), but teams should be aware that a wrapper script treating all non-zero exit codes equally will not distinguish credential failures from partial-write failures.

---

### E. Coverage Gaps

The following behaviours are described in the LLDs but are not covered by any of the 15 mandatory spec topics; they are recorded here for future spec iterations:

1. **language field validation:** `snippet-loader.md` §5.2 requires `language == "JAVA"` but this field does not appear in the 15 mandated topics. A `CONTENT-041` spec should be added if the loader is expected to be tested against this constraint.

2. **metadata.json structural checks:** The requirement that the top-level JSON element is an array, and that each element is an object, is described in `snippet-loader.md` §4 and §5.1 but is not captured in any of the 15 behaviours above.

3. **Duplicate file path cross-entry check:** `snippet-loader.md` §5.3 requires that no two entries reference the same `file` path. This is a distinct validation from the duplicate `snippetId` check (CONTENT-021) and has no corresponding spec entry.

4. **createdAt / updatedAt timestamps:** `data-model.md` §2.1 requires `createdAt` and `updatedAt` attributes on every Snippet item, but `snippet-loader.md` §7.1 does not list them in the DynamoDB item schema. It is unspecified whether the loader sets these fields, and if so, how `updatedAt` is handled on an upsert of an existing record.

5. **S3 object metadata headers:** `data-model.md` §6.3 specifies four `x-amz-meta-*` headers to attach to each S3 object. This is not mentioned in `snippet-loader.md` §6 at all, making it unclear whether the loader is responsible for setting them.

6. **entityType, GSI1PK, GSI1SK attributes:** `data-model.md` §2.1 requires these three attributes on every Snippet DynamoDB item. They do not appear in the loader's item schema table in `snippet-loader.md` §7.1. The loader cannot write a correctly queryable Snippet item without setting `GSI1PK = DIFFICULTY#<difficulty>` and `GSI1SK = SNIPPET#<snippetId>`.

7. **source field optionality:** `snippet-loader.md` marks `source` as required (CONTENT-008 reflects this); `data-model.md` §2.1 marks it `No` (optional). These specifications disagree on whether a missing `source` field is a validation error.

8. **No delete or reconcile mode:** Both documents are silent on what happens to DynamoDB and S3 records for snippets removed from `metadata.json`. If this is intentional, a spec confirming the out-of-scope boundary would prevent future implementors from adding silent orphan-cleanup behaviour.
