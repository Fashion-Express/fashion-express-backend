# Auth

Sign in, sign out, sessions and passwords.

Everything under `/api/auth/*` is served by **better-auth** directly rather than
by a Nest controller, so these routes behave a little differently from the rest
of the API: their error bodies are better-auth's shape (`{ message, code }`), not
Nest's.

`GET /api/me` is the exception — that one *is* ours, and it is the route an
application shell actually wants.

> **No account yet?** Sign-in needs a user, and the route that creates users
> needs a session — a closed loop on an empty database. `npm run seed:admin`
> breaks it by writing the first Owner account directly (username `admin`,
> password `12345678` by default; `--help` lists the flags). See
> [README.md](../README.md#the-first-account).

> **Every request below needs an `Origin` header once you are signed in.**
> better-auth refuses its own routes with `403 MISSING_OR_NULL_ORIGIN` when a
> session cookie is present and no trusted origin is declared. Signing in for
> the first time — with no cookie yet — is the one exception. The Nest routes
> never need it. See [README.md](README.md) for the full rule.
>
> ```bash
> ORIGIN=http://localhost:3000
> ```

---

## `POST /api/auth/sign-in/username`

Staff sign in with a **username**, not an email address (FR-00.6).

**Auth:** none.

```bash
curl -s -c $JAR -X POST $BASE/auth/sign-in/username \
  -H 'Content-Type: application/json' \
  -d '{"username":"owner","password":"Owner-Pass-123"}'
```

```json
{
  "redirect": false,
  "token": "wdyL7SMNj496RsKeeujr0zvgNonHuZy8",
  "user": {
    "id": "1",
    "name": "owner",
    "email": "owner@fashionexpress.test",
    "username": "owner",
    "displayUsername": "owner",
    "employeeId": "EMP-A196B6C4",
    "userTypeId": "1",
    "shopId": "1",
    "statusId": "1"
  }
}
```

The important part is not the body but the header:

```
Set-Cookie: better-auth.session_token=…; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax
```

That cookie authenticates every later request. Postman stores it automatically.
The `token` in the body is the same session token; you do **not** need to send it
as a bearer header, and there is no route that accepts one.

`Secure` is absent in development and present in production — it is set from
`NODE_ENV`, because a `Secure` cookie over plain HTTP would simply be dropped.

**Wrong password** — 401, and deliberately vague about which half was wrong:

```json
{ "message": "Invalid username or password", "code": "INVALID_USERNAME_OR_PASSWORD" }
```

### Lockout (FR-00.9, FR-00.10)

After **5 consecutive failures for the same username + IP**, further attempts are
refused for **1 hour** — including attempts with the *correct* password, since
the check happens before the password is examined:

```json
{
  "message": "Too many failed sign-in attempts. Try again in 60 minute(s).",
  "code": "ACCOUNT_TEMPORARILY_LOCKED"
}
```

Status is **429**. A successful sign-in resets the counter, and retrying while
locked does not extend the window. Different IPs are counted separately, and
capitalisation does not create a separate bucket.

To clear a lockout during testing:

```bash
psql -d fashion_express -c "DELETE FROM login_attempts"
```

---

## `GET /api/me`

The route a front end should call on load. better-auth's own `get-session`
cannot answer this, because it knows nothing about user types or permissions.

**Auth:** any signed-in user.

```bash
curl -s -b $JAR $BASE/me
```

```json
{
  "id": "1",
  "username": "owner",
  "displayName": "owner",
  "userType": {
    "id": "1",
    "code": "owner",
    "isSuperuser": true,
    "isManager": true
  },
  "shopId": "1",
  "permissions": ["add_customer", "add_sale", "finalize_sale", "view_user"]
}
```

`permissions` is sorted and complete. Use it to hide menus and buttons the user
cannot use (FR-00.3) — but note that is presentation only. The server enforces
the same rules on every route regardless of what the client renders.

`shopId` is the user's **home shop**, which create forms should default to. It
does *not* restrict what they can see.

`userType.isSuperuser` short-circuits every permission check, so an Owner passes
regardless of the `permissions` list.

---

## `GET /api/auth/get-session`

better-auth's own view of the session. Useful for debugging; `GET /api/me` is
what an application should use.

```bash
curl -s -b $JAR -H "Origin: $ORIGIN" $BASE/auth/get-session
```

```json
{
  "session": { "id": "7", "userId": "1", "expiresAt": "2026-09-02T12:09:31.895Z" },
  "user": { "id": "1", "username": "owner", "userTypeId": "1", "shopId": "1" }
}
```

Returns `null` rather than a 401 when there is no valid session.

---

## `POST /api/auth/sign-out`

```bash
curl -s -b $JAR -c $JAR -H "Origin: $ORIGIN" -X POST $BASE/auth/sign-out
```

```json
{ "success": true }
```

Deletes the session row and clears the cookie. In Postman the jar updates itself;
subsequent requests will start returning 401, which is the point.

---

## `POST /api/auth/change-password`

Changing **your own** password, knowing the current one.

**Auth:** any signed-in user.

```bash
curl -s -b $JAR -c $JAR -X POST $BASE/auth/change-password \
  -H 'Content-Type: application/json' -H "Origin: $ORIGIN" \
  -d '{
    "currentPassword": "Owner-Pass-123",
    "newPassword": "Owner-Pass-456",
    "revokeOtherSessions": false
  }'
```

`revokeOtherSessions: true` signs the account out everywhere else — worth
offering after a suspected compromise.

An administrator resetting *someone else's* password uses
`POST /api/users/:id/password` instead (see [users.md](users.md)), which needs no
knowledge of the old one.

---

## `GET /api/auth/list-sessions`

Every live session for the signed-in account.

```bash
curl -s -b $JAR -H "Origin: $ORIGIN" $BASE/auth/list-sessions
```

```json
[
  {
    "id": "7",
    "token": "BYQeVIbVUsPT9bS8Lb4AMkH4bg4iR8gE",
    "expiresAt": "2026-09-02T08:17:22.950Z",
    "ipAddress": "",
    "userAgent": "curl/8.5.0"
  }
]
```

Pair with `POST /api/auth/revoke-session` (body `{"token":"…"}`) or
`POST /api/auth/revoke-other-sessions`.

---

## `POST /api/auth/is-username-available`

For inline validation on the staff creation form.

**Auth:** none.

```bash
curl -s -X POST $BASE/auth/is-username-available \
  -H 'Content-Type: application/json' -d '{"username":"owner"}'
```

```json
{ "available": false }
```

---

## Routes better-auth exposes that this application does not use

better-auth mounts its full surface, so these respond — but nothing in Fashion
Express is built on them and they should not be relied on:

| Route | Why not |
|-------|---------|
| `POST /api/auth/sign-up/email` | Disabled (`disableSignUp`). Accounts are created by an administrator (FR-00.6) — use `POST /api/users`. |
| `POST /api/auth/sign-in/email` | Staff sign in by username. It would work for an account that has an email set, but no screen offers it. |
| `POST /api/auth/sign-in/social`, `link-social`, `unlink-account` | No social providers are configured. |
| `send-verification-email`, `verify-email`, `request-password-reset`, `reset-password` | No mailer is configured, so nothing is ever sent. |
| `POST /api/auth/delete-user` | Self-service account deletion is not a thing staff should do; `DELETE /api/users/:id` is the administrator's route and carries the right guards. |
| `POST /api/auth/update-user` | Would let a user write their own profile fields directly. The employment and privilege columns are all `input: false`, so it cannot touch those — but `PATCH /api/users/:id` is the supported path. |
