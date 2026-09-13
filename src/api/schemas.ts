import { z } from "zod";

export const MAX_CONTENT_LENGTH = 4_000;

const httpUrlSchema = z
  .url()
  .max(2_048)
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "Picture must use HTTP or HTTPS");

export const createConversationSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    picture: httpUrlSchema.optional(),
    is_group: z.boolean(),
    user_ids: z
      .array(z.uuid())
      .min(1)
      .transform((ids) => [...new Set(ids)]),
  })
  .strict();

export const createMessageSchema = z
  .object({
    message_id: z.uuid().optional(),
    conversation_id: z.uuid(),
    content: z.string().trim().min(1).max(MAX_CONTENT_LENGTH),
  })
  .strict();

export const conversationIdSchema = z.uuid();

export const messageListQuerySchema = z
  .object({
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export type CreateConversationInput = z.infer<typeof createConversationSchema>;
export type CreateMessageInput = z.infer<typeof createMessageSchema>;
