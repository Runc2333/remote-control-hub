import { describe, expect, it } from "vitest";
import {
  AuditService,
  type AuditRepository,
  type StoredAuditEvent,
} from "./audit-service.js";

class MemoryAuditRepository implements AuditRepository {
  readonly events: StoredAuditEvent[] = [];

  public async append(event: StoredAuditEvent): Promise<void> {
    this.events.push(event);
  }
}

describe("audit service", () => {
  it("stores only an address class and never the source address", async () => {
    const repository = new MemoryAuditRepository();
    const service = new AuditService(
      repository,
      () => new Date("2026-08-17T00:00:00.000+08:00"),
    );

    await service.record({
      action: "auth.login",
      actorId: "user-1",
      actorType: "user",
      ownerUserId: "user-1",
      requestId: "request-1",
      result: "success",
      sourceAddress: "192.168.1.10",
      subjectId: "user-1",
      subjectType: "user",
      visibility: "owner",
    });

    expect(repository.events[0]).toMatchObject({
      action: "auth.login",
      occurredAt: "2026-08-16T16:00:00.000Z",
      sourceAddressClass: "private",
    });
    expect(repository.events[0]).not.toHaveProperty("sourceAddress");
  });

  it.each([
    ["127.12.0.1", "loopback"],
    ["::1", "loopback"],
    ["169.254.10.20", "private"],
    ["fd12:3456::1", "private"],
    ["fe80::1", "private"],
    ["8.8.8.8", "public"],
    ["ff02::1", "public"],
    ["invalid", "unknown"],
  ] as const)("classifies %s as %s", async (sourceAddress, expected) => {
    const repository = new MemoryAuditRepository();
    const service = new AuditService(repository);

    await service.record({
      action: "auth.login",
      actorType: "system",
      requestId: "request-1",
      result: "failure",
      sourceAddress,
      subjectId: "anonymous",
      subjectType: "user",
      visibility: "system",
    });

    expect(repository.events[0]?.sourceAddressClass).toBe(expected);
  });
});
