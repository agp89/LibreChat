---
name: write-tests
description: Use this skill when writing unit tests for LibreChat backend (Jest/TypeScript), frontend components (React Testing Library), or E2E flows (Playwright).
---

# Write Tests for LibreChat

Follow the appropriate section depending on what you need to test.

## Backend Unit Test (packages/api or api)

```typescript
// packages/api/src/myModule/myModule.spec.ts
import { myFunction } from './myModule';

const mockDependency = jest.fn();
jest.mock('./dependency', () => ({ dep: mockDependency }));

describe('myFunction', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns expected result for valid input', async () => {
    mockDependency.mockResolvedValueOnce({ id: '1', name: 'test' });
    const result = await myFunction('valid-input');
    expect(result).toEqual({ id: '1', name: 'test' });
    expect(mockDependency).toHaveBeenCalledWith('valid-input');
  });

  it('throws on invalid input', async () => {
    await expect(myFunction('')).rejects.toThrow('invalid input');
  });

  it('handles dependency errors gracefully', async () => {
    mockDependency.mockRejectedValueOnce(new Error('DB error'));
    await expect(myFunction('input')).rejects.toThrow('DB error');
  });
});
```

Run: `cd packages/api && npx jest myModule`

## Frontend Component Test

```tsx
// client/src/components/Feature/__tests__/Feature.test.tsx
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from 'test/layout-test-utils';
import Feature from '../Feature';

// Mock data-provider hooks
jest.mock('~/data-provider', () => ({
  useGetFeature: jest.fn(),
  useCreateFeatureMutation: jest.fn(),
}));

import { useGetFeature, useCreateFeatureMutation } from '~/data-provider';

const mockData = { _id: '1', name: 'Test Feature' };

describe('Feature', () => {
  beforeEach(() => {
    jest.mocked(useGetFeature).mockReturnValue({
      data: mockData,
      isLoading: false,
      error: null,
    } as ReturnType<typeof useGetFeature>);

    jest.mocked(useCreateFeatureMutation).mockReturnValue({
      mutate: jest.fn(),
      isPending: false,
    } as ReturnType<typeof useCreateFeatureMutation>);
  });

  afterEach(() => jest.clearAllMocks());

  it('shows loading spinner while fetching', () => {
    jest.mocked(useGetFeature).mockReturnValueOnce({
      data: undefined,
      isLoading: true,
      error: null,
    } as ReturnType<typeof useGetFeature>);

    render(<Feature featureId="1" />);
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('renders feature name after successful fetch', () => {
    render(<Feature featureId="1" />);
    expect(screen.getByText('Test Feature')).toBeInTheDocument();
  });

  it('shows error message on fetch failure', () => {
    jest.mocked(useGetFeature).mockReturnValueOnce({
      data: undefined,
      isLoading: false,
      error: new Error('Not found'),
    } as ReturnType<typeof useGetFeature>);

    render(<Feature featureId="1" />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('calls mutation on button click', async () => {
    const mockMutate = jest.fn();
    jest.mocked(useCreateFeatureMutation).mockReturnValue({
      mutate: mockMutate,
      isPending: false,
    } as ReturnType<typeof useCreateFeatureMutation>);

    render(<Feature featureId="1" />);
    fireEvent.click(screen.getByRole('button', { name: /create/i }));

    await waitFor(() => expect(mockMutate).toHaveBeenCalledTimes(1));
  });
});
```

Run: `cd client && npx jest Feature`

## API Route Test (api/server/routes)

```javascript
// api/server/routes/__tests__/feature.test.js
const request = require('supertest');
const app = require('~/server/app');

jest.mock('~/models/Feature', () => ({
  find: jest.fn().mockResolvedValue([{ _id: '1', name: 'test' }]),
  create: jest.fn().mockResolvedValue({ _id: '2', name: 'new' }),
}));

describe('GET /api/feature', () => {
  it('returns 200 with feature list', async () => {
    const res = await request(app)
      .get('/api/feature')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('returns 401 without auth token', async () => {
    const res = await request(app).get('/api/feature');
    expect(res.status).toBe(401);
  });
});
```

## Playwright E2E Test

```typescript
// e2e/specs/feature.spec.ts
import { test, expect } from '@playwright/test';
import { loginUser } from '../setup/auth';

test.describe('Feature Flow', () => {
  test.beforeEach(async ({ page }) => {
    await loginUser(page);
  });

  test('creates a new feature successfully', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /new feature/i }).click();
    await page.getByLabel('Feature name').fill('My Feature');
    await page.getByRole('button', { name: /save/i }).click();
    await expect(page.getByText('My Feature')).toBeVisible();
  });
});
```

Run: `npm run e2e` or `npm run e2e:headed` to see the browser.

## Checklist

- [ ] Test all three states: loading, success, error
- [ ] Mock all external dependencies (DB, logger, external APIs)
- [ ] Use `beforeEach(() => jest.clearAllMocks())` to isolate tests
- [ ] Assert both positive and negative paths
- [ ] No `any` types in test files
- [ ] No `.only` or `.skip` in committed tests
