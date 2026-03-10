import { attachEncryptionMiddleware } from '~/middleware/encryption';
import memorySchema from '~/schema/memory';
import type { IMemoryEntry } from '~/types/memory';

attachEncryptionMiddleware(memorySchema, {
  fields: ['value', 'key'],
});

export function createMemoryModel(mongoose: typeof import('mongoose')) {
  return mongoose.models.MemoryEntry || mongoose.model<IMemoryEntry>('MemoryEntry', memorySchema);
}
