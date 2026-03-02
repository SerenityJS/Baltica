import { Emitter, Logger } from "@baltica/utils";
import {
   DisconnectMessage,
   DisconnectPacket,
   DisconnectReason,
} from "@serenityjs/protocol";
import { Server } from "../server";
import { BridgePlayer } from "./bridge-player";
import { type BridgeOptions, defaultBridgeOptions } from "./types";
import type { BridgeEvents } from "./types/bridge-events";
import { Priority } from "@baltica/raknet";

export class Bridge extends Emitter<BridgeEvents> {
   public options: BridgeOptions;
   public server: Server;
   private clients = new Map<string, BridgePlayer>();

   constructor(options: Partial<BridgeOptions>) {
      super();
      this.options = { ...defaultBridgeOptions, ...options };
      this.server = new Server(this.options);
   }

   public async start(): Promise<void> {
      await this.server.start();

      this.server.on("playerConnect", (player) => {
         const bridgePlayer = new BridgePlayer(player, this);
         const key = player.connection.identifier;

         Logger.info(`Player ${key} connected to bridge`);

         this.clients.set(key, bridgePlayer);
         this.emit("connect", bridgePlayer);
      });
   }

   public disconnect(player: BridgePlayer): void {
      Logger.info(`Disconnecting player ${player.player.username}`);

      try {
         const packet = new DisconnectPacket();
         packet.hideDisconnectScreen = false;
         packet.message = new DisconnectMessage("Client leaving", "");
         packet.reason = DisconnectReason.LegacyDisconnect;
         player.client?.send(packet.serialize(), Priority.High);
      } catch {}

      this.emit("disconnect", player);

      const key = player.player.connection.identifier;
      this.clients.delete(key);
      this.server.onDisconnect(player.player);
   }
}
