import type * as Protocol from "@serenityjs/protocol";
import type { PacketNames } from "../../shared/types";

export type BridgePacketSignal<T = Protocol.DataPacket> = {
   packet: T;
   cancelled: boolean;
   modified: boolean;
};

export type BridgePlayerEvents = {
   [K in PacketNames as `clientBound-${K}`]: [signal: BridgePacketSignal<InstanceType<(typeof Protocol)[K]>>];
} & {
   [K in PacketNames as `serverBound-${K}`]: [signal: BridgePacketSignal<InstanceType<(typeof Protocol)[K]>>];
} & {
   "clientBound-*": [signal: BridgePacketSignal<Protocol.DataPacket>, name: string];
   "serverBound-*": [signal: BridgePacketSignal<Protocol.DataPacket>, name: string];
   "*": [signal: BridgePacketSignal<Protocol.DataPacket>, name: string];
};
