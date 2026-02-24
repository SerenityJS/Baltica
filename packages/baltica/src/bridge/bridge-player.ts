import {
   type ClientToServerHandshakePacket,
   getPacketId,
   Packets,
   PlayStatus,
} from "@serenityjs/protocol";
import { Emitter, Logger } from "@baltica/utils";
import { Client } from "../client";
import type { Player } from "../server";
import type { Bridge } from "./bridge";
import type { BridgePlayerEvents } from "./types";

export class BridgePlayer extends Emitter<BridgePlayerEvents> {
   public bridge: Bridge;
   public player: Player;
   public client!: Client;

   constructor(player: Player, bridge: Bridge) {
      super();
      this.player = player;
      this.bridge = bridge;

      this.player.once(
         "ClientToServerHandshakePacket",
         (packet) => this.onHandshake(packet),
      );
   }

   private onHandshake(_packet: ClientToServerHandshakePacket): void {
      this.client = new Client({
         address: this.bridge.options.destination.address,
         port: this.bridge.options.destination.port,
         offline: this.bridge.options.offline,
      });

      this.client.stopPastLogin = true;

      this.client.once("PlayStatusPacket", (packet) => {
         if (packet.status !== PlayStatus.LoginSuccess) {
            Logger.error("Bridge login failed");
            return;
         }

         this.client.handlePacket = (buffer: Buffer) => {
            this.routePacket(buffer, true);
         };

         this.player.handlePacket = (buffer: Buffer) => {
            this.routePacket(buffer, false);
         };
      });

      this.client.on("DisconnectPacket" as any, () => this.bridge.disconnect(this));
      this.player.on("DisconnectPacket" as any, () => this.bridge.disconnect(this));

      this.on("clientBound-DisconnectPacket" as any, () => this.bridge.disconnect(this));
      this.on("serverBound-DisconnectPacket" as any, () => this.bridge.disconnect(this));

      this.client.connect();
   }

   public routePacket(rawBuffer: Buffer, clientBound: boolean): void {
      let buffer: Buffer = rawBuffer;
      const id = getPacketId(rawBuffer);
      const PacketClass = Packets[id as keyof typeof Packets];

      if (!PacketClass) {
         if (clientBound) this.player.send(buffer);
         else this.client.send(buffer);
         return;
      }

      const event = `${clientBound ? "client" : "server"}Bound-${PacketClass.name}` as keyof BridgePlayerEvents;

      if (this.listenerCount(event) > 0) {
         const ctx = {
            packet: new PacketClass(buffer).deserialize(),
            cancelled: false,
            modified: false,
         };

         this.emit(event, ctx as any);

         if (ctx.cancelled) return;
         if (ctx.modified) buffer = ctx.packet.serialize();
      }

      if (clientBound) this.player.send(buffer);
      else this.client.send(buffer);
   }
}
