import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ServerConfig } from "../config/serverConfig";

export type StoragePaths = {
  dataDir: string;
  databasePath: string;
  discussionsDir: string;
};

export function ensureStoragePaths(config: ServerConfig): StoragePaths {
  const paths = {
    dataDir: config.dataDir,
    databasePath: join(config.dataDir, "app.db"),
    discussionsDir: join(config.dataDir, "discussions")
  };

  mkdirSync(paths.discussionsDir, { recursive: true });
  return paths;
}
