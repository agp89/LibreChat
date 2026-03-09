# GitHub Copilot Instructions — LibreChat

This is the LibreChat monorepo: a self-hosted, multi-provider AI chat platform. Read `AGENTS.md` at the project root for the complete architecture guide, workspace boundaries, code style, and development commands.

## Quick Reference

### Stack

- **Backend**: Node.js (Express 5) + MongoDB (Mongoose) + optional Redis
- **New backend code**: TypeScript in `/packages/api` (compiled → consumed by `/api`)
- **Frontend**: React 18 + TypeScript + Vite + Tailwind CSS + Jotai + TanStack Query
- **Testing**: Jest (unit) + Playwright (E2E)

### Workspace Rules

| Where to put new code | Workspace |
|---|---|
| New backend logic | `/packages/api/src/` (TypeScript) |
| Shared DB models | `/packages/data-schemas/src/` |
| Shared API types/endpoints | `/packages/data-provider/src/` |
| Frontend components/hooks | `/client/src/` |
| Shared UI primitives | `/packages/client/src/` |

### Must-Follow

- TypeScript only — **never `any`**, **never `unknown`** where a proper type works
- All user-facing strings → `useLocalize()` + `client/src/locales/en/translation.json`
- New API endpoints → `packages/data-provider/src/api-endpoints.ts` + `data-service.ts`
- React Query for all API calls; QueryKeys in `packages/data-provider/src/keys.ts`
- `import type { ... }` as separate statement — never inline `type` in value imports
- Imports: packages (short→long), then `import type` (long→short), then local (long→short)

### Must-Avoid

- Do **not** write new code in `/api` — only thin JS wrappers that call `/packages/api`
- Do **not** use `any` or cast with `as unknown as T`
- Do **not** add frontend text without a localization key
- Do **not** loop over the same collection twice
- Do **not** commit secrets, `.env`, `node_modules/`, or `dist/`

### Key Commands

```bash
npm run build                  # Build all packages (Turborepo)
npm run build:data-provider    # Rebuild data-provider after changes
npm run backend:dev            # Start backend with watch mode
npm run frontend:dev           # Start frontend dev server (port 3090)
npm run lint                   # Run ESLint
npm run test:api               # Backend unit tests
npm run test:client            # Frontend unit tests
npm run test:all               # All unit tests
```
