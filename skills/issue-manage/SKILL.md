---
name: issue-manage
description: Issue 作成・整理・トリアージ。ユーザーが作業内容を説明したときに起動
user-invocable: true
argument-hint: [description]
---

# /issue-manage — Issue Creation and Triage

トリガー: ユーザーが作業内容を説明したとき、Issue の整理を依頼されたとき。

## Issue Creation Flow

1. FIRST run `gh issue list` to review ALL existing issues in the repo
2. Break down the user's request into well-scoped issues
3. **If investigation is needed** (code structure, affected files, bug analysis): launch a Dispatch (sub-agent) via Task tool. The Dispatch returns findings only — it does NOT create issues
4. Based on Dispatch findings and user input, create issues with `gh issue create` — always include a `type/*` label
5. Analyze dependencies: which new issues depend on existing or other new issues
6. Add `depends-on/<number>` labels for each dependency
7. Confirm created issues and their dependency relationships to the user

**IMPORTANT**: Dispatch agents must NEVER run `gh issue create`. Issue creation is exclusively Bridge's responsibility.

## Mandatory Labels on Issue Creation

Every issue MUST have:
1. **One `type/` label** — choose exactly one based on classification criteria

Optional labels:
- `priority/critical` — only when the human explicitly instructs
- `depends-on/<number>` — when the issue depends on another issue (one label per dependency)

> **Note**: No `status/` labels are needed on issue creation. Sortie candidates = open issues without `status/sortied`. The Engine adds `status/sortied` when a Ship launches.

## Type Classification Criteria

| Criterion | Label |
|-----------|-------|
| Existing behavior is broken | `type/bug` |
| Changes to AI control settings (CLAUDE.md, skills/, rules/) | `type/skill` |
| CI/CD, build config, or dependency management | `type/infra` |
| Adding or modifying tests | `type/test` |
| Code improvement with no behavior change | `type/refactor` |
| Adding new functionality | `type/feature` |

If ambiguous, ask the human before creating the issue.

## Issue Creation Best Practices

- Always include clear requirements, acceptance criteria, and type labels
- Include one `type/*` label in every `gh issue create` command

## Dependency Tracking

- Use `depends-on/<number>` labels to mark blocking relationships (one label per dependency)
- The Engine automatically removes `depends-on/<N>` labels when a dependency issue is closed

## Sortie Readiness Evaluation

When asked about what to work on next:
1. Assess issue clarity and priority
2. Recommend a sortie order to the user
3. The user can then ask Flagship to launch sorties

## Issue Triage Rules

When reviewing or organizing existing issues:

1. **Type label**: exactly one `type/` label. If missing, classify and add. If incorrect, replace
2. **Type accuracy**: re-evaluate against classification criteria. If comments changed the nature of work, update accordingly
3. **Legacy labels**: remove outdated labels not following `type/` or `priority/` prefix convention. Remove any `status/ready` or `status/mooring` labels (these are deleted)
4. **Dependency labels**: ensure `depends-on/<number>` labels are accurate. Remove for closed dependencies. Migrate body "## Dependencies" sections to labels

## Priority Rules

- Evaluate urgency and impact when triaging issues
- Use `priority/*` labels to indicate importance (`priority/critical` for urgent issues)
- Only humans may apply the `priority/critical` label — Dock may suggest it but must not apply it
