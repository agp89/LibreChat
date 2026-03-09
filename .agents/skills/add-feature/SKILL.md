---
name: add-feature
description: Use this skill when implementing a new end-to-end feature in LibreChat — from data model to API endpoint to frontend UI.
---

# Add a New Feature

Follow these steps to implement a complete feature from database to UI.

## Step 1 — Define the data model (if needed)

Add a Mongoose schema in `/packages/data-schemas/src/schema/`:

```typescript
// packages/data-schemas/src/schema/myFeature.ts
import { Schema } from 'mongoose';

export const myFeatureSchema = new Schema({
  userId: { type: String, required: true, index: true },
  name:   { type: String, required: true },
  // ...
}, { timestamps: true });
```

Register the model in `/packages/data-schemas/src/models/`.

## Step 2 — Define shared types

Add TypeScript types in `/packages/data-provider/src/types/`:

```typescript
// packages/data-provider/src/types/myFeature.ts
export interface TMyFeature {
  _id: string;
  userId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface TCreateMyFeatureRequest {
  name: string;
}
```

Export from `packages/data-provider/src/types/index.ts`.

## Step 3 — Add the API endpoint URL

```typescript
// packages/data-provider/src/api-endpoints.ts
myFeature: () => '/api/my-feature',
myFeatureById: (id: string) => `/api/my-feature/${encodeURIComponent(id)}`,
```

## Step 4 — Add the data-service method

```typescript
// packages/data-provider/src/data-service.ts
getMyFeature: (id: string) =>
  request.get(endpoints.myFeatureById(id)),

createMyFeature: (data: TCreateMyFeatureRequest) =>
  request.post(endpoints.myFeature(), data),
```

## Step 5 — Add QueryKeys and MutationKeys

```typescript
// packages/data-provider/src/keys.ts
export const QueryKeys = {
  // ... existing keys
  myFeature: 'myFeature',
} as const;

export const MutationKeys = {
  // ... existing keys
  createMyFeature: 'createMyFeature',
} as const;
```

## Step 6 — Build data-provider

```bash
npm run build:data-provider
```

## Step 7 — Implement backend logic

```typescript
// packages/api/src/myFeature/service.ts
import type { TCreateMyFeatureRequest, TMyFeature } from 'librechat-data-provider';

export async function createMyFeature(
  userId: string,
  data: TCreateMyFeatureRequest,
): Promise<TMyFeature> {
  // implementation
}
```

## Step 8 — Add route (minimal JS wrapper in /api)

```javascript
// api/server/routes/myFeature.js
const { createMyFeature } = require('@librechat/api');

router.post('/', requireJwtAuth, async (req, res) => {
  const result = await createMyFeature(req.user.id, req.body);
  res.json(result);
});
```

## Step 9 — Add React Query hooks

```typescript
// client/src/data-provider/MyFeature/queries.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { dataService, QueryKeys, MutationKeys } from 'librechat-data-provider';
import type { TMyFeature, TCreateMyFeatureRequest } from 'librechat-data-provider';

export const useGetMyFeature = (id: string) =>
  useQuery<TMyFeature>({
    queryKey: [QueryKeys.myFeature, id],
    queryFn: () => dataService.getMyFeature(id),
    enabled: !!id,
  });

export const useCreateMyFeatureMutation = () => {
  const queryClient = useQueryClient();
  return useMutation<TMyFeature, Error, TCreateMyFeatureRequest>({
    mutationKey: [MutationKeys.createMyFeature],
    mutationFn: (data) => dataService.createMyFeature(data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [QueryKeys.myFeature] }),
  });
};
```

Export from `client/src/data-provider/MyFeature/index.ts` then re-export from `client/src/data-provider/index.ts`.

## Step 10 — Build the UI component

```tsx
// client/src/components/MyFeature/MyFeature.tsx
import React from 'react';
import { useLocalize } from '~/hooks';
import { useGetMyFeature } from '~/data-provider';
import type { TMyFeature } from 'librechat-data-provider';

export default function MyFeature({ featureId }: { featureId: string }) {
  const localize = useLocalize();
  const { data, isLoading } = useGetMyFeature(featureId);

  if (isLoading) {
    return <div role="progressbar" aria-label={localize('com_ui_loading')} />;
  }

  return (
    <section aria-label={localize('com_ui_my_feature')}>
      <h2>{data?.name}</h2>
    </section>
  );
}
```

Add English strings to `client/src/locales/en/translation.json`.

## Step 11 — Write tests

- Unit test the service logic in `/packages/api/src/myFeature/service.spec.ts`
- Component test loading, success, and error states

## Step 12 — Verify

```bash
npm run build
npm run lint
npm run test:all
```
