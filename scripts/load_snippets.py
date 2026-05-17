#!/usr/bin/env python3
"""Snippet loader: uploads Java snippet files to S3 and writes metadata to DynamoDB."""

import argparse
import json
import re
import sys
from decimal import Decimal
from datetime import datetime, timezone
from pathlib import Path

import boto3
from botocore.exceptions import ClientError, NoCredentialsError

ALLOWED_LANGUAGES = {"JAVA"}
ALLOWED_DIFFICULTIES = {"BEGINNER", "INTERMEDIATE", "ADVANCED"}
ALLOWED_OWASP = {
    "A01_BROKEN_ACCESS_CONTROL",
    "A02_CRYPTOGRAPHIC_FAILURES",
    "A03_INJECTION",
    "A04_INSECURE_DESIGN",
    "A05_SECURITY_MISCONFIGURATION",
    "A06_VULNERABLE_AND_OUTDATED_COMPONENTS",
    "A07_IDENTIFICATION_AND_AUTHENTICATION_FAILURES",
    "A08_SOFTWARE_AND_DATA_INTEGRITY_FAILURES",
    "A09_SECURITY_LOGGING_AND_MONITORING_FAILURES",
    "A10_SERVER_SIDE_REQUEST_FORGERY",
}
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE
)

# Default config items seeded if not already present
DEFAULT_ALGO_PARAMS = {
    "PK": "CONFIG#ALGO_PARAMS",
    "SK": "V0",
    "correctRateWeight": Decimal("0.7"),
    "speedWeight": Decimal("0.3"),
    "tierUpThreshold": Decimal("0.75"),
    "tierDownThreshold": Decimal("0.4"),
    "tierUpWindow": 20,
    "tierDownWindow": 10,
}
DEFAULT_SPEED_MEDIANS = {
    "PK": "CONFIG#SPEED_MEDIANS",
    "SK": "V0",
    "medians": {"BEGINNER": None, "INTERMEDIATE": None, "ADVANCED": None},
    "sampleSizes": {"BEGINNER": 0, "INTERMEDIATE": 0, "ADVANCED": 0},
    "computedAt": None,
}


def parse_args():
    parser = argparse.ArgumentParser(description="Load snippets into S3 and DynamoDB.")
    parser.add_argument("--snippets-dir", required=True, help="Directory containing metadata.json and .java files")
    parser.add_argument("--bucket", required=True, help="S3 bucket name")
    parser.add_argument("--table", required=True, help="DynamoDB table name")
    parser.add_argument("--profile", default=None, help="AWS CLI profile name")
    parser.add_argument("--region", default=None, help="AWS region")
    parser.add_argument("--dry-run", action="store_true", help="Validate and print plan without making AWS calls")
    return parser.parse_args()


def load_metadata(snippets_dir: Path) -> list:
    metadata_path = snippets_dir / "metadata.json"
    if not metadata_path.exists():
        print(f"ERROR: metadata.json not found at {metadata_path}", file=sys.stderr)
        sys.exit(1)
    try:
        with open(metadata_path, encoding="utf-8") as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        print(f"ERROR: metadata.json is not valid JSON: {e}", file=sys.stderr)
        sys.exit(1)
    if not isinstance(data, list):
        print("ERROR: metadata.json must be a JSON array", file=sys.stderr)
        sys.exit(1)
    return data


def validate_entries(entries: list, snippets_dir: Path) -> list:
    errors = []
    seen_ids = {}
    seen_files = {}

    validated = []
    for idx, entry in enumerate(entries):
        if not isinstance(entry, dict):
            errors.append(f"Entry at index {idx} is not an object")
            validated.append(None)
            continue

        snippet_id = entry.get("snippetId", "")
        tag = f"[{snippet_id or f'index {idx}'}]"

        entry_errors = []

        # snippetId
        if not snippet_id or not UUID_RE.match(str(snippet_id)):
            entry_errors.append(f"{tag} snippetId is missing or not a valid UUID v4")
        elif snippet_id in seen_ids:
            errors.append(f"Duplicate snippetId found: {snippet_id}")
        else:
            seen_ids[snippet_id] = idx

        # title
        title = entry.get("title", "")
        if not title or not (1 <= len(str(title)) <= 120):
            entry_errors.append(f"{tag} title is missing or exceeds 120 characters")

        # language
        language = entry.get("language", "")
        if language not in ALLOWED_LANGUAGES:
            entry_errors.append(f'{tag} language must be "JAVA", got "{language}"')

        # difficulty
        difficulty = entry.get("difficulty", "")
        if difficulty not in ALLOWED_DIFFICULTIES:
            entry_errors.append(f'{tag} difficulty "{difficulty}" not in BEGINNER, INTERMEDIATE, ADVANCED')

        # owaspCategory
        owasp = entry.get("owaspCategory", "")
        if owasp not in ALLOWED_OWASP:
            entry_errors.append(f'{tag} owaspCategory "{owasp}" is not a recognised OWASP Top 10 category')

        # vulnerableLines
        vlines = entry.get("vulnerableLines")
        vlines_ok = False
        if not isinstance(vlines, list) or len(vlines) == 0:
            entry_errors.append(f"{tag} vulnerableLines must be a non-empty array of integers")
        elif not all(isinstance(v, int) for v in vlines):
            entry_errors.append(f"{tag} vulnerableLines must be a non-empty array of integers")
        elif any(v < 1 for v in vlines):
            entry_errors.append(f"{tag} vulnerableLines contains values less than 1")
        elif len(vlines) != len(set(vlines)):
            entry_errors.append(f"{tag} vulnerableLines contains duplicate line numbers")
        else:
            vlines_ok = True

        # explanation
        explanation = entry.get("explanation", "")
        if not explanation or not (1 <= len(str(explanation)) <= 2000):
            entry_errors.append(f"{tag} explanation is missing or exceeds 2000 characters")

        # source
        source = entry.get("source", "")
        if not source or not (1 <= len(str(source)) <= 300):
            entry_errors.append(f"{tag} source is missing or exceeds 300 characters")

        # file
        file_rel = entry.get("file", "")
        if not file_rel or not str(file_rel).endswith(".java"):
            entry_errors.append(f"{tag} file must be specified and must end with .java")
            file_path = None
        else:
            file_path = snippets_dir / file_rel
            if str(file_rel) in seen_files:
                errors.append(f"Duplicate file reference found: {file_rel}")
            else:
                seen_files[str(file_rel)] = snippet_id
            if not file_path.exists():
                entry_errors.append(f"{tag} file not found: {file_path}")
                file_path = None
            elif vlines_ok:
                try:
                    content = file_path.read_text(encoding="utf-8")
                    line_count = len(content.splitlines())
                    for v in vlines:
                        if v > line_count:
                            entry_errors.append(f"{tag} vulnerableLines value {v} exceeds file line count {line_count}")
                except UnicodeDecodeError:
                    entry_errors.append(f"{tag} file is not valid UTF-8")
                    file_path = None

        errors.extend(entry_errors)
        validated.append(entry if not entry_errors else None)

    return errors, validated


def build_dynamo_item(entry: dict, snippets_dir: Path) -> dict:
    snippet_id = entry["snippetId"]
    difficulty = entry["difficulty"]
    content_key = f"snippets/java/{difficulty.lower()}/{snippet_id}.java"
    file_path = snippets_dir / entry["file"]
    content = file_path.read_text(encoding="utf-8")
    line_count = len(content.splitlines())
    now = datetime.now(timezone.utc).isoformat()

    return {
        "item": {
            "PK": f"SNIPPET#{snippet_id}",
            "SK": "METADATA",
            "GSI1PK": f"DIFFICULTY#{difficulty}",
            "GSI1SK": f"SNIPPET#{snippet_id}",
            "snippetId": snippet_id,
            "title": entry["title"],
            "language": entry["language"],
            "difficulty": difficulty,
            "owaspCategory": entry["owaspCategory"],
            "vulnerableLines": entry["vulnerableLines"],
            "vulnerableLineCount": len(entry["vulnerableLines"]),
            "explanation": entry["explanation"],
            "source": entry["source"],
            "contentKey": content_key,
            "lineCount": line_count,
            "createdAt": now,
            "updatedAt": now,
        },
        "content_key": content_key,
        "content": content.encode("utf-8"),
    }


def seed_config_items(table, dry_run: bool):
    """Seed CONFIG items if they don't exist yet."""
    for config in [DEFAULT_ALGO_PARAMS, DEFAULT_SPEED_MEDIANS]:
        pk = config["PK"]
        sk = config["SK"]
        if dry_run:
            print(f"  [dry-run] Would seed config item {pk}/{sk} if not present")
            continue
        try:
            table.put_item(
                Item=config,
                ConditionExpression="attribute_not_exists(PK)",
            )
            print(f"  Seeded config item {pk}/{sk}")
        except ClientError as e:
            if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                print(f"  Config item {pk}/{sk} already exists, skipping")
            else:
                print(f"  WARNING: Failed to seed config {pk}/{sk}: {e}", file=sys.stderr)


def main():
    args = parse_args()
    snippets_dir = Path(args.snippets_dir).resolve()

    entries = load_metadata(snippets_dir)
    errors, validated = validate_entries(entries, snippets_dir)

    if errors:
        print(f"\nValidation failed with {len(errors)} error(s):", file=sys.stderr)
        for err in errors:
            print(f"  {err}", file=sys.stderr)
        sys.exit(1)

    valid_entries = [e for e in validated if e is not None]
    print(f"Validation passed: {len(valid_entries)} snippet(s) ready to load")

    if args.dry_run:
        print("\n[dry-run] Would upload/write:")
        for entry in valid_entries:
            snippet_id = entry["snippetId"]
            difficulty = entry["difficulty"]
            content_key = f"snippets/java/{difficulty.lower()}/{snippet_id}.java"
            print(f"  S3: s3://{args.bucket}/{content_key}")
            print(f"  DynamoDB: SNIPPET#{snippet_id}")
        print("[dry-run] Would seed CONFIG#ALGO_PARAMS/V0 and CONFIG#SPEED_MEDIANS/V0 if absent")
        print("[dry-run] No AWS calls made.")
        sys.exit(0)

    # Initialise boto3
    try:
        session_kwargs = {}
        if args.profile:
            session_kwargs["profile_name"] = args.profile
        if args.region:
            session_kwargs["region_name"] = args.region
        session = boto3.Session(**session_kwargs)
        s3 = session.client("s3")
        dynamodb = session.resource("dynamodb")
        table = dynamodb.Table(args.table)
    except NoCredentialsError:
        print("ERROR: AWS credentials could not be resolved. Configure your AWS profile or environment.", file=sys.stderr)
        sys.exit(1)

    # Seed config items
    seed_config_items(table, dry_run=False)

    skipped = 0
    succeeded = 0

    for entry in valid_entries:
        snippet_id = entry["snippetId"]
        title = entry["title"]

        try:
            built = build_dynamo_item(entry, snippets_dir)
        except UnicodeDecodeError:
            print(f"  WARNING [{snippet_id}] file is not valid UTF-8 — skipping", file=sys.stderr)
            skipped += 1
            continue

        # Upload to S3
        try:
            s3.put_object(
                Bucket=args.bucket,
                Key=built["content_key"],
                Body=built["content"],
                ContentType="text/plain; charset=utf-8",
            )
        except ClientError as e:
            print(f"  WARNING [{snippet_id}] S3 upload failed: {e}", file=sys.stderr)
            skipped += 1
            continue

        # Write to DynamoDB
        try:
            table.put_item(Item=built["item"])
        except ClientError as e:
            print(f"  WARNING [{snippet_id}] DynamoDB write failed: {e}", file=sys.stderr)
            skipped += 1
            continue

        print(f"  ✓ {snippet_id} ({title})")
        succeeded += 1

    print(f"\nDone: {succeeded} succeeded, {skipped} skipped.")

    if skipped > 0:
        sys.exit(2)


if __name__ == "__main__":
    main()
