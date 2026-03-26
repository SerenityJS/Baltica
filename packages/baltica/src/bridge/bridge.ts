import { createSocket } from "node:dgram";
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
import { Priority, UnconnectedPing, UnconnectedPong } from "@baltica/raknet";

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

      this.pollBackendMotd();

      this.server.on("playerConnect", (player) => {
         const bridgePlayer = new BridgePlayer(player, this);
         const key = player.connection.identifier;

         Logger.info(`Player ${key} connected to bridge`);

         this.clients.set(key, bridgePlayer);
         this.emit("connect", bridgePlayer);
      });
   }

   private pollBackendMotd(): void {
      this.fetchBackendMotd().then((motd) => {
         if (motd) this.server.raknet.message = motd;
      }).finally(() => {
         setTimeout(() => this.pollBackendMotd(), 5000);
      });
   }

   private fetchBackendMotd(): Promise<string | null> {
      return new Promise((resolve) => {
         const socket = createSocket("udp4");
         const timeout = setTimeout(() => {
            try { socket.close(); } catch {}
            resolve(null);
         }, 2000);

         socket.on("error", () => {
            clearTimeout(timeout);
            try { socket.close(); } catch {}
            resolve(null);
         });

         socket.on("message", (buffer) => {
            clearTimeout(timeout);
            try { socket.close(); } catch {}
            try {
               if (buffer[0] === 0x1c) {
                  const pong = new UnconnectedPong(buffer.subarray(1)).deserialize();
                  resolve(pong.message);
               } else {
                  resolve(null);
               }
            } catch {
               resolve(null);
            }
         });

         socket.bind(0, () => {
            try {
               const ping = new UnconnectedPing();
               ping.timestamp = BigInt(Date.now());
               ping.guid = BigInt(Math.floor(Math.random() * 0xffffffff));
               socket.send(ping.serialize(), this.options.destination.port, this.options.destination.address);
            } catch {
               clearTimeout(timeout);
               try { socket.close(); } catch {}
               resolve(null);
            }
         });
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
