// The whole worker file — bring-your-own-worker so THIS bundle resolves
// @sqlite.org/sqlite-wasm and its .wasm asset (see sqliteEngine docs).
import { runSqliteWorker } from "../src/sqlite-worker";

runSqliteWorker();
