# Bill claims

FR-07. Staff claim money they spent on the company's behalf; a manager approves
or rejects; **approval writes the expense automatically**.

Three states (RD-08): `pending` → `approved` or `rejected`. The status is set by
the workflow and is never typed or chosen freely (FR-07.1.1) — there is no field
for it on any request.

---

## Who sees what

| Permission | Sees |
|------------|------|
| `view_my_bills` | Their own claims (FR-07.3) |
| `review_bills` | Every claim from every employee (FR-07.4) |

The scope follows the caller's permissions, not the URL, so there is no
parameter to change to see someone else's.

---

## `GET /api/bill-claims`

```bash
curl -s -b $JAR "$BASE/bill-claims?status=pending"
```

```json
{
  "items": [
    {
      "id": "1",
      "amount": "1200.00",
      "description": "Client dinner",
      "bill_date": "2026-08-18",
      "status_code": "pending",
      "status_label": "Pending",
      "attachment": null,
      "approval_date": null,
      "submitted_by": "sales",
      "approved_by": null,
      "expense_id": null
    }
  ],
  "page": 1, "pageSize": 10, "total": 2, "totalPages": 1,
  "totals": { "pending": "1600.00", "approved": "0", "rejected": "0", "pending_count": "2" }
}
```

FR-07.4's three figures come back together. They respect the same scope, so a
staff member sees their own three and a reviewer sees everyone's.

| Query | Effect |
|-------|--------|
| `status` | `pending` \| `approved` \| `rejected` |
| `search` | Staff name or description (reviewers) |
| `userId` | One employee's claims |

---

## `POST /api/bill-claims`

**Permission:** `submit_bill`.

```bash
curl -s -b $JAR -X POST $BASE/bill-claims \
  -H 'Content-Type: application/json' \
  -d '{"amount":"1200.00","description":"Client dinner","billDate":"2026-08-18"}'
```

### With a supporting document (FR-07.2)

`multipart/form-data`, field name `attachment`:

```bash
curl -s -b $JAR -X POST $BASE/bill-claims \
  -F 'amount=800.00' \
  -F 'description=Hotel' \
  -F 'billDate=2026-08-22' \
  -F 'attachment=@receipt.pdf'
```

**BR-34 — a fixed extension whitelist.** PDF, JPG, JPEG, PNG, GIF, BMP, WEBP,
DOC, DOCX, XLS, XLSX, CSV, TXT. Anything else is refused outright:

```json
{
  "statusCode": 400,
  "message": "\".sh\" is not an accepted attachment. Allowed: .pdf, .jpg, ..."
}
```

Two things about storage worth knowing:

- **The stored name is generated, never the uploaded one.** A caller-supplied
  filename is a caller-supplied path — `../../etc/passwd`, a null byte, a second
  extension. Generating it removes the whole class of problem, and the response
  carries only the generated name.
- **Files live outside the application's executable path** (NFR-11), in
  `storage/attachments`, never inside `dist/`. Fetch one back with
  `GET /api/bill-claims/:id/attachment`.

---

## `POST /api/bill-claims/:id/approve`

**Permission:** `review_bills`.

```bash
curl -s -b $JAR -X POST $BASE/bill-claims/1/approve \
  -H 'Content-Type: application/json' -d '{"expenseCategoryId":"1"}'
```

**BR-36 — this is one action, and all of it happens or none of it does:**

1. the claim is marked approved,
2. the reviewer and the date are recorded,
3. an **expense is created**, dated to the **bill date**, with the **employee as
   payee**,
4. the claim and the expense are linked so either can be traced from the other.

```json
{
  "id": "1",
  "status_code": "approved",
  "approved_by": "owner",
  "approval_date": "2026-08-26",
  "expense_id": "3"
}
```

The expense is dated to when the cost was *incurred*, not when it was approved.
`expenseCategoryId` is optional and defaults to the reimbursement category.

The database enforces the shape: `billclaim_review_consistent` refuses an
approved claim that has no expense, or no review date, so a half-done approval
cannot exist even in principle.

---

## `POST /api/bill-claims/:id/reject`

**Permission:** `review_bills`.

**BR-37 — records the reviewer and the date and creates no expense.** The same
constraint refuses a rejected claim that somehow acquired one.

---

## BR-35 — a claim is processed once

An approved or rejected claim cannot be processed again, in either direction:

```json
{
  "statusCode": 400,
  "message": "This claim has already been approved and cannot be processed again."
}
```

The row is locked during review, so two reviewers acting at the same time cannot
both see it as pending — the loser gets this sentence rather than a constraint
violation.

A reviewed claim also can no longer be edited or withdrawn: it is part of the
expense record now.

---

## `PATCH /api/bill-claims/:id` · `DELETE /api/bill-claims/:id`

**Permission:** `submit_bill`, and only on **your own, still-pending** claim.
`PATCH` accepts a replacement attachment the same way `POST` does.
