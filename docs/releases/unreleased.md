# Unreleased

Core ledger fixes since Vibecheck 1.0.2:

- Store newly written commit SHAs in lowercase and match historical SHAs regardless of case. Restating a source commit with different casing preserves integration proof. Existing request hashes and cached responses remain compatible, including receipts containing uppercase SHAs.
- Advance a document's revision once per transaction. A plan acknowledgment and session heartbeat now share the revision recorded in history.
- Preserve the original transaction error when SQLite has already rolled back automatically.
- Log unexpected tool failures to stderr while keeping client error responses sanitized.
- Protect change history with SQLite triggers that reject updates and deletes. Existing schema-v1 databases receive the guards without rewriting their records or history.
- Prune retry receipts older than 30 days during successful new mutations, scoped to the affected project. `PROJECT_BOARD_REQUEST_RETENTION_DAYS` configures the window; `off` disables cleanup. Reads, cached retries, and failed mutations do not prune receipts. Removed receipts no longer provide saved retry results.

The nine tools and their request schemas are preserved. Cancelled prerequisites retain their existing dependency behavior. No Linear integration, JEV verification, model providers, or hooks are added.
