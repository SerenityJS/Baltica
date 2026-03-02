import type * as Protocol from "@serenityjs/protocol";
import type { PacketNames } from "../../shared";

export type PlayerEvents = {
   [K in PacketNames]: [packet: InstanceType<(typeof Protocol)[K]>];
} & {
   packet: [Protocol.DataPacket];
   login: [];
   disconnect: [];
   error: [Error];
};
