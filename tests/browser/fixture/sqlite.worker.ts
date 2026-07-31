// Bring-your-own-worker, exactly as a consuming app does it (see the
// `sqliteEngine` docs): the APP owns the worker file so the APP's bundler
// resolves `@sqlite.org/sqlite-wasm` and its `.wasm` asset.
import { runSqliteWorker } from "../../../src/sqlite-worker";

runSqliteWorker();
