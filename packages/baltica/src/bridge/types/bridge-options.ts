import { defaultServerOptions, type ServerOptions } from "../../server";

export type BridgeOptions = ServerOptions & {
   destination: {
      address: string;
      port: number;
   };
   offline: boolean;
};

export const defaultBridgeOptions: BridgeOptions = {
   ...defaultServerOptions,
   destination: {
      address: "127.0.0.1",
      port: 19132,
   },
   offline: false,
};
