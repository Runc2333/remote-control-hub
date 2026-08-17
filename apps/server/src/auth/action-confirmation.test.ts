import { describe, expect, it } from "vitest";
import {
  ActionConfirmationManager,
  type ActionConfirmation,
  type ActionConfirmationRepository,
} from "./action-confirmation.js";

class MemoryRepository implements ActionConfirmationRepository {
  readonly records = new Map<string, ActionConfirmation>();

  public async consume(
    tokenDigest: string,
  ): Promise<ActionConfirmation | undefined> {
    const confirmation = this.records.get(tokenDigest);
    this.records.delete(tokenDigest);
    return confirmation;
  }

  public async create(
    tokenDigest: string,
    confirmation: ActionConfirmation,
  ): Promise<void> {
    this.records.set(tokenDigest, confirmation);
  }
}

const details = {
  action: "admin.user.update",
  actorId: "admin-1",
  payload: { role: "admin", status: "active" },
  sessionId: "session-1",
  targetId: "user-1",
};

describe("action confirmation manager", () => {
  it("binds a token to actor, session, action, target and canonical payload", async () => {
    const manager = new ActionConfirmationManager(new MemoryRepository(), 300);
    const issued = await manager.issue(details);

    await expect(
      manager.consume({
        ...details,
        payload: { status: "active", role: "admin" },
        token: issued.token,
      }),
    ).resolves.toBeUndefined();
  });

  it("consumes mismatched tokens so they cannot be replayed", async () => {
    const manager = new ActionConfirmationManager(new MemoryRepository(), 300);
    const issued = await manager.issue(details);

    await expect(
      manager.consume({
        ...details,
        targetId: "user-2",
        token: issued.token,
      }),
    ).rejects.toThrow("confirmation_invalid");
    await expect(
      manager.consume({ ...details, token: issued.token }),
    ).rejects.toThrow("confirmation_invalid");
  });
});
