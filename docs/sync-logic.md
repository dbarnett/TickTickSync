# Sync Logic: Conflict Resolution & Corner Cases

Internal developer/contributor doc — not part of the published mkdocs
site (`docs-src/`). Describes how this plugin currently decides which
side wins when TickTick and Obsidian both have a copy of a task, and the
corner cases that fall out of that.

**Scope note:** this covers *task field* sync (status, title, dates,
priority, tags, notes, parent). Deletion handling and file/folder
routing are separate subsystems (`TaskDeletionHandler.ts`,
`FolderSyncService.ts`) and are only mentioned here where they intersect
with conflict resolution.

## The two independent paths

There is no single "sync engine" — pull (TickTick → local) and push
(Obsidian edit → TickTick) are two separate code paths that both read
and write the same Dexie `db.tasks` table, but make very different
decisions about whose data wins.

```mermaid
flowchart LR
    TT[("☁️ TickTick API")]
    Dexie[("💾 Dexie db.tasks<br/>LocalTask: task, updatedAt,<br/>lastModifiedByDeviceId")]
    Obs["📝 Obsidian vault<br/>markdown lines"]

    TT -- "⬇️ pullFromTickTick()<br/>src/sync/pull.ts" --> Dexie
    Obs -- "✏️ checkLineForModifications()<br/>TaskModificationDetector.ts" --> Dexie
    Dexie -- "⬆️ applyModifications() → updateTask()<br/>TicktickRestAPI.ts — ⚠️ no staleness check" --> TT
    Dexie -- "🖋️ updateTaskLineInFile()" --> Obs
```

## Pull path: whole-task, timestamp last-write-wins

`src/sync/pull.ts` (`pullFromTickTick`), decision logic lives in
`src/sync/conflicts.ts` (`resolveTaskConflict`).

```mermaid
flowchart TD
    A[📥 Fetch updated tasks from TT<br/>full or delta since lastDeltaSync] --> B{Local copy exists<br/>in db.tasks?}
    B -- "🆕 no, new task" --> C[✅ No conflict —<br/>write remote as-is]
    B -- "📎 yes, local copy found" --> D{🔁 Echo check:<br/>local.lastModifiedByDeviceId == this device<br/>AND local.task.modifiedTime == remote.modifiedTime?}
    D -- "🔁 yes, this is our own echo" --> E[⏭️ Skip —<br/>just-pushed change bouncing back]
    D -- "❌ no, genuinely new remote state" --> F{⚖️ local.updatedAt >= remote.modifiedTime?}
    F -- "🏠 yes, local is newer/tied" --> G[🏠 Local wins — conflictDetected=true<br/>keep local task object entirely]
    F -- "☁️ no, remote is newer" --> H[☁️ Remote wins — conflictDetected=true<br/>overwrite with remote task object entirely]
    G --> I[💾 bulkPut resolved task to db.tasks]
    H --> I
    C --> I
    I --> J[📝 logSyncEvent conflict:resolved<br/>if conflictDetected]
```

Key properties:
- **Whole-task granularity.** The winner's *entire* task object replaces
  the loser's — this is not a per-field merge. If local wins, none of
  remote's changes (even to fields local didn't touch) survive this
  pull.
- **Echo suppression** exists specifically so a device doesn't
  immediately re-pull-and-conflict against the change it just pushed
  itself, before TT's `modifiedTime` has had a chance to diverge.
- Deletions are handled separately (below the conflict-resolution block
  in `pull.ts`) — a TT-reported deletion just sets `local.deleted = true`
  unconditionally, no conflict check against local edits.
- `lastFullSync` / `lastDeltaSync` checkpoints gate whether the *next*
  pull is a full or incremental fetch — doesn't affect per-task conflict
  logic, only which tasks get considered.

## Push path: field-diff triggered, no staleness check

`src/services/TaskModificationDetector.ts` (`checkLineForModifications`
→ `detectModifications` → `applyModifications`), API call in
`src/services/TicktickRestAPI.ts` (`updateTask`).

### Current behavior

```mermaid
sequenceDiagram
    participant Editor as 📝 Obsidian editor
    participant TMD as 🔍 TaskModificationDetector
    participant Dexie as 💾 db.tasks (savedTask)
    participant API as 📤 TicktickRestAPI.updateTask()
    participant TT as ☁️ TickTick API

    Editor->>TMD: line edited
    TMD->>TMD: parse line → lineTask (ALL fields, fresh from line text)
    TMD->>Dexie: load savedTask (last-known-synced snapshot)
    TMD->>TMD: detectModifications(lineTask, savedTask)<br/>→ per-field boolean flags (titleModified, statusModified, ...)
    alt ✏️ any flag true (hasContentChanges)
        TMD->>API: updateTask(lineTask) — WHOLE object, every field
        API->>TT: PUT/POST full task payload
        Note over API,TT: ⚠️ No timestamp/modifiedTime check here.<br/>⚠️ No echo-suppression equivalent.<br/>💥 Any field TT changed but hasn't been<br/>pulled down yet gets silently<br/>overwritten by savedTask's stale value.
    end
```

This is the confirmed root cause of two live incidents (2026-07-27/28,
David's account): a task completed on mobile got silently reverted, and
a task's priority got silently reverted — both because an unrelated
field edit (or a routine resync) triggered a full-object push that
carried a stale `status`/`priority` value along for the ride, clobbering
a TT-side change the plugin hadn't pulled down yet.

### 🎯 Target fix

Scoped to the push path only. **Not a partial/omitted-fields payload —
that approach is broken here.** `src/api/index.ts` `Tick.updateTask()`
(the wrapper `TicktickRestAPI.updateTask()` calls) builds its outgoing
object field-by-field as `jsonOptions.field ? val : HARDCODED_DEFAULT`
— an *omitted* field isn't left alone, it's reset to a blank default
(`status: 0`, `priority: 0`, `tags: []`, `parentId: null`, ...) before
the request is even sent. Omitting untouched fields would make the
clobbering worse, not better.

Instead: fetch the current server task fresh (`getTaskById`) immediately
before pushing, then merge only the fields `detectModifications`
flagged as changed from `lineTask` onto that live server state, and
send the merged *whole* object. This still satisfies the wrapper's
full-object construction, but every untouched field reflects true
current TT state instead of a stale local (`savedTask`) snapshot.

```mermaid
sequenceDiagram
    participant Editor as 📝 Obsidian editor
    participant TMD as 🔍 TaskModificationDetector
    participant Dexie as 💾 db.tasks (savedTask)
    participant API as 📤 TicktickRestAPI.updateTask()
    participant TT as ☁️ TickTick API

    Editor->>TMD: line edited
    TMD->>TMD: parse line → lineTask (all fields)
    TMD->>Dexie: load savedTask (last-known-synced snapshot)
    TMD->>TMD: detectModifications(lineTask, savedTask)<br/>→ per-field flags (titleModified, statusModified, ...)
    alt ✏️ any flag true (hasContentChanges)
        TMD->>TT: 🔄 getTaskById() — fetch live server state first
        TT-->>TMD: serverTask (current truth, may include<br/>changes not yet pulled)
        TMD->>TMD: 🎯 merged = serverTask, overlaid with<br/>only fields where flag == true
        TMD->>API: updateTask(merged) — still a whole object
        API->>TT: full payload, but untouched fields<br/>carry live server values, not stale local ones
        Note over API,TT: ✅ A field TT changed but hasn't been<br/>pulled down yet survives, because the<br/>base for the merge IS that live change.<br/>⚠️ One extra API round-trip per push —<br/>acceptable, pushes are user-edit-triggered,<br/>not high frequency.
    end
```

**What this closes:** the 💥 row in the corner-cases table below — an
unrelated field edit can no longer clobber a stale field.

**Same fix applied a second place:** `TicktickRestAPI.moveTaskProject()`
has its own follow-up `updateTask()` call (a project-move triggers a
second, "redundant but TickTick does it" whole-object push) that had
the identical bug — sending the raw, unmerged task. Fixed the same way:
fetch live server state, override only `projectId`, send that merged.

**What this does NOT close** (deliberately out of scope for now): the
narrower ⚖️ same-field-both-sides-within-one-interval race, also in the
table below. That's bounded by the sync interval and much smaller in
practice once the merge-onto-live-state fix lands — true general
per-field conflict resolution (timestamp comparison or a user-facing
resolution prompt) is future work if that gap ever proves to matter,
not part of this fix.

## Corner cases (current behavior)

| Case | What happens today |
|---|---|
| ✅ Same device re-pulls its own just-pushed change | Echo-suppressed on pull (skipped) — works correctly. |
| 💥 TT-side field change not yet pulled, unrelated field edited locally | **Not handled.** Push sends the whole `lineTask`, silently overwriting the un-pulled TT change. See "Target fix" under the push-path section above. |
| ⚖️ Local edit and remote edit to the *same* field, both within one sync interval | Pull's LWW resolves it by `updatedAt`/`modifiedTime` comparison — correct in the sense that "most recent wins", but still whole-task granularity, so an unrelated field on the losing side can be lost too. |
| 🗑️ TT reports a task deleted | Local `deleted` flag set unconditionally, no check against pending local edits to that task. |
| 🔄 Full vs. delta sync | Only affects which tasks are considered for pull, not the conflict-resolution decision itself. |
