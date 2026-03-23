# /escort — On-Demand Gate Reviewer (Session Resume)

Escort skill for on-demand gate review. Launched once per gate phase, performs the
review, submits a verdict, and exits. Session resume (`--resume sessionId`) preserves
context across gates so that planning review insights carry over to code review and
acceptance testing.

## Environment Variables

- `VIBE_ADMIRAL_SHIP_ID` — This Escort Ship's own ID
- `VIBE_ADMIRAL_PARENT_SHIP_ID` — The parent Ship being reviewed
- `VIBE_ADMIRAL_MAIN_REPO` — The fleet's main repository (owner/repo)
- `VIBE_ADMIRAL_ENGINE_PORT` — Engine API port (default: 9721)

## Arguments

- Issue number (e.g., `42`)

## Execution Model

This skill is invoked **once per gate**. After submitting the verdict, **exit normally**.
The Engine will resume this session (with `--resume`) for the next gate, preserving
all context from prior reviews.

```
Gate 1 (planning-gate):
  Escort launched fresh → plan review → verdict → exit
  sessionId saved by Engine

Gate 2 (implementing-gate):
  Escort resumed (--resume sessionId) → code review → verdict → exit
  sessionId updated

Gate 3 (acceptance-test-gate):
  Escort resumed (--resume sessionId) → QA → verdict → exit
```

## Gate Detection

Detect which gate the parent Ship is in:

```bash
PARENT_SHIP_ID="${VIBE_ADMIRAL_PARENT_SHIP_ID}"
ENGINE_PORT="${VIBE_ADMIRAL_ENGINE_PORT:-9721}"

RESULT=$(curl -sf "http://localhost:${ENGINE_PORT}/api/ship/${PARENT_SHIP_ID}/phase")
PHASE=$(echo "$RESULT" | grep -o '"phase":"[^"]*"' | cut -d'"' -f4)
```

Based on `$PHASE`, execute the corresponding review below. If the phase is not a gate
phase, something is wrong — log an error and exit.

## Planning Gate Review

When `PHASE` is `planning-gate`:

1. Read the Issue and its comments to find the Implementation Plan comment:
   ```bash
   gh issue view $ISSUE_NUMBER --repo "$REPO" --json number,title,body,labels,comments
   ```

2. Review the plan for:
   - Alignment with Issue requirements
   - Feasibility and completeness
   - Impact analysis accuracy
   - Test plan adequacy

3. Post review findings as an Issue comment

4. Submit verdict and exit:
   ```bash
   curl -sf "http://localhost:${ENGINE_PORT}/api/ship/${PARENT_SHIP_ID}/gate-verdict" \
     -H 'Content-Type: application/json' \
     -d '{"verdict": "approve"}' # or "reject" with "feedback": "..."
   ```

## Implementing Gate Review

When `PHASE` is `implementing-gate`:

1. Get the PR URL from the parent Ship or find it via gh:
   ```bash
   gh pr list --head "<branch-name>" --repo "$REPO" --json number,url --jq '.[0]'
   ```

2. Review the PR diff:
   ```bash
   gh pr diff <pr-number> --repo "$REPO"
   ```

3. Check for:
   - Code quality and consistency
   - **Alignment with the approved plan** (you reviewed the plan in planning-gate — leverage that context)
   - Test coverage
   - No security issues

4. Post review findings as a PR comment

5. Submit verdict and exit:
   ```bash
   curl -sf "http://localhost:${ENGINE_PORT}/api/ship/${PARENT_SHIP_ID}/gate-verdict" \
     -H 'Content-Type: application/json' \
     -d '{"verdict": "approve"}' # or "reject" with "feedback": "..."
   ```

## Acceptance Test Gate Review

When `PHASE` is `acceptance-test-gate`:

### Step 0: QA Required Check

Check if QA is required by reading the planning-gate transition metadata:
```bash
TRANSITIONS=$(curl -sf "http://localhost:${ENGINE_PORT}/api/ship/${PARENT_SHIP_ID}/phase-transition-log?limit=50")
QA_REQUIRED=$(echo "$TRANSITIONS" | grep -o '"toPhase":"planning-gate"[^}]*"metadata":{[^}]*"qaRequired":[^,}]*' | grep -o '"qaRequired":[^,}]*' | cut -d: -f2 | head -1)
QA_REQUIRED="${QA_REQUIRED:-true}"
```

If `QA_REQUIRED` is `false`:
1. Post a QA skip comment on the PR
2. Submit `approve` verdict immediately
3. Exit

### Steps (when QA is required):

1. Read the Issue to understand acceptance criteria

2. Run Playwright E2E tests if applicable:
   ```bash
   npx playwright test
   ```

3. Verify acceptance criteria are met

4. Submit verdict and exit:
   ```bash
   curl -sf "http://localhost:${ENGINE_PORT}/api/ship/${PARENT_SHIP_ID}/gate-verdict" \
     -H 'Content-Type: application/json' \
     -d '{"verdict": "approve"}' # or "reject" with "feedback": "..."
   ```

## Key Advantages (Session Resume Model)

- **Context preservation**: Plan review insights carry over to code review via `--resume`
- **No polling overhead**: No 30-second polling loop consuming tokens between gates
- **Clean lifecycle**: One process per gate review, no persistent daemon to manage
- **Automatic retry**: If Escort fails, Engine reverts the gate and can re-launch immediately
