# /sortie — Sortie Planning and Execution

トリガー: ユーザーが実装開始を依頼したとき ("start implementation", "sortie", "出撃", etc.)

## Autonomous Sortie Flow

1. Run `gh issue list --label status/todo` to get ready issues
2. For each issue, check `depends-on/<N>` labels to identify dependencies. If an issue has `depends-on/` labels pointing to open issues, it is blocked
3. Read body AND comments (`gh issue view <number> --json number,title,body,labels,state,comments`) for additional context: sub-issues, "## Dependencies" section (legacy), priority overrides, and human decisions
4. Identify which issues are UNBLOCKED and labeled "status/todo"
5. Apply Sortie Priority Rules to determine the recommended order
6. Explain analysis to the human (which issues are ready, which are blocked and why, and the proposed priority order)
7. Launch UNBLOCKED + "status/todo" issues via `sortie` admiral-request
8. After sortie, monitor with `ship-status` when asked

> **NOTE**: The Engine automatically removes `depends-on/<N>` labels and transitions `status/blocked` → `status/todo` when a dependency issue is closed.

## Label System

### Status labels (`status/` prefix) — Engine-managed, mutually exclusive
| Label | Meaning |
|-------|---------|
| `status/todo` | Ready for sortie |
| `status/planning` | Planning phase |
| `status/implementing` | Implementation in progress |
| `status/acceptance-test` | Acceptance testing |
| `status/merging` | Merge in progress |
| `status/blocked` | Blocked by dependencies |

### Type labels (`type/` prefix) — set by Bridge or human
| Priority | Label | Commit prefix |
|----------|-------|---------------|
| 1 | `type/skill` | `skill:` |
| 2 | `type/bug` | `fix:` |
| 3 | `type/infra` | `infra:` |
| 4 | `type/test` | `test:` |
| 5 | `type/refactor` | `refactor:` |
| 6 | `type/feature` | `feat:` |

## Sortie Priority Rules

### Base Priority (type label order)
| Rank | Label | Target |
|------|-------|--------|
| 1 | `type/skill` | AI control settings |
| 2 | `type/bug` | Bug fixes |
| 3 | `type/infra` | CI/CD and build config |
| 4 | `type/test` | Test additions/fixes |
| 5 | `type/refactor` | Refactoring |
| 6 | `type/feature` | New features |

### Priority Label Override
Issues with `priority/critical` override base priority and sort first. Only humans may apply this label.

### Dependency Constraint
- Issues with `depends-on/<N>` pointing to open issues are blocked and MUST NOT be sortied
- Within same tier, fewer `depends-on/` labels come first (they unblock others)
- `status/blocked` issues are excluded from candidates

### Decision Flow
1. Collect all `status/todo` issues
2. Filter out issues with `depends-on/<N>` pointing to open issues
3. Separate `priority/critical` issues (these come first)
4. Sort remaining by base type priority
5. Within each tier, prefer issues with fewer dependencies
6. Propose ordered list to human → sortie after approval

> **NOTE**: The Engine's `getUnblockedTodoIssues()` returns issues pre-sorted by this priority order. Bridge should respect this order.
