# Migration compatibility

The portal's self-update button (`update.sh`) rolls back **code only** when an
update fails. TypeORM runs migrations on boot (`migrationsRun: true`) and does
not revert them, so after a rollback the database is still migrated while the
code is one revision older.

That is safe only if migrations stay backward compatible. The rule:

> A migration must leave the database readable and writable by the **previous**
> release.

In practice:

- Adding a column, table, or index is always safe (`ADD COLUMN IF NOT EXISTS`).
- Dropping or renaming a column the previous release still reads is **not**.
  Split it across two releases: release N stops using the column, release N+1
  drops it.
- Making a nullable column `NOT NULL` is not safe if the previous release
  inserts rows without it.

Breaking this rule does not fail loudly at migration time. It fails when a
rollback happens — which is exactly when things are already going wrong.
