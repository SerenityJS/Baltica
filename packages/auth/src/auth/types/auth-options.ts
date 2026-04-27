import type { ICacheProvider } from "../cache";

export type AuthFlow = "deviceCode" | "password" | "xboxToken";

export interface AuthOptions {
   clientId: string;
   flow: AuthFlow;
   username: string;
   cacheDir: string;
   clientPublicKey?: string;
   /** Pluggable cache provider. If set, overrides file-based caching (cacheDir/username are ignored). */
   cacheProvider?: ICacheProvider;
   /** Required when flow is "password" */
   email?: string;
   /** Required when flow is "password" */
   password?: string;
   /** Required when flow is "xboxToken". Format: "XBL3.0 x={userHash};{token}" */
   xboxToken?: string;
   /** @deprecated Use `flow` instead */
   deviceCode?: boolean;
}

export const defaultAuthOptions: AuthOptions = {
   clientId: "000000004C12AE6F",
   flow: "deviceCode",
   username: "default",
   cacheDir: ".baltica/auth",
};
