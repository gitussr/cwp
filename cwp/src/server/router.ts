import { ErrorCode } from "../protocol/constants.ts";
import { ProtocolError } from "../protocol/errors.ts";
import type { Session } from "./SessionStore.ts";

export interface CommandContext {
  session: Session;
}

export type CommandHandler = (payload: string, ctx: CommandContext) => string | Promise<string>;

/** A simple name -> handler registry for CMD-type frames. */
export class CommandRouter {
  #handlers = new Map<string, CommandHandler>();

  register(command: string, handler: CommandHandler): this {
    this.#handlers.set(command, handler);
    return this;
  }

  has(command: string): boolean {
    return this.#handlers.has(command);
  }

  async dispatch(command: string, payload: string, ctx: CommandContext): Promise<string> {
    const handler = this.#handlers.get(command);
    if (!handler) {
      throw new ProtocolError(ErrorCode.UNKNOWN_COMMAND, `Unknown command: ${command}`);
    }
    return handler(payload, ctx);
  }
}
