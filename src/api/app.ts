import cors from "cors";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import type { ZodError } from "zod";

import {
  bearerToken,
  createSupabaseAuthenticator,
  type Authenticate,
  type AuthenticatedUser,
} from "../auth.js";
import { getDatabaseConnection, type Database } from "../db/client.js";
import type { PublishMessageCreated } from "../kafka/publisher.js";
import { decodeMessageCursor, encodeMessageCursor } from "./cursor.js";
import {
  ConversationNotFoundError,
  createConversation,
  createMessage,
  listConversationMessages,
  listUserConversations,
  MessageIdConflictError,
  SenderNotMemberError,
} from "./repository.js";
import {
  conversationIdSchema,
  createConversationSchema,
  createMessageSchema,
  messageListQuerySchema,
} from "./schemas.js";

export interface ApiLogger {
  error(event: Record<string, unknown>): void;
}

export interface HttpAppOptions {
  getDatabase?: () => Database;
  authenticate?: Authenticate;
  logger?: ApiLogger;
  publishMessageCreated?: PublishMessageCreated;
}

interface ErrorDetail {
  field: string;
  message: string;
}

function validationDetails(error: ZodError): ErrorDetail[] {
  return error.issues.map((issue) => ({
    field: issue.path.length === 0 ? "$" : issue.path.join("."),
    message: issue.message,
  }));
}

function sendError(
  response: Response,
  status: number,
  code: string,
  message: string,
  details?: ErrorDetail[],
): void {
  response.status(status).json({
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  });
}

function clientOrigins(): string[] {
  const configured = (process.env.CLIENT_ORIGIN ?? "http://localhost:3000")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (
    configured.some((origin) => /^https?:\/\/localhost(?::\d+)?$/i.test(origin))
  ) {
    configured.push("http://localhost:3000", "http://localhost:3001");
  }

  return [...new Set(configured)];
}

export function createHttpApp(options: HttpAppOptions = {}): express.Express {
  const app = express();
  const getDatabase = options.getDatabase ?? (() => getDatabaseConnection().db);
  const authenticate = options.authenticate ?? createSupabaseAuthenticator();
  const logger = options.logger ?? console;
  const publishMessageCreated =
    options.publishMessageCreated ??
    (async (message) => {
      const { getMessageCreatedPublisher } = await import("../kafka/client.js");
      await getMessageCreatedPublisher().publish(message);
    });

  app.use(cors({ origin: clientOrigins() }));
  app.use(express.json({ limit: "16kb", strict: true }));

  app.get(["/health", "/api/server"], (_request, response) => {
    response.json({ status: "ok" });
  });

  async function authenticatedUser(
    request: Request,
    response: Response,
  ): Promise<AuthenticatedUser | null> {
    const token = bearerToken(request.get("authorization"));
    if (token === null) {
      sendError(
        response,
        401,
        "AUTH_REQUIRED",
        "Authorization Bearer token is required",
      );
      return null;
    }

    const user = await authenticate(token);
    if (user === null) {
      sendError(
        response,
        401,
        "AUTH_FAILED",
        "Access token is invalid or expired",
      );
      return null;
    }
    return user;
  }

  app.post("/conversation", async (request, response) => {
    const user = await authenticatedUser(request, response);
    if (user === null) return;

    const result = createConversationSchema.safeParse(request.body);
    if (!result.success) {
      sendError(
        response,
        400,
        "VALIDATION_ERROR",
        "Request body is invalid",
        validationDetails(result.error),
      );
      return;
    }

    const created = await createConversation(
      getDatabase(),
      result.data,
      user.id,
    );
    response.status(201).json({
      conversation: {
        ...created.conversation,
        members: created.members,
      },
    });
  });

  app.get("/conversations", async (request, response) => {
    const user = await authenticatedUser(request, response);
    if (user === null) return;

    const conversations = await listUserConversations(getDatabase(), user.id);
    response.json({ conversations });
  });

  app.post("/message", async (request, response) => {
    const user = await authenticatedUser(request, response);
    if (user === null) return;

    const result = createMessageSchema.safeParse(request.body);
    if (!result.success) {
      sendError(
        response,
        400,
        "VALIDATION_ERROR",
        "Request body is invalid",
        validationDetails(result.error),
      );
      return;
    }

    try {
      const persisted = await createMessage(
        getDatabase(),
        result.data,
        user.id,
      );
      await publishMessageCreated(persisted.message);
      response
        .status(persisted.created ? 201 : 200)
        .json({ message: persisted.message });
    } catch (error) {
      if (error instanceof ConversationNotFoundError) {
        sendError(response, 404, "CONVERSATION_NOT_FOUND", error.message);
        return;
      }
      if (error instanceof SenderNotMemberError) {
        sendError(response, 403, "SENDER_NOT_MEMBER", error.message);
        return;
      }
      if (error instanceof MessageIdConflictError) {
        sendError(response, 409, "MESSAGE_ID_CONFLICT", error.message);
        return;
      }
      throw error;
    }
  });

  app.get("/conversation/:id/messages", async (request, response) => {
    const user = await authenticatedUser(request, response);
    if (user === null) return;

    const idResult = conversationIdSchema.safeParse(request.params.id);
    const queryResult = messageListQuerySchema.safeParse(request.query);

    if (!idResult.success || !queryResult.success) {
      const details = [
        ...(idResult.success ? [] : validationDetails(idResult.error)),
        ...(queryResult.success ? [] : validationDetails(queryResult.error)),
      ];
      sendError(
        response,
        400,
        "VALIDATION_ERROR",
        "Path or query parameters are invalid",
        details,
      );
      return;
    }

    const cursor =
      queryResult.data.cursor === undefined
        ? undefined
        : decodeMessageCursor(queryResult.data.cursor);
    if (queryResult.data.cursor !== undefined && cursor === undefined) {
      sendError(response, 400, "INVALID_CURSOR", "Cursor is invalid", [
        { field: "cursor", message: "Cursor is invalid" },
      ]);
      return;
    }

    try {
      const page = await listConversationMessages(
        getDatabase(),
        idResult.data,
        user.id,
        queryResult.data.limit,
        cursor,
      );
      const lastMessage = page.messages.at(-1);
      response.json({
        messages: page.messages,
        next_cursor:
          page.hasMore && lastMessage !== undefined
            ? encodeMessageCursor(lastMessage)
            : null,
      });
    } catch (error) {
      if (error instanceof ConversationNotFoundError) {
        sendError(response, 404, "CONVERSATION_NOT_FOUND", error.message);
        return;
      }
      if (error instanceof SenderNotMemberError) {
        sendError(response, 403, "SENDER_NOT_MEMBER", error.message);
        return;
      }
      throw error;
    }
  });

  app.use((_request, response) => {
    sendError(response, 404, "NOT_FOUND", "Route not found");
  });

  app.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      next: NextFunction,
    ) => {
      void next;

      if (error instanceof SyntaxError) {
        sendError(
          response,
          400,
          "MALFORMED_JSON",
          "Request body is not valid JSON",
        );
        return;
      }

      if (
        typeof error === "object" &&
        error !== null &&
        "type" in error &&
        error.type === "entity.too.large"
      ) {
        sendError(
          response,
          413,
          "PAYLOAD_TOO_LARGE",
          "Request body is too large",
        );
        return;
      }

      logger.error({
        event: "http_request_failed",
        error: error instanceof Error ? error.message : "Unknown error",
      });
      sendError(response, 500, "INTERNAL_ERROR", "Internal server error");
    },
  );

  return app;
}
