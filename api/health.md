# Health

The one route that needs no session. A load balancer or container orchestrator
has none to present, so this is the single exception to "every route requires
authentication".

It reports liveness only — never anything about the data.

---

## `GET /api/health`

**Auth:** none.

```bash
curl -s $BASE/health
```

```json
{
  "status": "ok",
  "database": "2026-08-26T08:20:14.569Z",
  "migrations": 15
}
```

| Field | Meaning |
|-------|---------|
| `status` | `"ok"` if the process is up and the database answered |
| `database` | `now()` as the database reports it — proves the connection is live, not merely configured |
| `migrations` | How many migrations have been applied. If this is lower than the number of files in `src/database/migrations`, someone forgot `npm run migration:run` |

A failure to reach the database surfaces as a 500 rather than `status: "error"` —
the endpoint is deliberately thin, so an unreachable database is an unhealthy
process, not a healthy process reporting bad news.
