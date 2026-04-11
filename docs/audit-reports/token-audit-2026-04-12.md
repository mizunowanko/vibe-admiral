# Token Audit Report — 2026-04-12

> Issue: #922
> Skill: /audit-token

## Overview

3 観点（ソースコード分析・チャットログ分析・トークン集計データ）から vibe-admiral のトークン消費を監査した。

## 1. Source Code Analysis (Z)

### Unit Context Sizes

| Unit | Total Tokens | Top Contributors |
|------|-------------|-----------------|
| Ship (fleet repo) | ~14,246 | CLAUDE.md 4,721 + implement 4,319 + admiral-protocol 3,657 |
| Ship (external repo) | ~10,350 | prompt.md 825 + implement 4,319 + admiral-protocol 3,657 |
| Escort | ~10,329 | CLAUDE.md 4,721 + gate skill ~3,500 + read-issue 1,153 |
| Flagship | ~17,723 | prompt.md 2,752 + sortie 3,707 + ship-inspect 3,373 + admiral-protocol 3,657 |
| Dock | ~15,520 | prompt.md 823 + investigate 3,673 + issue-manage 2,360 + admiral-protocol 3,657 |

### Duplicate Content

| Content | Files | Wasted |
|---------|-------|--------|
| API Quick Reference | flagship/prompt.md + admiral-protocol | ~1,160 tokens |
| commander-rules.md | flagship/rules + dock/rules (identical) | maintenance risk |
| Gate verdict curl blocks | 3 escort gate skills | ~600 tokens/session |

### Cache Efficiency

| File | Commits | Risk |
|------|---------|------|
| CLAUDE.md | 30 | HIGH — cache buster for all Ships/Escorts |
| cli-subprocess.md | 17 | MEDIUM-HIGH |
| commander-rules.md | 10 | MEDIUM |

### Orphaned Resources

- `units/shared/skills/fleet-config/SKILL.md` (4,707 bytes) — not in UNIT_DEPLOY_MAP
- 5 empty sub-skill entries in UNIT_DEPLOY_MAP for Ship

## 2. Chat Log Analysis (Y)

### Sample: Ship #922

| Metric | Value |
|--------|-------|
| Ship total cost | $1.85 |
| Escort total cost | $0.32 |
| Combined | $2.18 |
| Cache ratio | 96% |

### Detected Patterns

| Pattern | Severity | Est. Waste |
|---------|----------|-----------|
| Agent sub-task context rebuild | High | ~700k tokens |
| Repeated file reads (ship-manager.ts ×4) | Medium | ~800k cache pressure |
| Plan-gate format rejection | Low | ~70k tokens |

## 3. Token Aggregation Analysis (U)

### Escort Usage by Ship

| Ship | Issue | Cost |
|------|-------|------|
| 093e3ca0 | #4 | $1.056 |
| b67d2b31 | #7 | $0.713 |
| 13986e88 | #922 | $0.631 |
| 043cd462 | #19 | $0.360 |

- All data is plan-gate only — coding-gate/qa-gate Escort data not available
- Cache hit rate: 89.1%
- Ship cost spread: 2.93x

## Filed Issues

| # | Title | Impact | Label |
|---|-------|--------|-------|
| #925 | Escort の CLAUDE.md を stash | ~4,721 tokens/session | type/refactor |
| #926 | Flagship prompt.md 重複 API 削除 | ~1,160 tokens/session | type/skill |
| #927 | commander-rules.md 共有化 | maintenance | type/refactor |
| #928 | fleet-config & UNIT_DEPLOY_MAP 修正 | cleanup | type/skill |
| #929 | Escort gate verdict 共通化 | ~600 tokens/session | type/refactor |

## Expected Total Savings

- Escort per session: ~5,321 tokens (#925 + #929)
- Flagship per session: ~1,160 tokens (#926)
- 6 Ships × 3 gates: ~95,778 tokens/batch (Escort only)
