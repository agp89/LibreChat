---
name: fix-bug
description: Use this skill when diagnosing and fixing a bug in LibreChat. Covers root-cause analysis, targeted fixes, and regression test strategy.
---

# Fix a Bug in LibreChat

Follow these steps to diagnose, fix, and verify a bug.

## Step 1 — Reproduce the bug

Understand the exact conditions that trigger the bug before touching any code.

1. Read the bug report carefully — note error messages, steps to reproduce, and affected versions
2. Identify which workspace the bug lives in (backend, frontend, shared types)
3. Locate the relevant test if one exists:

```bash
# Search for existing tests related to the area
cd api && npx jest --listTests | grep relevant-module
cd client && npx jest --listTests | grep RelevantComponent
```

4. Run the failing test (or write a new one that reproduces the bug):

```bash
cd packages/api && npx jest src/myModule --verbose
```

## Step 2 — Trace the root cause

Use targeted search rather than broad exploration:

```bash
# Find all files related to the bug area
grep -r "errorPattern" packages/api/src --include="*.ts" -l

# Check recent changes to the affected file
git log --oneline -10 -- path/to/file.ts

# Inspect a specific function
grep -n "functionName" packages/api/src/domain/service.ts
```

Key places to check:
- **Backend errors**: `packages/api/src/` for business logic, `api/server/routes/` for HTTP handling
- **Frontend errors**: `client/src/components/` for UI, `client/src/data-provider/` for data fetching
- **Type mismatches**: `packages/data-provider/src/types/` for shared type definitions
- **DB issues**: `packages/data-schemas/src/` for schema and model definitions

## Step 3 — Write a failing test first

Before fixing, write a test that reproduces the bug:

```typescript
// Add to the relevant spec file
it('should NOT exhibit the bug behavior', () => {
  // Arrange: set up the conditions that trigger the bug
  // Act: call the code with those conditions
  // Assert: verify the correct (post-fix) behavior
  expect(result).toBe(expectedValue); // This will FAIL before the fix
});
```

Run it to confirm it fails:

```bash
cd packages/api && npx jest myModule --verbose
```

## Step 4 — Apply the minimal fix

- Make the smallest possible change that fixes the root cause
- Do not refactor unrelated code in the same commit
- Follow all TypeScript and code style conventions from `AGENTS.md`

## Step 5 — Verify

```bash
# Run the test that was failing
cd packages/api && npx jest myModule --verbose

# Run the full test suite for the affected workspace
npm run test:api        # Backend
npm run test:client     # Frontend
npm run test:all        # All unit tests

# Lint
npm run lint

# Build to catch type errors
npm run build
```

Confirm:
- [ ] The failing test now passes
- [ ] No existing tests were broken
- [ ] No new TypeScript or ESLint errors

## Step 6 — Commit

```bash
git commit -m "fix: describe what was broken and what the fix does"
```

## Common Bug Patterns in LibreChat

| Symptom | Where to look |
|---|---|
| 500 error on API call | `packages/api/src/<domain>/`, route handler in `api/server/routes/` |
| Data not appearing in UI | React Query hook in `client/src/data-provider/`, response type mismatch |
| TypeScript compile error | `packages/data-provider/src/types/`, verify exports/imports |
| Test mock not working | Check `jest.mock()` path — must match the import path exactly |
| UI string not translated | Missing key in `client/src/locales/en/translation.json` |
| Build fails after data-provider change | Run `npm run build:data-provider` then `npm run build` |
