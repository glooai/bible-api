declare module "sql.js" {
  export interface SqlJsConfig {
    locateFile?: (file: string, scriptDirectory?: string) => string;
    wasmBinary?: Uint8Array;
  }

  export interface SqlJsStatement {
    bind(params?: unknown[] | Record<string, unknown>): boolean;
    run(params?: unknown[] | Record<string, unknown>): void;
    step(): boolean;
    get(params?: unknown[] | Record<string, unknown>): unknown[];
    free(): void;
  }

  export interface SqlJsDatabase {
    run(sql: string): SqlJsDatabase;
    exec(sql: string): unknown;
    prepare(sql: string): SqlJsStatement;
    export(): Uint8Array;
    close(): void;
  }

  export interface SqlJsStatic {
    Database: new (data?: Uint8Array) => SqlJsDatabase;
  }

  export default function initSqlJs(config?: SqlJsConfig): Promise<SqlJsStatic>;
}
