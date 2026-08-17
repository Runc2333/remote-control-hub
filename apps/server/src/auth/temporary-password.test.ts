import { describe, expect, it } from "vitest";
import {
  TemporaryPasswordManager,
  type TemporaryPasswordRecord,
  type TemporaryPasswordRepository,
} from "./temporary-password.js";

class MemoryTemporaryPasswordRepository implements TemporaryPasswordRepository {
  readonly records = new Map<string, TemporaryPasswordRecord>();

  public async consume(
    digest: string,
  ): Promise<TemporaryPasswordRecord | undefined> {
    const record = this.records.get(digest);
    this.records.delete(digest);
    return record;
  }

  public async create(
    digest: string,
    record: TemporaryPasswordRecord,
  ): Promise<void> {
    this.records.set(digest, record);
  }
}

describe("temporary password manager", () => {
  it("stores a digest and consumes the challenge once", async () => {
    const repository = new MemoryTemporaryPasswordRepository();
    const manager = new TemporaryPasswordManager(repository);
    const record = { role: "user" as const, userId: "user-1" };

    const token = await manager.create(record);

    expect(token).toHaveLength(43);
    expect(repository.records.has(token)).toBe(false);
    await expect(manager.consume(token)).resolves.toEqual(record);
    await expect(manager.consume(token)).resolves.toBeUndefined();
  });
});
