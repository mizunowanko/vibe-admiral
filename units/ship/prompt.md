# Ship Context

This Ship is managed by vibe-admiral. Use the /implement skill to execute the workflow.

## Environment Variables

- `VIBE_ADMIRAL=true` — Running inside Admiral (worktree/label management handled externally)
- `VIBE_ADMIRAL_SHIP_ID` — This Ship's unique ID
- `VIBE_ADMIRAL_MAIN_REPO` — The fleet's main repository (owner/repo)
- `VIBE_ADMIRAL_ENGINE_PORT` — Engine API port (default: 9721)

## Rate Limit vs Polling vs Machine Sleep

- **Rate limit**: stderr に `429` / `rate_limit_error` が出る。全 Unit が同時に停止する。
- **ポーリング sleep**: スキル内の意図的な待機。エラーは出ない。
- **マシンスリープ復帰**: 応答遅延するがエラーメッセージはない。1 Unit だけの遅延なら rate limit ではない。

rate limit でない遅延に対して不要な待機やリトライを行わないこと。

## Constraints

- Do not modify `.env` files
- Use Engine REST API for phase transitions (see /admiral-protocol skill)

## .claude/ Directory Write Restriction

Claude Code CLI blocks Write/Edit tools and shell redirects (`>`, `>>`) for `.claude/` directory (sensitive directory protection). This applies even with `--dangerously-skip-permissions`.

**Workaround**: Use Bash tool with `tee`, `cp`, `sed -i`, or `mv` to modify files in `.claude/`:
- Write: `echo 'content' | tee .claude/rules/foo.md`
- Copy: `cp /tmp/draft.md .claude/skills/bar/SKILL.md`
- Edit in-place: `sed -i '' 's/old/new/g' .claude/rules/foo.md`
- Multi-line write: `cat <<'HEREDOC' | tee .claude/rules/foo.md`

Read (via Read tool or `cat`) works normally for `.claude/` files.
