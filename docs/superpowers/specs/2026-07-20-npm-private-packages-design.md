# NPM Private Packages — Design

**Date:** 2026-07-20
**Status:** Approved

## Goal

Let a project install dependencies from a private npm registry by storing a
registry URL, an optional scope, and an auth token per project. The token is
encrypted at rest, never returned by the API, and the generated `.npmrc` in
the project directory is deleted at the end of each build. (This does not
cover every place the token can end up — see "Known limitation" below.)

## Scope

In scope:

- Per-project registry config: URL, optional scope, auth token.
- Any registry using the standard `_authToken` `.npmrc` format — npmjs private
  packages, GitHub Packages, GitLab, Verdaccio, Artifactory.
- Encryption at rest for the token, with a reusable crypto helper.
- Closing the on-disk exposure the mechanism creates (static file serving,
  file browser, build logs).

Out of scope (explicitly deferred):

- Multiple registries per project.
- User-level or org-level registry defaults.
- Yarn/pnpm-specific auth files (`.yarnrc.yml`). The build pipeline is npm-only
  today (`DetectService.detectNode` hardcodes `npm install`).
- Migrating `githubToken` / `webhookSecret` to the new encryption helper. The
  helper is designed so they can adopt it later.

## Why a file on disk

`ProcessService.buildAppImage` runs two separate dependency installs:

1. The build command (`npm install && npm run build`) via
   `SandboxService.exec(project.id, 'sh', ['-c', cmd], project.directoryPath, buildEnv)`
   — this one does receive `userEnv`.
2. `railpack build .`, which builds the container image and runs its own
   `npm install` inside it. It receives only `buildkitEnv` — **not** `userEnv`.

So an `NPM_TOKEN` environment variable interpolated into `.npmrc` as
`${NPM_TOKEN}` resolves during step 1 and is undefined during step 2, which is
where the real dependency install happens. A literal `.npmrc` in the project
directory is the only mechanism both steps honor, because both read from the
project directory.

The cost is a plaintext credential on disk during the build. The design
compensates with deletion in a `finally` plus three independent containment
measures (see Containment).

### Known limitation: the token outlives the host copy

The `finally` in `ProcessService.withNpmrc` only deletes the *host* copy of
`.npmrc` — the one in `project.directoryPath`. But `railpack build .` copies
the project directory, `.npmrc` included, into the image it builds, and that
build runs through the shared `runnable-buildkit` container, whose layer
cache persists across builds. So the token is also written into railpack's
build layers and BuildKit's cache, and it stays there — readable by anything
with access to that cache — until those layers are pruned. This is not
verified against a live BuildKit instance here; it follows directly from
`railpack build .` copying the directory it's pointed at and BuildKit caching
layers by default.

This is accepted as a known limitation rather than solved, because the root
cause is structural: railpack runs its own `npm install` inside the image
build (see "Why a file on disk" above), which is why a literal file has to
exist in the directory `railpack build` reads — there is no channel available
at that step for a secret that doesn't also become part of the build context.
Operators who need to bound this exposure should periodically prune the
BuildKit cache (`docker buildx prune` / equivalent for the `runnable-buildkit`
container) or rotate registry tokens on a schedule.

## Data model

Three nullable columns added to the `projects` table (entity
`server/src/entities/Project.ts`) plus a migration:

| Column                  | Type                   | Notes                                                  |
| ----------------------- | ---------------------- | ------------------------------------------------------ |
| `npmRegistryUrl`        | varchar, nullable      | e.g. `https://npm.pkg.github.com/`                     |
| `npmRegistryScope`      | varchar, nullable      | e.g. `@acme`; when null the registry is the default    |
| `npmAuthTokenEncrypted` | text, nullable, `select: false` | ciphertext from the crypto helper             |

`select: false` keeps the ciphertext out of every default TypeORM query, so it
cannot leak through `GET /api/projects/:id` the way `envVars` does today. It
must be loaded explicitly (`addSelect`) at the one place that needs it.

## Encryption

New unit `server/src/services/crypto.service.ts` — small, self-contained, with
no dependencies on project or user concepts:

- `encryptSecret(plaintext: string): string`
- `decryptSecret(payload: string): string`

AES-256-GCM. The key is derived once via `scrypt(config.jwt.secret, salt, 32)`
with a fixed application salt, so no new environment variable is required and
existing production installs work unchanged after deploy.

Stored format: `v1.<iv-b64url>.<authTag-b64url>.<ciphertext-b64url>`. The `v1`
prefix allows rotating the scheme later without ambiguity. `decryptSecret`
throws `AppError('Could not decrypt secret', 500)` on an unknown version,
malformed payload, or GCM auth-tag mismatch — a tampered or key-rotated value
fails loudly rather than yielding garbage.

Consequence to document in the deploy notes: **rotating `JWT_SECRET` makes
stored registry tokens undecryptable**, and users must re-enter them. This is
acceptable — rotating `JWT_SECRET` already invalidates every session.

## `.npmrc` lifecycle

In `ProcessService.buildAppImage`, before the build command runs and wrapping
both install steps:

1. If the project has no `npmRegistryUrl` or no token, do nothing at all — the
   build path is byte-for-byte unchanged for projects that don't use this
   feature.
2. Otherwise decrypt the token and compose the file:

   ```
   @acme:registry=https://npm.pkg.github.com/      # only when a scope is set
   //npm.pkg.github.com/:_authToken=<token>
   ```

   The `_authToken` key is the registry URL reduced to `//host/path/` — origin
   and path, no scheme, with a trailing slash. When no scope is set, the first
   line is `registry=<url>` instead, making it the default registry.
3. If `.npmrc` already exists in the project directory (the repo ships its
   own), rename it to `.npmrc.runnable-backup` first.
4. Run the build (existing behavior).
5. In a `finally`: delete the generated `.npmrc`, and restore the backup if one
   was made. This runs whether the build succeeded, failed, or threw.

A helper `buildNpmrcContent(url, scope, token)` is a pure function so the
composition rules are unit-testable without touching the filesystem.

## Containment

Deletion in a `finally` is not sufficient on its own — a `kill -9` or host
crash mid-build leaves the file. Three independent measures:

**1. Static file serving.** `ServerConfigService.generateConfig` currently emits
a bare `file_server` under `root * <directoryPath>` for `ServerType.STATIC`, so
any dotfile in a static project is publicly downloadable. Add a dotfile rule to
the static block:

```
  @dot path /.*
  respond @dot 403
```

This closes the exposure class generally — it also protects `.runnable.env`
(written today by the compose path) and `.git`.

**2. File browser.** `FileManagerService.listFiles` already skips entries
starting with `.` (line 37), but `readFile` and `writeFile` do not — a direct
request for `.npmrc` succeeds today. Add a guard rejecting any path whose final
segment starts with `.` with `AppError('Access to dotfiles is not permitted', 403)`,
applied in `validatePath` so every caller inherits it.

**3. Build logs.** Build output is written verbatim to
`<storage>/logs/<subdomain>-build.log`. When a token is in play, mask it before
writing — npm echoes registry URLs on failure and a misconfigured `.npmrc` can
surface in error text.

The two install steps reach the log by different routes, so both need covering:

- The build command runs through `SandboxService.exec`, which buffers stdout and
  stderr and hands them to `ProcessService.logAndCheck`. Scrub the buffered
  strings there before they are appended.
- `railpack build` runs through `SandboxService.spawn`, which pipes child output
  straight into the log file. Add an optional `scrub?: (chunk: string) => string`
  parameter to `spawn`, applied per chunk before the write. When omitted,
  behavior is unchanged for every existing caller.

The scrub function is a pure `maskToken(text, token)` returning the text with
every occurrence of the token replaced by `***`, mirroring the existing narrow
scrub in `GithubService.cloneRepo` (`github.service.ts:82-99`). A chunk boundary
can in principle split a token across two writes; this is accepted rather than
buffered around, since the token appearing in output at all is already the
unlikely case and the containment measures above are the primary defense.

## API

All routes require the existing project write permission.

- `GET /api/projects/:id` — the serialized project gains
  `npmRegistry: { url: string | null, scope: string | null, configured: boolean }`.
  The token is never included, in any form.
- `PUT /api/projects/:id/npm-registry` — body `{ url, scope, token }`.
  Validates that `url` parses as an absolute `http(s)` URL (400 otherwise) and
  that `scope`, when present, matches `/^@[a-z0-9-~][a-z0-9-._~]*$/` (400
  otherwise). An empty or omitted `token` **keeps the existing token**, so a
  user can change the URL or scope without re-entering the secret; a token is
  required when none is stored yet.
- `DELETE /api/projects/:id/npm-registry` — clears all three columns.

## UI

An "NPM Registry" card in the project settings view, following the existing
card/form pattern:

- Registry URL (text, required), Scope (text, optional, placeholder `@acme`).
- Auth Token (`type="password"`). When `configured` is true the field renders
  empty with helper text "A token is saved. Leave blank to keep it."
- Save button, and a Remove button shown only when `configured` is true.
- Inline success and error alerts, matching the Change Email / Change Password
  sections.

## Error handling

- Missing or malformed registry config at build time: skip `.npmrc` generation
  entirely; never fail a build over it.
- Decryption failure at build time: fail the build with a clear log line
  ("Stored npm registry token could not be decrypted — re-enter it in project
  settings"), rather than proceeding to a confusing 401 from the registry.
- Registry auth failures surface as normal npm output in the build log, with
  the token masked.

## Testing

- **Crypto** (`crypto.service.test.ts`): round-trip; ciphertext differs across
  calls for the same input (random IV); tampered ciphertext, tampered auth tag,
  unknown version prefix, and malformed payload each throw.
- **`.npmrc` composition** (pure-function tests): scoped vs unscoped output;
  registry URLs with a path (`https://gitlab.com/api/v4/packages/npm/`) reduce
  to the correct `//host/path/:_authToken` key; trailing-slash normalization.
- **Lifecycle**: `.npmrc` is deleted after a successful build; deleted after a
  build that throws; a pre-existing `.npmrc` is restored in both cases; no file
  is written when the project has no registry configured.
- **Containment**: `generateConfig` emits the dotfile rule for `STATIC`;
  `FileManagerService.readFile('.npmrc')` and `writeFile` to a dotfile both
  throw 403; `maskToken` replaces every occurrence in representative npm error
  output; `SandboxService.spawn` applies a supplied `scrub` to streamed chunks
  and behaves identically when none is supplied.
- **API**: token never appears in `GET /api/projects/:id`; invalid URL and
  invalid scope are rejected 400; a blank token on update preserves the stored
  one; delete clears the columns.
