import { createMessage, type PersistMessageResult } from "../api/repository.js";
import type { CreateMessageInput } from "../api/schemas.js";
import type { Database } from "../db/client.js";
import type { PublishMessageCreated } from "./publisher.js";

export async function persistAndPublishMessage(
  db: Database,
  publish: PublishMessageCreated,
  input: CreateMessageInput,
  senderId: string,
): Promise<PersistMessageResult> {
  const persisted = await createMessage(db, input, senderId);
  await publish(persisted.message);
  return persisted;
}
