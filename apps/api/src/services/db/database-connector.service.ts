import { env } from "../../config/env";
import { DatabaseAdapterRegistry } from "./adapter-registry";
import { redactDatabaseError } from "./database-adapter";
import type {
  ApprovedDatabaseTarget,
  CatalogStep,
  DatabaseAdapter,
  DatabaseConnectionConfig,
  DatabaseError,
  DatabaseResult,
  DatabaseServerProduct,
  QueryOutcome,
  RawCatalog,
} from "./database-adapter";
import { DatabaseNetworkPolicy } from "./network-policy";
import { mysqlAdapter } from "./mysql.driver";
import { postgresqlAdapter } from "./postgres.driver";
import { sqlserverAdapter } from "./sqlserver.driver";
import { sybaseAdapter } from "./sybase.driver";

export const databaseAdapterRegistry = new DatabaseAdapterRegistry()
  .register(postgresqlAdapter)
  .register(mysqlAdapter)
  .register(sqlserverAdapter)
  .register(sybaseAdapter);

type ReadyAdapter = { adapter: DatabaseAdapter; target: ApprovedDatabaseTarget };

/** Common orchestration: validate, authorize/pin the target, then call a driver. */
export class DatabaseConnectorService {
  constructor(
    private readonly registry: DatabaseAdapterRegistry = databaseAdapterRegistry,
    private readonly networkPolicy: DatabaseNetworkPolicy = new DatabaseNetworkPolicy({
      allowedCidrs: env.databaseAllowedCidrs,
    }),
  ) {}

  private async ready(config: DatabaseConnectionConfig): Promise<DatabaseResult<ReadyAdapter>> {
    const invalid = this.validate(config);
    if (invalid) return { ok: false, error: invalid };
    // validate() above proves this lookup exists.
    const adapter = this.registry.get(config.engine)!;

    const target = await this.networkPolicy.approve(config.host);
    if (!target.ok) return target;
    return { ok: true, value: { adapter, target: target.value } };
  }

  async testConnection(
    config: DatabaseConnectionConfig,
  ): Promise<DatabaseResult<{
    latencyMs: number;
    serverVersion?: string;
    serverProduct?: DatabaseServerProduct;
  }>> {
    const ready = await this.ready(config);
    if (!ready.ok) return ready;
    const started = performance.now();
    const result = await ready.value.adapter.testConnection(config, ready.value.target);
    if (!result.ok) return { ok: false, error: redactDatabaseError(result.error, config) };
    return {
      ok: true,
      value: { ...result.value, latencyMs: Math.round(performance.now() - started) },
    };
  }

  async fetchCatalog(
    config: DatabaseConnectionConfig,
    onStep?: (step: CatalogStep) => void,
  ): Promise<DatabaseResult<RawCatalog>> {
    const ready = await this.ready(config);
    if (!ready.ok) return ready;
    const result = await ready.value.adapter.fetchCatalog(config, ready.value.target, onStep);
    return result.ok ? result : { ok: false, error: redactDatabaseError(result.error, config) };
  }

  async executeReadOnly(
    config: DatabaseConnectionConfig,
    sql: string,
    cap?: number,
  ): Promise<QueryOutcome> {
    const ready = await this.ready(config);
    if (!ready.ok) return ready;
    const result = await ready.value.adapter.executeReadOnly(config, ready.value.target, sql, cap);
    return result.ok ? result : { ok: false, error: redactDatabaseError(result.error, config) };
  }

  validate(config: DatabaseConnectionConfig): DatabaseError | null {
    const adapter = this.registry.get(config.engine);
    if (!adapter) {
      return {
        code: "unsupported_engine",
        message: `Unsupported database engine: ${config.engine}`,
        field: "engine",
      };
    }
    return adapter.validate(config);
  }
}

export const databaseConnector = new DatabaseConnectorService();
