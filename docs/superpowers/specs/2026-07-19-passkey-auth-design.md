# Passkey (WebAuthn) Authentication — Design

**Date:** 2026-07-19
**Status:** Approved

## Goal

Let existing users add passkeys from Settings and sign in with them from the Login
page. Passkeys are a third authentication method alongside passwords and
GitHub/Google OAuth. Registration of new accounts still requires email/password or
OAuth — there is no passkey-only signup in this version.

## Scope

In scope:

- Add/list/delete passkeys in Settings (multiple passkeys per user, each named).
- One-tap "Sign in with a passkey" on the Login page using discoverable
  credentials (browser/OS account picker; no email typed first).

Out of scope (explicitly deferred):

- Passkey-only account registration.
- Conditional UI / browser autofill of passkeys from the email field.
- Renaming existing passkeys.

## Approach

Use `@simplewebauthn/server` in the Express server and `@simplewebauthn/browser`
in the React client. No passport strategy; the passkey routes are plain Express
handlers like the existing password routes.

### Relying Party configuration

Derive the Relying Party ID and expected origin from the existing `CLIENT_URL`
config value:

- `expectedOrigin` = `CLIENT_URL` (e.g. `https://runnable.dev`,
  `http://localhost:5175` in dev)
- `rpID` = hostname of `CLIENT_URL` (e.g. `runnable.dev`, `localhost`)

No new environment variables. Each self-hosted instance (runnable.dev,
shoror.com) derives its own rpID, so credentials are naturally scoped per
instance.

## Data model

New TypeORM entity `WebAuthnCredential` (table `webauthn_credentials`) plus a
migration:

| Column         | Type                        | Notes                                            |
| -------------- | --------------------------- | ------------------------------------------------ |
| `id`           | uuid PK                     |                                                  |
| `user`         | ManyToOne → User            | `onDelete: 'CASCADE'`                            |
| `credentialId` | text, unique                | base64url credential ID from the authenticator   |
| `publicKey`    | text                        | base64url-encoded COSE public key                |
| `counter`      | bigint (stored as string by TypeORM; parsed on use) | signature counter, updated on each login |
| `transports`   | simple-json, nullable       | e.g. `["internal","hybrid"]`                     |
| `deviceType`   | varchar                     | `singleDevice` / `multiDevice` from verification |
| `backedUp`     | boolean                     | from verification result                         |
| `name`         | varchar                     | user-supplied label, e.g. "MacBook Touch ID"     |
| `createdAt`    | timestamp                   |                                                  |
| `lastUsedAt`   | timestamp, nullable         | updated on each successful login                 |

The `User` entity is unchanged. `User.passkeys` back-relation (`OneToMany`) is
added for convenience only.

## Challenge storage

Between the options call and the verify call, the issued challenge is stored in
a short-lived signed httpOnly cookie (`webauthnChallenge`), following the same
pattern as the existing `oauthNonce` cookie:

- `httpOnly: true`, `secure` in production, `sameSite: 'lax'`, `maxAge` 5 min,
  `path: '/'`.
- The verify handler reads the cookie, clears it immediately (success or
  failure — each challenge is single-use), and passes it to
  `verifyRegistrationResponse` / `verifyAuthenticationResponse` as
  `expectedChallenge`.
- Missing/expired cookie → 400 "Challenge expired, try again".

Stateless, survives restarts, no new infrastructure.

## API

All routes live in a new `server/src/routes/passkeys.routes.ts`, mounted under
`/api/auth/passkeys` from the existing auth router (or index), and a new
`server/src/services/passkey.service.ts` holds the logic, mirroring the
`AuthService` pattern.

### Management (require `authenticate` middleware)

- `POST /api/auth/passkeys/register/options`
  Returns `generateRegistrationOptions()` output. `excludeCredentials` is set to
  the user's existing credential IDs so the same authenticator can't be
  registered twice. Sets the challenge cookie. Requests
  `residentKey: 'required'` and `userVerification: 'preferred'` so credentials
  are discoverable (needed for one-tap login).
- `POST /api/auth/passkeys/register/verify`
  Body: `{ response, name }`. Verifies attestation against the cookie
  challenge, rpID, and origin. On success stores the credential with the given
  name (default "Passkey" if blank, trimmed, max 64 chars). Returns the created
  passkey summary. Duplicate `credentialId` → 409.
- `GET /api/auth/passkeys`
  Returns the current user's passkeys: `{ id, name, deviceType, backedUp,
  createdAt, lastUsedAt }`. Never returns public keys or credential IDs.
- `DELETE /api/auth/passkeys/:id`
  Deletes the passkey if it belongs to the current user (404 otherwise —
  including when it exists but belongs to someone else, so ownership isn't
  leaked). Deleting the last passkey is allowed; the account still has
  password/OAuth login.

### Login (public, rate-limited with the existing `authLimiter`)

- `POST /api/auth/passkeys/login/options`
  Returns `generateAuthenticationOptions()` with empty `allowCredentials`
  (discoverable-credential flow) and `userVerification: 'preferred'`. Sets the
  challenge cookie.
- `POST /api/auth/passkeys/login/verify`
  Body: `{ response }`. Looks up the credential by `response.id`; unknown
  credential, signature failure, or challenge mismatch all return the same
  generic 401 "Invalid credentials". On success:
  1. Updates `counter` and `lastUsedAt`.
  2. Issues tokens via the existing `AuthService.generateTokens(user)` (so
     `tokenVersion` semantics are identical to password login) and sets them
     with the existing `setAuthCookies()`.
  3. Returns `{ user: serializeUser(user) }` — the same response shape as
     `POST /api/auth/login`.

`serializeUser` and `setAuthCookies` are exported from `auth.routes.ts` and
imported by the passkey routes rather than duplicated.

## Client

Add `@simplewebauthn/browser` to the client workspace.

### Login page (`client/src/pages/Login.tsx`)

A "Sign in with a passkey" button (KeyRound icon) below the OAuth buttons:

1. `POST /api/auth/passkeys/login/options`
2. `startAuthentication()` with the options
3. `POST /api/auth/passkeys/login/verify`
4. On success, a new `loginWithPasskey` action in the auth store performs
   steps 1–3 and sets the returned user in state, then the page calls
   `navigate('/')` — identical post-login behavior to the password form.

The button is hidden when `window.PublicKeyCredential` is undefined.

### Settings page (`client/src/pages/Settings.tsx`)

New "Passkeys" card alongside the existing OAuth-linking section:

- List of passkeys with name, created date, last-used date, and a delete button
  (with confirm).
- "Add passkey" button: prompts for a name (inline input), then runs the
  options → `startRegistration()` → verify flow and refreshes the list.
- If WebAuthn is unsupported, the card shows a short "Your browser doesn't
  support passkeys" message instead of the add button.

## Error handling

- User cancels the browser prompt (`NotAllowedError` from
  `startRegistration`/`startAuthentication`): treated as a quiet no-op/
  "Cancelled" note, not an error banner.
- Expired/missing challenge cookie: 400 with a "try again" message surfaced
  inline.
- Login verify failures: generic 401 "Invalid credentials" (no distinction
  between unknown credential and bad signature).
- Registering an already-registered authenticator: 409 surfaced as "This
  passkey is already registered".

## Security notes

- Challenge cookie is single-use and cleared on every verify attempt.
- rpID/origin are always validated by `@simplewebauthn/server` against the
  `CLIENT_URL`-derived values.
- Login endpoints share the existing `authLimiter` (10 attempts / 15 min).
- Passkey login participates in the existing `tokenVersion` invalidation: a
  password/email change still kills passkey-issued sessions, and passkeys keep
  working after such changes (they're independent credentials).
- Management endpoints scope every query by the authenticated user's ID.

## Testing

- **Service tests** (`server/src/services/__tests__`): mock
  `@simplewebauthn/server`'s verify functions (real attestations require
  hardware) and test: credential storage on successful registration, duplicate
  rejection, counter/`lastUsedAt` update on login, unknown-credential 401, and
  ownership checks on delete.
- **Route tests**: challenge cookie is set by options endpoints and cleared by
  verify endpoints (success and failure), management endpoints reject
  unauthenticated requests, login verify sets the standard auth cookies.
- **Manual E2E**: Chrome's virtual authenticator (DevTools → WebAuthn) against
  the dev server — register in Settings, log out, one-tap login — before the
  feature is considered done.
