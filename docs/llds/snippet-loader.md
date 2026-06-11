# Low-Level Design: Snippet Loader Script (`scripts/load_snippets.py`)

**Version:** 1.0 (Implemented)
**Status:** Implemented
**Date:** 2026-05-16

---

## 1. Purpose and Scope

This document describes the implementation of `scripts/load_snippets.py`, an offline Python script that seeds the vulnerability education platform with Java code snippets. The script reads a curated local directory of `.java` files and a companion `metadata.json`, uploads the Java file content to S3, and writes metadata records to DynamoDB. It is not part of any deployed system and is run manually by a maintainer.

**Out of scope for this document:**
- Lambda functions that consume the seeded data
- The DynamoDB or S3 infrastructure itself (defined in SST config)
- Frontend display of snippets

---

## 2. Inputs and Expected Directory Layout

### 2.1 Directory structure

The script accepts a single `--snippets-dir` argument pointing to a root directory. That directory must contain exactly one `metadata.json` file and one `.java` file per snippet entry. Java files may be organised into subdirectories (e.g. by difficulty); the script discovers them recursively.

```
snippets/
├── metadata.json
├── beginner/
│   ├── sql-injection-basic.java
│   └── xss-reflected.java
├── intermediate/
│   ├── insecure-deserialisation.java
│   └── xxe-injection.java
└── advanced/
    └── path-traversal-filter-bypass.java
```

All paths recorded in `metadata.json` are relative to the directory that contains `metadata.json`.

### 2.2 `metadata.json` schema

The file is a JSON array. Each element is a **snippet descriptor object**.

```json
[
  {
    "snippetId":         "a3f1c2d4-1234-4abc-8def-000000000001",
    "title":             "SQL Injection via String Concatenation",
    "language":          "JAVA",
    "difficulty":        "BEGINNER",
    "owaspCategory":     "A03_INJECTION",
    "vulnerableLines":   [14, 15],
    "explanation":       "User input is concatenated directly into the SQL query string on lines 14-15, allowing an attacker to alter the query structure.",
    "source":            "Adapted from OWASP WebGoat – SQL Injection module",
    "file":              "beginner/sql-injection-basic.java"
  }
]
```

#### Field definitions

| Field | Type | Required | Constraints |
|---|---|---|---|
| `snippetId` | string | yes | Valid UUID v4; must be unique within the file |
| `title` | string | yes | 1–120 characters |
| `language` | string | yes | Must be `"JAVA"` (only supported value at launch) |
| `difficulty` | string | yes | One of `"BEGINNER"`, `"INTERMEDIATE"`, `"ADVANCED"` |
| `owaspCategory` | string | yes | Must be one of the 10 canonical values listed in §2.3 |
| `vulnerableLines` | array of integers | yes | At least 1 element; no duplicates; all values ≥ 1; all values ≤ actual line count of the referenced `.java` file |
| `explanation` | string | yes | 1–2000 characters; plain text (no HTML) |
| `source` | string | yes | 1–300 characters; free-form attribution string |
| `file` | string | yes | Relative path from `metadata.json` to the `.java` file; must exist on disk; must end with `.java` |

Derived fields (not stored in `metadata.json`, computed by the script):

| Derived field | Computed as |
|---|---|
| `vulnerableLineCount` | `len(vulnerableLines)` |
| `contentKey` | `snippets/java/<difficulty_lowercase>/<snippetId>.java` |

### 2.3 Allowed `owaspCategory` values

```
A01_BROKEN_ACCESS_CONTROL
A02_CRYPTOGRAPHIC_FAILURES
A03_INJECTION
A04_INSECURE_DESIGN
A05_SECURITY_MISCONFIGURATION
A06_VULNERABLE_AND_OUTDATED_COMPONENTS
A07_IDENTIFICATION_AND_AUTHENTICATION_FAILURES
A08_SOFTWARE_AND_DATA_INTEGRITY_FAILURES
A09_SECURITY_LOGGING_AND_MONITORING_FAILURES
A10_SERVER_SIDE_REQUEST_FORGERY
```

---

## 3. CLI Interface

```
python scripts/load_snippets.py \
  --snippets-dir <path>   \
  --bucket      <name>    \
  --table       <name>    \
  [--profile    <name>]   \
  [--region     <name>]   \
  [--dry-run]
```

### Argument reference

| Argument | Required | Default | Description |
|---|---|---|---|
| `--snippets-dir` | yes | — | Path to the directory containing `metadata.json` and `.java` files |
| `--bucket` | yes | — | S3 bucket name where snippet content is uploaded |
| `--table` | yes | — | DynamoDB table name for snippet metadata |
| `--profile` | no | AWS default profile / env credentials | Named AWS CLI profile to use (`boto3` session profile) |
| `--region` | no | Profile/env default | AWS region string (e.g. `eu-west-1`) |
| `--dry-run` | no | `False` | When set: validate all inputs and print what would be done, but make no AWS calls |

Example invocation:

```bash
python scripts/load_snippets.py \
  --snippets-dir ./snippets \
  --bucket my-snippets-bucket \
  --table SnippetsTable \
  --profile dev \
  --region eu-west-1
```

Dry-run invocation:

```bash
python scripts/load_snippets.py \
  --snippets-dir ./snippets \
  --bucket my-snippets-bucket \
  --table SnippetsTable \
  --dry-run
```

---

## 4. Script Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. Parse CLI arguments                                                      │
│    - Resolve --snippets-dir to an absolute path                             │
│    - Fail immediately if required args are missing                          │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. Load and parse metadata.json                                             │
│    - Fail loudly if file does not exist or is not valid JSON                │
│    - Fail loudly if top-level element is not an array                       │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. Validate all entries (full pass before any AWS calls)                    │
│    - For each entry: check required fields, types, enum values              │
│    - Resolve .java file path; check it exists                               │
│    - Count lines in the .java file                                          │
│    - Validate all vulnerableLines are within [1, line_count]                │
│    - Check for duplicate snippetIds across all entries                      │
│    - Collect all errors; if any exist: print them all and exit with code 1  │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │
                          if --dry-run
                          ┌──────┘
                          │  Print summary of what would be uploaded/written
                          │  Exit 0
                          └──────────────────────────────────────────────────▶
                                 │ (not dry-run)
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 4. Initialise boto3 session                                                 │
│    - Apply --profile and --region if provided                               │
│    - Fail loudly if credentials cannot be resolved                          │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 5. For each validated entry (in order from metadata.json):                  │
│                                                                             │
│   a. Compute contentKey = "snippets/java/<difficulty_lowercase>/<snippetId>.java"                       │
│   b. Upload .java content to S3 (idempotent PUT — see §7)                  │
│      - On S3 client error: log error with snippetId, skip to next entry     │
│                                                                             │
│   c. Build DynamoDB item (all metadata fields + derived fields)             │
│   d. Write item to DynamoDB using put_item (upsert — see §7)               │
│      - On DynamoDB client error: log error with snippetId, skip to next     │
│                                                                             │
│   e. Log success line: "✓ {snippetId} ({title})"                           │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 6. Print final summary                                                      │
│    - Total processed / succeeded / skipped-with-warning                     │
│    - Exit 0 if all succeeded; exit 2 if any entry was skipped with error    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Validation Rules

Validation runs in a single pass over all entries before any AWS call is made. All errors found across all entries are collected and printed together before exiting. This avoids partial uploads followed by a hard stop on a later entry.

### 5.1 Structural / type checks (fail loudly, halt all processing)

| Check | Failure message |
|---|---|
| `metadata.json` exists | `metadata.json not found at <path>` |
| Top-level JSON is an array | `metadata.json must be a JSON array` |
| Each entry is a JSON object | `Entry at index <n> is not an object` |

### 5.2 Per-entry field checks (accumulate errors)

| Check | Failure message |
|---|---|
| `snippetId` present, non-empty, valid UUID v4 format | `[<id>] snippetId is missing / not a valid UUID v4` |
| `title` present, 1–120 chars | `[<id>] title is missing or exceeds 120 characters` |
| `language` == `"JAVA"` | `[<id>] language must be "JAVA", got "<value>"` |
| `difficulty` in allowed enum | `[<id>] difficulty "<value>" not in BEGINNER, INTERMEDIATE, ADVANCED` |
| `owaspCategory` in allowed enum (§2.3) | `[<id>] owaspCategory "<value>" is not a recognised OWASP Top 10 category` |
| `vulnerableLines` is a non-empty array of integers | `[<id>] vulnerableLines must be a non-empty array of integers` |
| No duplicate values in `vulnerableLines` | `[<id>] vulnerableLines contains duplicate line numbers` |
| `explanation` present, 1–2000 chars | `[<id>] explanation is missing or exceeds 2000 characters` |
| `source` present, 1–300 chars | `[<id>] source is missing or exceeds 300 characters` |
| `file` present, ends with `.java` | `[<id>] file must be specified and must end with .java` |
| Resolved file path exists on disk | `[<id>] file not found: <resolved_path>` |
| All `vulnerableLines` values are ≥ 1 | `[<id>] vulnerableLines contains values less than 1` |
| All `vulnerableLines` values are ≤ actual line count of the `.java` file | `[<id>] vulnerableLines value <n> exceeds file line count <count>` |

### 5.3 Cross-entry checks (accumulate errors)

| Check | Failure message |
|---|---|
| No two entries share the same `snippetId` | `Duplicate snippetId found: <id>` |
| No two entries reference the same `file` path | `Duplicate file reference found: <path>` |

---

## 6. S3 Upload

- **Object key:** `snippets/java/<difficulty_lowercase>/<snippetId>.java` (deterministic, based solely on `snippetId`)
- **Content-Type:** `text/plain; charset=utf-8`
- **File encoding:** UTF-8; the script reads the `.java` file as UTF-8 and aborts the entry with a warning if the file cannot be decoded
- **S3 API call:** `s3.put_object(Bucket=bucket, Key=key, Body=content_bytes, ContentType="text/plain; charset=utf-8")`
- No multipart upload needed; snippets are small (expected ≤ 500 lines / ≤ 50 KB)
- Server-side encryption is governed by the bucket's default encryption policy; the script does not set a per-object `ServerSideEncryption` parameter

---

## 7. DynamoDB Write

### 7.1 Item schema written by the script

| DynamoDB attribute | Source | DynamoDB type |
|---|---|---|
| `snippetId` (PK) | `metadata.json` | S (String) |
| `title` | `metadata.json` | S |
| `language` | `metadata.json` | S |
| `difficulty` | `metadata.json` | S |
| `owaspCategory` | `metadata.json` | S |
| `vulnerableLines` | `metadata.json` | L (List of N) |
| `vulnerableLineCount` | computed: `len(vulnerableLines)` | N (Number) |
| `explanation` | `metadata.json` | S |
| `source` | `metadata.json` | S |
| `contentKey` | computed: `snippets/java/<difficulty_lowercase>/<snippetId>.java` | S |

### 7.2 API call

```python
table.put_item(Item=item)
```

No `ConditionExpression` is used. This is a blind upsert: if the item already exists it is fully overwritten. See §8 for the rationale.

---

## 8. Idempotency Strategy

**Approach: unconditional upsert on both S3 and DynamoDB.**

On S3, `put_object` is inherently idempotent: uploading the same bytes to the same key a second time produces the same object.

On DynamoDB, `put_item` without a condition expression overwrites any existing item with the same PK. This means re-running the script after editing a snippet's `metadata.json` or `.java` file will update both the S3 content and the DynamoDB record to the latest values.

**Why upsert rather than skip-if-exists:**

- The primary use case for re-running is updating an existing snippet (fixing a typo in `explanation`, adjusting `vulnerableLines`). A skip-if-exists strategy would silently ignore these corrections.
- Snippet content is not user-generated data; overwriting is always safe.
- If a conditional write were used, a failed partial write (S3 succeeded, DynamoDB failed on previous run) would block correction on re-run.

**Consequence:** The script must be given correct and final data in `metadata.json` before running. Running with malformed metadata and then correcting it will overwrite clean data. The validation step (§5) is the primary guard against this.

---

## 9. Error Handling

| Situation | Behaviour |
|---|---|
| `metadata.json` missing or unparseable JSON | Print error, exit with code 1 immediately |
| Any validation error found in §5 | Accumulate all errors, print them all, exit with code 1 before any AWS call |
| AWS credentials not resolvable | `boto3` raises `NoCredentialsError`; script catches it, prints a clear message, exits with code 1 |
| S3 bucket does not exist | `boto3` raises `ClientError` (NoSuchBucket); caught per-entry, logged with warning, entry skipped, final exit code 2 |
| DynamoDB table does not exist | `boto3` raises `ClientError` (ResourceNotFoundException); caught per-entry, logged with warning, entry skipped, final exit code 2 |
| `.java` file is not valid UTF-8 | Caught per-entry, logged with warning (`[<id>] file is not valid UTF-8`), entry skipped, final exit code 2 |
| Unexpected boto3 `ClientError` | Caught per-entry, logged with full error message and snippetId, entry skipped, final exit code 2 |
| `--dry-run` flag present | No AWS calls made; validation still runs in full |

**Exit codes:**

| Code | Meaning |
|---|---|
| 0 | All entries processed successfully (or dry-run completed with no validation errors) |
| 1 | Hard failure before any processing (arg error, metadata parse error, validation errors) |
| 2 | Processing completed but one or more entries were skipped due to runtime errors |

---

## 10. Dependencies

The script targets **Python 3.11+** and uses only:

| Dependency | Source | Purpose |
|---|---|---|
| `boto3` | pip (`boto3>=1.34`) | S3 and DynamoDB client |
| `botocore` | pip (boto3 transitive dep) | Exception types (`ClientError`, `NoCredentialsError`) |
| `argparse` | stdlib | CLI argument parsing |
| `json` | stdlib | Parsing `metadata.json` |
| `uuid` | stdlib | UUID format validation |
| `pathlib` | stdlib | Path resolution |
| `sys` | stdlib | Exit codes |
| `logging` | stdlib | Structured log output |

No third-party validation libraries (e.g. `pydantic`, `jsonschema`) are used to keep the dependency footprint minimal. Validation logic is written as explicit `if` checks.

A minimal `requirements.txt` (or pip install line):

```
boto3>=1.34
```

---

## 11. Example `metadata.json`

```json
[
  {
    "snippetId": "a3f1c2d4-1234-4abc-8def-000000000001",
    "title": "SQL Injection via String Concatenation",
    "language": "JAVA",
    "difficulty": "BEGINNER",
    "owaspCategory": "A03_INJECTION",
    "vulnerableLines": [14, 15],
    "explanation": "User input is concatenated directly into the SQL query string on lines 14-15. An attacker can break out of the string literal and inject arbitrary SQL, including a tautology like ' OR '1'='1 to bypass authentication.",
    "source": "Adapted from OWASP WebGoat – SQL Injection module",
    "file": "beginner/sql-injection-basic.java"
  },
  {
    "snippetId": "b7e2d3a1-5678-4bcd-9ef0-000000000002",
    "title": "Reflected XSS in Servlet Response",
    "language": "JAVA",
    "difficulty": "BEGINNER",
    "owaspCategory": "A03_INJECTION",
    "vulnerableLines": [22],
    "explanation": "The 'name' query parameter is written directly into the HTTP response on line 22 without encoding. An attacker can craft a URL containing a script tag that executes in the victim's browser.",
    "source": "Original – common servlet anti-pattern",
    "file": "beginner/xss-reflected.java"
  },
  {
    "snippetId": "c9a4f8b2-9abc-4def-0123-000000000003",
    "title": "XXE via Unconfigured DocumentBuilder",
    "language": "JAVA",
    "difficulty": "INTERMEDIATE",
    "owaspCategory": "A05_SECURITY_MISCONFIGURATION",
    "vulnerableLines": [31, 32, 33],
    "explanation": "The DocumentBuilder on lines 31-33 is instantiated with default settings, leaving external entity processing enabled. An attacker-controlled XML document can exfiltrate local files or trigger server-side request forgery.",
    "source": "Adapted from OWASP XXE Prevention Cheat Sheet examples",
    "file": "intermediate/xxe-injection.java"
  }
]
```

---

## 12. Decisions and Alternatives

### 12.1 Upsert vs. conditional write in DynamoDB

**Chosen:** unconditional `put_item` (upsert).
**Alternative:** `put_item` with `ConditionExpression=attribute_not_exists(snippetId)` (skip if exists).
**Rejected because:** Re-runs are primarily driven by the need to update existing snippets. Skipping existing items would silently ignore corrections, requiring manual deletion before re-seeding. The simpler upsert is safer for a curated, maintainer-controlled data set.

### 12.2 Validate-all-first vs. validate-and-upload per entry

**Chosen:** Full validation pass over all entries before any AWS call.
**Alternative:** Validate each entry immediately before its AWS call.
**Rejected because:** A mid-run failure after partial uploads leaves the system in an inconsistent state and forces the operator to trace which entries landed. Validating all first makes the "nothing has been written yet" guarantee explicit and removes the need to track partial state.

### 12.3 S3 key format

**Chosen:** `snippets/java/<difficulty_lowercase>/<snippetId>.java` — deterministic, collision-free, human-readable in the bucket.
**Alternative:** `snippets/{difficulty}/{owaspCategory}/{snippetId}.java` — adds hierarchy.
**Rejected because:** Lambda's `GetSnippet` uses the `contentKey` stored in DynamoDB; it never derives the key from other attributes. Adding hierarchy to the key buys nothing and introduces a risk of key mismatch if `difficulty` or `owaspCategory` is later corrected in DynamoDB without re-uploading.

### 12.4 Answer key storage

**Chosen:** `vulnerableLines` and `explanation` stored only in DynamoDB, never in S3.
**Alternative:** Embed answer keys in the `.java` file as structured comments.
**Rejected because:** The S3 object is fetched directly by the browser via a pre-signed URL or CloudFront. Any data in the S3 file is client-visible. DynamoDB records are only accessed by Lambda, so answer keys remain server-side.

### 12.5 Language support

**Chosen:** Hard-coded validation that `language` must equal `"JAVA"`.
**Alternative:** Allow arbitrary language strings to be stored.
**Rejected because:** The frontend syntax highlighter, the line-count check, and the file extension check (`.java`) are all language-specific. Silently accepting other languages would produce broken snippets. When other languages are added, the validation, file extension rules, and ContentType handling must all be updated together; the hard check surfaces that coupling early.

### 12.6 Third-party validation library

**Chosen:** Explicit `if`-based validation using stdlib only (plus `boto3`).
**Alternative:** `pydantic` or `jsonschema` for schema validation.
**Rejected because:** The schema is small (9 fields, simple rules). Adding a library for this increases setup friction for a maintainer who may run the script occasionally on a clean machine. Stdlib is always available; `boto3` is the only install required.

---

## 13. Edge Case Probe

The following questions identify missing edge cases and implicit assumptions in this LLD. Each represents a situation the script may encounter that is not fully addressed above.

1. **What happens when a `.java` file has trailing blank lines?**
   The script counts lines using `splitlines()` or iterating the file object. Does a trailing newline produce an extra empty line that inflates the count, potentially causing a valid `vulnerableLines` value to fail the upper-bound check?

2. **What happens when `metadata.json` contains an entry with a `snippetId` that already exists in DynamoDB but the `file` path on disk no longer exists?**
   Validation will fail (file not found) and the entry will not be uploaded — but the old DynamoDB record and S3 object remain, potentially serving a snippet whose file has been removed locally. There is no cleanup step.

3. **What happens when two entries in `metadata.json` point to the same `snippetId` but different `file` values?**
   The cross-entry duplicate-`snippetId` check (§5.3) should catch this, but the LLD does not explicitly state whether both the S3 key and the DynamoDB record would be considered conflicting or just one of them.

4. **What happens when the S3 bucket exists but the IAM role lacks `s3:PutObject` permission?**
   The `put_object` call raises a `ClientError` with error code `AccessDenied`. The LLD groups this under "unexpected `ClientError`" and skips the entry. Should this abort all remaining entries (since every entry will fail for the same reason)?

5. **What happens when the DynamoDB table has a sort key defined (e.g. for a single-table design extension)?**
   The script calls `put_item` without a sort key. DynamoDB will raise a `ValidationException`. This is not explicitly handled and would surface as an "unexpected `ClientError`".

6. **What happens when `vulnerableLines` is `[0]`?**
   The LLD states all values must be ≥ 1, so this should fail validation. However, it is not explicit whether `0` is rejected as "less than 1" or whether the validator checks for truthiness (which would treat `0` as falsy and produce a misleading error message).

7. **What happens when a `snippetId` is a valid UUID but not UUID v4 (e.g. UUID v1 or v7)?**
   The LLD specifies UUID v4 format validation. It should state the exact check used (e.g. regex against `^[0-9a-f]{8}-...-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-...` or `uuid.UUID(s).version == 4`).

8. **What happens when `metadata.json` contains comments (non-standard JSON)?**
   Python's `json.loads` will raise `JSONDecodeError`. The LLD says the script "fails loudly if not valid JSON", which covers this, but maintainers writing JSON by hand may include `//` comments as a matter of habit. Should the LLD recommend a note in the README or use a JSON5 parser?

9. **What happens when the script is run concurrently by two operators against the same bucket and table?**
   Both will attempt `put_object` and `put_item` for the same keys. DynamoDB's `put_item` is atomic at the item level, so the last writer wins. There is no concurrency guard. This is probably acceptable for a manual seeding script, but the LLD is silent on it.

10. **What happens when a `.java` file's content changes between the validation pass and the S3 upload?**
    The script reads the file twice: once during validation (to count lines) and once during upload (to get content bytes). A file modified between these two reads could produce a mismatch between the line count used for validation and the content actually uploaded.

11. **What happens when `--snippets-dir` is an absolute path with a trailing slash, or a relative path, or contains symlinks?**
    The LLD says "resolve to an absolute path" but does not specify whether symlinks are followed or whether the script validates that the resolved path is a directory.

12. **What happens when a `.java` file is empty (zero bytes / zero lines)?**
    `vulnerableLines` must be non-empty, so at least one line number is required. An empty file has zero lines, meaning any non-empty `vulnerableLines` array will fail the upper-bound check. The error message would say "value X exceeds file line count 0", which is correct but potentially confusing. Should there be an explicit check for empty files?

13. **What happens when the explanation or source fields contain Unicode characters outside the Basic Multilingual Plane (e.g. emoji)?**
    DynamoDB stores strings as UTF-8 and handles supplementary characters correctly. The only risk is hitting DynamoDB's 400 KB item size limit, which is not checked by the script.

14. **What happens to existing snippets in DynamoDB that are no longer present in `metadata.json`?**
    They are silently left in place. The script has no delete or reconcile mode. A snippet removed from `metadata.json` will continue to be served to users until it is manually deleted from DynamoDB and S3.
