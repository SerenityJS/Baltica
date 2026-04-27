import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { TokenCache } from "./types";

export interface ICacheProvider {
   load(): TokenCache | Promise<TokenCache>;
   save(cache: TokenCache): void | Promise<void>;
   clear(): void | Promise<void>;
}

export class AuthCache implements ICacheProvider {
   private filePath: string;

   constructor(cacheDir: string, username: string) {
      this.filePath = join(cacheDir, `${username}.json`);
   }

   public load(): TokenCache {
      try {
         if (!existsSync(this.filePath)) return {};
         const raw = readFileSync(this.filePath, "utf-8");
         return JSON.parse(raw) as TokenCache;
      } catch {
         return {};
      }
   }

   public save(cache: TokenCache): void {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(cache, null, 2), "utf-8");
   }

   public clear(): void {
      this.save({});
   }
}

export function isTokenValid(expiresAt: number | undefined): boolean {
   if (!expiresAt) return false;
   return Date.now() < expiresAt - 60_000;
}
