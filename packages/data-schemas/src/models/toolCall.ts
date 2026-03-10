import { attachEncryptionMiddleware } from '~/middleware/encryption';
import toolCallSchema, { IToolCallData } from '~/schema/toolCall';

attachEncryptionMiddleware(toolCallSchema, {
  fields: [],
  jsonFields: ['result'],
});

/**
 * Creates or returns the ToolCall model using the provided mongoose instance and schema
 */
export function createToolCallModel(mongoose: typeof import('mongoose')) {
  return mongoose.models.ToolCall || mongoose.model<IToolCallData>('ToolCall', toolCallSchema);
}
