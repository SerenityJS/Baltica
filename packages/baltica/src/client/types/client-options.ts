import { ClientOptions as RaknetOptions, defaultClientOptions as defaultRaknetClientOptions } from "@baltica/raknet";
import { CompressionMethod, DeviceOS } from "@serenityjs/protocol";
import type { ICacheProvider } from "@baltica/auth";
import type { SkinData } from "./login/login-data";

export interface LoginOptions {
   currentInputMode: number;
   defaultInputMode: number;
   deviceModel: string;
   deviceOS: DeviceOS;
   memoryTier: number;
   platformType: number;
   uiProfile: number;
   graphicsMode: number;
}

export const defaultLoginOptions: LoginOptions = {
   currentInputMode: 1,
   defaultInputMode: 1,
   deviceModel: "",
   deviceOS: DeviceOS.Win10,
   memoryTier: 0,
   platformType: 0,
   uiProfile: 0,
   graphicsMode: 0,
};

export interface PlayerProfile {
   name: string;
   uuid: string;
   xuid: string;
}

export type ClientOptions = {
   username: string;
   tokensFolder: string;
   compressionThreshold: number;
   compressionMethod: CompressionMethod;
   offline: boolean;
   viewDistance: number;
   loginOptions: LoginOptions;
   skinData?: Partial<SkinData>;
   skinFile?: string;
   /** Email for password auth flow */
   email?: string;
   /** Password for password auth flow */
   password?: string;
   /** XBL3.0 token for xbox token auth flow. Format: "XBL3.0 x={userHash};{token}" */
   xboxToken?: string;
   /** Pluggable cache provider. If set, overrides file-based caching. */
   cacheProvider?: ICacheProvider;
} & RaknetOptions;

export const defaultClientOptions = {
   ...defaultRaknetClientOptions,
   username: "Player",
   tokensFolder: ".tokens",
   compressionThreshold: 1,
   compressionMethod: CompressionMethod.Zlib,
   offline: false,
   viewDistance: 32,
   loginOptions: defaultLoginOptions,
} satisfies Omit<ClientOptions, "guid">;
