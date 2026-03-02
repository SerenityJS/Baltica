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
import { Priority } from "@baltica/raknet";

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
      const id = getPacketId(rawBuffer);
      const PacketClass = Packets[id as keyof typeof Packets];

      if (!PacketClass) {
         if (clientBound) this.player.send(rawBuffer);
         else this.client.send(rawBuffer);
         return;
      }

      const direction = clientBound ? "clientBound" : "serverBound";
      const event = `${direction}-${PacketClass.name}` as keyof BridgePlayerEvents;
      const wildcard = `${direction}-*` as keyof BridgePlayerEvents;
      const completeWildCard = `*` as keyof BridgePlayerEvents;

      const hasSpecific = this.listenerCount(event) > 0;
      const hasWildcard = this.listenerCount(wildcard) > 0;
      const hasCompleteWildCard = this.listenerCount(completeWildCard) > 0;

      let cancelled = false;
      let outBuffer = rawBuffer;

      if (hasSpecific || hasWildcard || hasCompleteWildCard) {
         let deserialized: any = null;
         const ctx = {
            get packet() {
               if (!deserialized) {
                  try { deserialized = new PacketClass(Buffer.from(rawBuffer)).deserialize(); }
                  catch { deserialized = rawBuffer; }
               }
               return deserialized;
            },
            set packet(v: any) { deserialized = v; },
            cancelled: false,
            modified: false,
         };

         try {
            if (hasSpecific) this.emit(event, ctx as any);
            if (hasWildcard) this.emit(wildcard, ctx as any, PacketClass.name);
            if (hasCompleteWildCard) this.emit(completeWildCard, ctx as any, PacketClass.name);
         } catch { }

         cancelled = ctx.cancelled;
         if (ctx.modified && deserialized) {
            try { outBuffer = deserialized.serialize(); } catch { }
         }
      }

      if (cancelled) return;
      if (clientBound) this.player.send(outBuffer, Priority.High);
      else this.client.send(outBuffer, Priority.High);
   }
}
