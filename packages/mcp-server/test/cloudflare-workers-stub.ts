/** Minimal stand-in for the Workers runtime module, for tests under Node. */
export class DurableObject {
  constructor(
    readonly ctx: { storage: { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void> } },
    readonly env: unknown,
  ) {}
}
