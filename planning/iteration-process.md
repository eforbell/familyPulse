# Feature Iteration Agent Instructions

1. Read `planning/current-feature.json` to find active feature
2. Read the PRD at the path specified in `prdPath` (e.g., `planning/features/feature-2-prd.json`)
3. Read `planning/progress.txt` (check Codebase Patterns first)
4. Check you're on the correct branch (from `current-feature.json`)
   - If branch doesn't exist, create it from `master`
5. Start with the highest priority unfinished story, but use judgment:
   - complete one story when the work is naturally bounded
   - complete multiple tightly-coupled stories in one pass when the implementation and verification are materially shared
   - avoid artificial pauses when Codex can carry the work further safely
6. Prefer implementing end-to-end slices instead of partial scaffolding
7. Run the relevant tests for the touched area; run broader test/typecheck passes when the change warrants it
8. Update AGENTS.md with durable learnings when new patterns or gotchas are discovered
9. Update PRD status fields for stories completed in the pass
10. Append learnings to progress.txt
11. Commit when asked or when the operating mode explicitly expects commits
12. Don't ever commit DB credentials or other sensitive private data to git

## Progress Format

APPEND to progress.txt:

```
## [Date] - [Story ID]
- What was implemented
- Files changed
- **Learnings:**
  - Patterns discovered
  - Gotchas encountered
---
```

Consolidate progress items after feature is delivered.


## Codebase Patterns

Add reusable patterns to the TOP 
of progress.txt:

```
## Codebase Patterns
- Pattern name: Description
```

## For python development

Always check to see if virtualenv exists (.venv, venv) over the system python interpreter. Packages are likely already installed locally!

## File Structure

```
planning/
├── current-feature.json  # READ THIS FIRST - active feature config
├── prompt.md             # These instructions
├── progress.txt          # Development log (append here)
└── features/
    ├── feature-1-prd.json
    ├── feature-1-summary.md
    ├── feature-2-prd.json   
    └── feature-2-summary.md
```

## Stop Condition

If ALL stories in current feature pass, reply:
<promise>COMPLETE</promise>

Otherwise end normally after completing a coherent implementation slice.

# Bash Guidelines
## IMPORTANT: Avoid commands that cause output buffering issues
- DO NOT pipe output through `head`, `tail`, `less`, or `more` when monitoring or checking command output
- DO NOT use `| head -n X` or `| tail -n X` to truncate output - these cause buffering problems
- Instead, let commands complete fully, or use `--max-lines` flags if the command supports them
- For log monitoring, prefer reading files directly rather than piping through filters

## When checking command output:
- Run commands directly without pipes when possible
- If you need to limit output, use command-specific flags (e.g., `git log -n 10` instead of `git log | head -10`)
- Avoid chained pipes that can cause output to buffer indefinitely
