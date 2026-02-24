import { CompressionMethod } from "@serenityjs/protocol";

export interface ServerOptions {
   address: string;
   port: number;
   motd: string;
   compressionMethod: CompressionMethod;
   compressionThreshold: number;
   maxConnections: number;
}

export const defaultServerOptions: ServerOptions = {
   address: "0.0.0.0",
   port: 19132,
   motd: "MCPE;Baltica;0;0.0.0;0;0;0;Baltica;Survival;1;19132;19133;0;",
   compressionMethod: CompressionMethod.Zlib,
   compressionThreshold: 1,
   maxConnections: 20,
};
