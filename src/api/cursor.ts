import { z } from "zod";

const cursorPayloadSchema = z
  .object({
    createdAt: z.iso.datetime({ offset: true }),
    id: z.uuid(),
  })
  .strict();

export interface MessageCursor {
  createdAt: Date;
  id: string;
}

export function encodeMessageCursor(cursor: MessageCursor): string {
  return Buffer.from(
    JSON.stringify({
      createdAt: cursor.createdAt.toISOString(),
      id: cursor.id,
    }),
  ).toString("base64url");
}

export function decodeMessageCursor(cursor: string): MessageCursor | undefined {
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as unknown;
    const result = cursorPayloadSchema.safeParse(value);

    if (!result.success) {
      return undefined;
    }

    return {
      createdAt: new Date(result.data.createdAt),
      id: result.data.id,
    };
  } catch {
    return undefined;
  }
}
