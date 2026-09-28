import { describe, expect, it, vi } from "vitest";
import { SingleFlight } from "./singleFlight";

describe("SingleFlight", () => {
  it("rejects a second delayed upload and unlocks after success", async () => {
    const flight = new SingleFlight();
    let release: (() => void) | undefined;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const task = vi.fn(() => delayed);

    const first = flight.run(task);
    const second = await flight.run(task);

    expect(flight.isActive).toBe(true);
    expect(task).toHaveBeenCalledTimes(1);
    expect(second).toBe(false);

    release?.();
    await expect(first).resolves.toBe(true);
    await expect(flight.run(task)).resolves.toBe(true);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("unlocks after a failed upload", async () => {
    const flight = new SingleFlight();
    await expect(flight.run(async () => {
      throw new Error("delayed failure");
    })).rejects.toThrow("delayed failure");

    expect(flight.isActive).toBe(false);
    await expect(flight.run(async () => undefined)).resolves.toBe(true);
  });
});
