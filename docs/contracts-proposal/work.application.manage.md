# Proposal: `work.application.manage`

Capability `work.application.manage`, owned by `work`, audience `openvibe.work`. A person may manage their own job
applications without a capability; an app or agent token needs this one. Asking the person's OpenVibe.Actor agent
(`POST …/assist`) is always the person themselves and takes no capability.

The routes below are the agent pillar of OpenVibe.Work. A contract release that ships these schemas in
openvibe-contracts is done separately; this document is the proposal it is released from.

## Resource: work.application@1

The application as `GET/POST/PATCH /api/v1/me/applications(/:id)` answer it.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://openvibe.network/contracts/work/application.v1.json",
  "title": "WorkApplication",
  "type": "object",
  "additionalProperties": false,
  "required": ["id", "subject_id", "title", "company", "url", "status", "created_at", "updated_at"],
  "properties": {
    "id": { "type": "string", "pattern": "^wap_[0-9A-HJKMNP-TV-Z]{26}$" },
    "subject_id": { "type": "string", "description": "user:usr_…" },
    "listing_id": { "type": ["string", "null"], "description": "job_<base32> when tracked from a listing" },
    "title": { "type": "string", "maxLength": 500 },
    "company": { "type": "string", "maxLength": 200 },
    "url": { "type": "string", "format": "uri", "maxLength": 2000 },
    "status": { "enum": ["saved", "applied", "interviewing", "offer", "rejected", "withdrawn"] },
    "notes": { "type": "string", "maxLength": 5000 },
    "applied_at": { "type": ["string", "null"], "format": "date-time" },
    "next_step": { "type": "string", "maxLength": 200 },
    "next_step_at": { "type": ["string", "null"], "format": "date-time" },
    "actor_task_id": { "type": ["string", "null"] },
    "created_at": { "type": "string", "format": "date-time" },
    "updated_at": { "type": "string", "format": "date-time" }
  }
}
```

## Resource: work.application-event@1

One append-only status change.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://openvibe.network/contracts/work/application-event.v1.json",
  "title": "WorkApplicationEvent",
  "type": "object",
  "additionalProperties": false,
  "required": ["at", "from_status", "to_status"],
  "properties": {
    "at": { "type": "string", "format": "date-time" },
    "from_status": { "enum": ["saved", "applied", "interviewing", "offer", "rejected", "withdrawn"] },
    "to_status": { "enum": ["saved", "applied", "interviewing", "offer", "rejected", "withdrawn"] }
  }
}
```

## GET /api/v1/me/applications

Filter by `status`, newest first, cursor pagination.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "WorkApplicationsListResult",
  "type": "object",
  "additionalProperties": false,
  "required": ["applications", "next", "count"],
  "properties": {
    "applications": { "type": "array", "items": { "$ref": "work.application@1" } },
    "next": { "type": ["string", "null"] },
    "count": { "type": "integer", "minimum": 0 }
  }
}
```

## POST /api/v1/me/applications

One of `listing_id`, or `title` + `company` + `url`. A second POST for the same listing answers 200 with the existing
application.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "WorkApplicationCreateRequest",
  "type": "object",
  "additionalProperties": false,
  "oneOf": [
    { "required": ["listing_id"], "properties": { "listing_id": { "type": "string" } } },
    {
      "required": ["title", "company", "url"],
      "properties": {
        "title": { "type": "string", "minLength": 1, "maxLength": 500 },
        "company": { "type": "string", "minLength": 1, "maxLength": 200 },
        "url": { "type": "string", "format": "uri", "maxLength": 2000 }
      }
    }
  ]
}
```

## PATCH /api/v1/me/applications/:id

Any subset of the five editable fields; a status change appends an event.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "WorkApplicationPatchRequest",
  "type": "object",
  "additionalProperties": false,
  "minProperties": 1,
  "properties": {
    "status": { "enum": ["saved", "applied", "interviewing", "offer", "rejected", "withdrawn"] },
    "notes": { "type": "string", "maxLength": 5000 },
    "applied_at": { "type": ["string", "null"], "format": "date-time" },
    "next_step": { "type": "string", "maxLength": 200 },
    "next_step_at": { "type": ["string", "null"], "format": "date-time" }
  }
}
```

## POST /api/v1/me/applications/:id/assist

An optional `ask` (defaults to the standard preparation prompt), answered by `{ task_id, task_url }`.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "WorkApplicationAssistRequest",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "ask": { "type": "string", "maxLength": 1000 }
  }
}
```

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "WorkApplicationAssistResult",
  "type": "object",
  "additionalProperties": false,
  "required": ["task_id", "task_url"],
  "properties": {
    "task_id": { "type": "string", "pattern": "^tsk_[0-9A-HJKMNP-TV-Z]{26}$" },
    "task_url": { "type": "string", "format": "uri" }
  }
}
```

## Example bodies

### POST create — valid (from a listing)

```json
{ "listing_id": "job_01JZ0000000000000000000ABC" }
```

### POST create — valid (by hand)

```json
{ "title": "Backend Engineer", "company": "Acme", "url": "https://acme.example/jobs/12" }
```

### POST create — invalid (both modes)

```json
{ "listing_id": "job_01JZ0000000000000000000ABC", "title": "Backend Engineer" }
```

### PATCH — valid (status change)

```json
{ "status": "applied" }
```

### PATCH — invalid (unknown field)

```json
{ "status": "applied", "salary": 120000 }
```

### PATCH — invalid (bad status)

```json
{ "status": "hired" }
```

### assist — valid

```json
{ "ask": "Draft a cover note that emphasises my systems experience." }
```

### assist — invalid (too long)

```json
{ "ask": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
```
