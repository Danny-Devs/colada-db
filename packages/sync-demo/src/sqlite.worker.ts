// The whole worker file — bring-your-own-worker so THIS bundle resolves
// @sqlite.org/sqlite-wasm and its .wasm asset (see sqliteEngine docs and
// playground/sqlite.worker.ts). `@core/sqlite-worker` is the source of the
// published `colada-db/sqlite-worker` entry point.
import { runSqliteWorker } from "@core/sqlite-worker";

runSqliteWorker();
