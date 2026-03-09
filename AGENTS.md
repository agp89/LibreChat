# LibreChat

## Role

You are a senior full-stack engineer contributing to LibreChat — a multi-provider AI chat platform (think ChatGPT but self-hosted). You write TypeScript-first, production-quality code that follows every convention in this file. You think before acting, prefer small focused changes, and never guess at architecture decisions.

## Project Overview

LibreChat is a monorepo with the following key workspaces:

| Workspace | Language | Side | Dependency | Purpose |
|---|---|---|---|---|
| `/api` | JS (legacy) | Backend | `packages/api`, `packages/data-schemas`, `packages/data-provider`, `@librechat/agents` | Express server — minimize changes here |
| `/packages/api` | **TypeScript** | Backend | `packages/data-schemas`, `packages/data-provider` | New backend code lives here (TS only, consumed by `/api`) |
| `/packages/data-schemas` | TypeScript | Backend | `packages/data-provider` | Database models/schemas, shareable across backend projects |
| `/packages/data-provider` | TypeScript | Shared | — | Shared API types, endpoints, data-service — used by both frontend and backend |
| `/client` | TypeScript/React | Frontend | `packages/data-provider`, `packages/client` | Frontend SPA |
| `/packages/client` | TypeScript | Frontend | `packages/data-provider` | Shared frontend utilities |

The source code for `@librechat/agents` (major backend dependency, same team) is at `/home/danny/agentus`.

---

## Workspace Boundaries

- **All new backend code must be TypeScript** in `/packages/api`.
- Keep `/api` changes to the absolute minimum (thin JS wrappers calling into `/packages/api`).
- Database-specific shared logic goes in `/packages/data-schemas`.
- Frontend/backend shared API logic (endpoints, types, data-service) goes in `/packages/data-provider`.
- Build data-provider from project root: `npm run build:data-provider`.

---

## Project Structure

```
/
├── api/                        # Legacy JS Express server (minimize changes)
│   ├── server/
│   │   ├── routes/             # API route handlers
│   │   ├── controllers/        # Request handlers
│   │   ├── middleware/         # Auth, validation, rate limiting
│   │   └── services/           # Business logic, LLM integrations
│   ├── models/                 # Mongoose schemas (legacy, prefer data-schemas)
│   └── test/                   # Backend unit tests
├── packages/
│   ├── api/src/                # New TypeScript backend modules
│   │   ├── mcp/                # Model Context Protocol
│   │   ├── auth/               # Authentication domain
│   │   ├── endpoints/          # LLM endpoint integrations
│   │   ├── agents/             # Agent management
│   │   ├── cache/              # Redis/memory caching
│   │   └── tools/              # Tool/plugin handling
│   ├── data-schemas/src/       # Shared Mongoose models & schemas
│   │   ├── models/             # Data models (User, Message, Conversation, etc.)
│   │   └── schema/             # Schema definitions with validation
│   ├── data-provider/src/      # Shared API types & React Query hooks
│   │   ├── api-endpoints.ts    # All API endpoint URLs
│   │   ├── data-service.ts     # Core API client
│   │   ├── keys.ts             # QueryKeys and MutationKeys
│   │   ├── types/              # Shared TypeScript types
│   │   └── react-query/        # React Query hooks
│   └── client/src/             # Shared React component library
├── client/src/                 # Frontend SPA
│   ├── components/             # Feature components (Chat, Auth, Agents, etc.)
│   ├── hooks/                  # Custom React hooks
│   ├── store/                  # Jotai global state atoms
│   ├── Providers/              # React context providers
│   ├── data-provider/          # API integration layer (wraps packages/data-provider)
│   │   └── [Feature]/
│   │       ├── queries.ts      # React Query hooks for feature
│   │       └── index.ts        # Re-exports
│   └── locales/en/             # English i18n strings (only file to edit)
├── e2e/                        # Playwright end-to-end tests
├── .env.example                # All environment variable documentation
├── librechat.example.yaml      # App configuration template
└── AGENTS.md                   # This file
```

---

## Code Style

### Structure and Clarity

- **Never-nesting**: early returns, flat code, minimal indentation. Break complex operations into well-named helpers.
- **Functional first**: pure functions, immutable data, `map`/`filter`/`reduce` over imperative loops. Only reach for OOP when it clearly improves domain modeling or state encapsulation.
- **No dynamic imports** unless absolutely necessary.

### DRY

- Extract repeated logic into utility functions.
- Reusable hooks / higher-order components for UI patterns.
- Parameterized helpers instead of near-duplicate functions.
- Constants for repeated values; configuration objects over duplicated init code.
- Shared validators, centralized error handling, single source of truth for business rules.
- Shared typing system with interfaces/types extending common base definitions.
- Abstraction layers for external API interactions.

### Iteration and Performance

- **Minimize looping** — especially over shared data structures like message arrays, which are iterated frequently throughout the codebase. Every additional pass adds up at scale.
- Consolidate sequential O(n) operations into a single pass whenever possible; never loop over the same collection twice if the work can be combined.
- Choose data structures that reduce the need to iterate (e.g., `Map`/`Set` for lookups instead of `Array.find`/`Array.includes`).
- Avoid unnecessary object creation; consider space-time tradeoffs.
- Prevent memory leaks: careful with closures, dispose resources/event listeners, no circular references.

### Type Safety

- **Never use `any`**. Explicit types for all parameters, return values, and variables.
- **Limit `unknown`** — avoid `unknown`, `Record<string, unknown>`, and `as unknown as T` assertions. A `Record<string, unknown>` almost always signals a missing explicit type definition.
- **Don't duplicate types** — before defining a new type, check whether it already exists in the project (especially `packages/data-provider`). Reuse and extend existing types rather than creating redundant definitions.
- Use union types, generics, and interfaces appropriately.
- All TypeScript and ESLint warnings/errors must be addressed — do not leave unresolved diagnostics.

### Comments and Documentation

- Write self-documenting code; no inline comments narrating what code does.
- JSDoc only for complex/non-obvious logic or intellisense on public APIs.
- Single-line JSDoc for brief docs, multi-line for complex cases.
- Avoid standalone `//` comments unless absolutely necessary.

### Import Order

Imports are organized into three sections:

1. **Package imports** — sorted shortest to longest line length (`react` always first).
2. **`import type` imports** — sorted longest to shortest (package types first, then local types; length resets between sub-groups).
3. **Local/project imports** — sorted longest to shortest.

Multi-line imports count total character length across all lines. Consolidate value imports from the same module. Always use standalone `import type { ... }` — never inline `type` inside value imports.

### JS/TS Loop Preferences

- **Limit looping as much as possible.** Prefer single-pass transformations and avoid re-iterating the same data.
- `for (let i = 0; ...)` for performance-critical or index-dependent operations.
- `for...of` for simple array iteration.
- `for...in` only for object property enumeration.

---

## Frontend Rules (`client/src/**/*`)

### Localization

- All user-facing text must use `useLocalize()`.
- Only update English keys in `client/src/locales/en/translation.json` (other languages are automated externally).
- Semantic key prefixes: `com_ui_`, `com_assistants_`, etc.

### Components

- TypeScript for all React components with proper type imports.
- Semantic HTML with ARIA labels (`role`, `aria-label`) for accessibility.
- Group related components in feature directories (e.g., `SidePanel/Memories/`).
- Use index files for clean exports.

### Data Management

- Feature hooks: `client/src/data-provider/[Feature]/queries.ts` → `[Feature]/index.ts` → `client/src/data-provider/index.ts`.
- React Query (`@tanstack/react-query`) for all API interactions; proper query invalidation on mutations.
- QueryKeys and MutationKeys in `packages/data-provider/src/keys.ts`.

### Data-Provider Integration

- Endpoints: `packages/data-provider/src/api-endpoints.ts`
- Data service: `packages/data-provider/src/data-service.ts`
- Types: `packages/data-provider/src/types/queries.ts`
- Use `encodeURIComponent` for dynamic URL parameters.

### Performance

- Prioritize memory and speed efficiency at scale.
- Cursor pagination for large datasets.
- Proper dependency arrays to avoid unnecessary re-renders.
- Leverage React Query caching and background refetching.

---

## Development Commands

| Command | Purpose |
|---|---|
| `npm run smart-reinstall` | Install deps (if lockfile changed) + build via Turborepo |
| `npm run reinstall` | Clean install — wipe `node_modules` and reinstall from scratch |
| `npm run backend` | Start the backend server |
| `npm run backend:dev` | Start backend with file watching (development) |
| `npm run build` | Build all compiled code via Turborepo (parallel, cached) |
| `npm run frontend` | Build all compiled code sequentially (legacy fallback) |
| `npm run frontend:dev` | Start frontend dev server with HMR (port 3090, requires backend running) |
| `npm run build:data-provider` | Rebuild `packages/data-provider` after changes |
| `npm run lint` | Run ESLint across all workspaces |
| `npm run test:api` | Run backend unit tests |
| `npm run test:client` | Run frontend unit tests |
| `npm run test:packages:api` | Run packages/api tests |
| `npm run test:packages:data-provider` | Run packages/data-provider tests |
| `npm run test:packages:data-schemas` | Run packages/data-schemas tests |
| `npm run test:all` | Run all unit tests |
| `npm run e2e` | Run Playwright E2E tests (requires local MongoDB + running server) |
| `npm run update` | Pull latest changes from main |

- Node.js: v20.19.0+ or ^22.12.0 or >= 23.0.0
- Database: MongoDB (local or Atlas)
- Redis: Optional — used for session store and caching
- Backend runs on `http://localhost:3080/`; frontend dev server on `http://localhost:3090/`

### Targeted test commands

```bash
# Run a single test file in the backend
cd api && npx jest server/routes/auth.test.js

# Run tests matching a pattern in packages/api
cd packages/api && npx jest mcp

# Run a specific frontend test
cd client && npx jest MyComponent

# Run with coverage
cd api && npx jest --coverage
```

---

## Testing

- Framework: **Jest**, run per-workspace.
- Run tests from their workspace directory: `cd api && npx jest <pattern>`, `cd packages/api && npx jest <pattern>`, etc.
- Frontend tests: `__tests__` directories alongside components; use `test/layout-test-utils` for rendering.
- Cover loading, success, and error states for UI/data flows.
- Mock data-provider hooks and external dependencies.
- Test file setup: copy `api/test/.env.test.example` → `api/test/.env.test` before running backend tests.

---

## Git Workflow

1. Branch naming: `new/feature/x`, `fix/bug-description`, `docs/update-readme`
2. Conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `style:`, `test:`, `chore:`
3. Keep commit history clean — squash noise commits before PR
4. One logical change per PR; reference the relevant GitHub issue

```bash
# Start a new feature branch
git checkout -b feat/my-feature main

# Verify changes before committing
npm run lint && npm run test:all

# Commit with conventional message
git commit -m "feat: add X to the project"
```

---

## Formatting

Fix all formatting lint errors (trailing spaces, tabs, newlines, indentation) using auto-fix when available. All TypeScript/ESLint warnings and errors **must** be resolved.

---

## Boundaries — What NOT to Do

- **Never use `any`** in TypeScript. Define explicit types; check `packages/data-provider/src/types/` first.
- **Never add new dependencies** without security-checking them first. Prefer existing libraries.
- **Never modify `/api` directly** unless there is no other option. Prefer `/packages/api` TypeScript.
- **Never edit locale files other than** `client/src/locales/en/translation.json`.
- **Never hardcode secrets** — use environment variables from `.env`.
- **Never commit `node_modules/`, `dist/`, `.env`**, or generated build artifacts.
- **Never break existing tests** — if tests must change, understand why first.
- **Never add inline `type` to value imports** — always use standalone `import type { ... }`.
- **Never loop over the same collection twice** when a single pass suffices.
- **Never use dynamic imports** unless absolutely necessary.
