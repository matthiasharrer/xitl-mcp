# Docs

The living knowledge base for xitl. Anyone (human or AI) should be able to
pick the project back up after a long gap by reading these. Keep them current
as you work (see "Working style" in the repo `CLAUDE.md`).

| File / dir        | Purpose | Update when… |
| ----------------- | ------- | ------------ |
| `vision.md`       | The product intent: what it's for, principles, out of scope. Matthias's. | He changes direction. |
| `architecture.md` | How the system fits together **right now**. | The structure or flow changes. |
| `decisions/`      | **ADRs**: one per significant decision, with the reasoning. | You make a choice worth remembering *why*. |
| `roadmap.md`      | **Open work only**: what's next, defects, debt. | Priorities shift, debt is found. |
| `roadmap-archive.md` | Shipped roadmap entries (created with the first one). | Something ships: move it here. |
| `ideas.md`        | Parking lot for unscheduled ideas. | An out-of-scope idea comes up. |
| `worklog.md`      | One entry per session: where we left off, why, gotchas. | End of a session. |
| `testing.md`      | **Binding** test plan: fixed cases and the gates every change passes. | A feature ships (it needs cases). |

ADRs: copy `decisions/0000-template.md` to `decisions/NNNN-short-title.md` and
list it in `decisions/README.md`. Superseding = a new ADR; don't rewrite history.
