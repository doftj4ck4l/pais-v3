import type { DatabaseAdapter } from "./database-adapter";

/** A small registry keeps engine selection out of controllers and agent tools. */
export class DatabaseAdapterRegistry {
  private readonly adapters = new Map<string, DatabaseAdapter>();

  register(adapter: DatabaseAdapter): this {
    if (this.adapters.has(adapter.engine)) {
      throw new Error(`Database adapter already registered: ${adapter.engine}`);
    }
    this.adapters.set(adapter.engine, adapter);
    return this;
  }

  get(engine: string): DatabaseAdapter | null {
    return this.adapters.get(engine) ?? null;
  }

  engines(): string[] {
    return [...this.adapters.keys()];
  }
}
