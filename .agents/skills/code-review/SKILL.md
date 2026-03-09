---
name: code-review
description: Use this skill when reviewing a pull request or code change in LibreChat. Checks for correctness, type safety, conventions, performance, and security.
---

# Code Review for LibreChat

Use this checklist when reviewing any code change. Be constructive — note what is good as well as what needs improvement.

## Architecture & Workspace Boundaries

- [ ] New backend logic is in `/packages/api/src/` (TypeScript), not `/api/` directly
- [ ] New frontend API calls use the `client/src/data-provider/` layer with React Query
- [ ] New shared types are in `/packages/data-provider/src/types/` (not duplicated)
- [ ] New API endpoints are registered in `packages/data-provider/src/api-endpoints.ts`
- [ ] New QueryKeys/MutationKeys are in `packages/data-provider/src/keys.ts`

## Type Safety

- [ ] No `any` types — all parameters, return types, and variables are explicitly typed
- [ ] No `as unknown as T` double casts
- [ ] No `Record<string, unknown>` where a proper interface exists
- [ ] No inline `type` in value imports (`import { type Foo, bar }` → use standalone `import type`)
- [ ] Types reuse existing definitions from `packages/data-provider/src/types/` where applicable

## Code Quality

- [ ] Early returns / guard clauses — no deeply nested logic
- [ ] No duplicate code — shared logic extracted to utilities
- [ ] No magic strings or numbers — constants or config objects used
- [ ] Single-pass loops — no iterating the same collection twice when avoidable
- [ ] No memory leaks — event listeners removed, closures examined

## Frontend Specifics

- [ ] All user-facing strings use `useLocalize()` — no hardcoded English text in JSX
- [ ] New strings added to `client/src/locales/en/translation.json`
- [ ] Accessible HTML — `role`, `aria-label` on interactive/landmark elements
- [ ] Proper React Query dependency arrays — no stale closures
- [ ] `useEffect` dependencies are complete and correct

## Backend Specifics

- [ ] No sensitive data logged (tokens, passwords, PII)
- [ ] Input validation before processing user data
- [ ] Async errors are caught and handled (no unhandled promise rejections)
- [ ] Authentication/authorization middleware applied to protected routes
- [ ] No synchronous I/O in request handlers

## Import Order

Verify imports follow the three-section pattern:
1. Package imports (short → long line length; `react` always first)
2. `import type` statements (long → short; package types first, then local)
3. Local/project imports (long → short)

## Tests

- [ ] New logic has unit tests covering success, failure, and edge cases
- [ ] No `.only` or `.skip` left in test files
- [ ] Mocks are properly isolated (`jest.clearAllMocks()` in `beforeEach`)
- [ ] Tests assert behavior, not implementation details

## Security

- [ ] No secrets or API keys committed
- [ ] No new dependencies added without justification
- [ ] User input is validated/sanitized before use in queries or responses
- [ ] New endpoints respect the existing auth/authorization pattern

## Review Comment Format

When leaving review comments, be specific:

```
**Issue**: Describe what is wrong and why it matters.
**Suggestion**: Show the preferred approach with a code example.
**Severity**: [Blocker | Major | Minor | Nit]
```
