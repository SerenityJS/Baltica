import { type Connection, Server as RaknetServer } from "@baltica/raknet";
import { Emitter, Logger } from "@baltica/utils";
import {
   DisconnectMessage, DisconnectPacket, DisconnectReason,
} from "@serenityjs/protocol";
import { Player } from "./player";
import { defaultServerOptions, type ServerEvents, type ServerOptions } from "./types";

export class Server extends Emitter<ServerEvents> {
   public options: ServerOptions;
   public raknet: RaknetServer;
   public players = new Map<string, Player>();

   constructor(options: Partial<ServerOptions> = {}) {
      super();
      this.options = { ...defaultServerOptions, ...options };
      this.raknet = new RaknetServer({
         address: this.options.address,
         port: this.options.port,
         message: this.options.motd,
         maxConnections: this.options.maxConnections,
      });
   }

   private getKey(connection: Connection): string {
      return connection.identifier;
   }

   public async start(): Promise<void> {
      this.raknet.on("connect", (connection) => {
         const key = this.getKey(connection);
         const existing = this.players.get(key);

         if (existing) {
            try {
               const packet = new DisconnectPacket();
               packet.message = new DisconnectMessage(
                  "New connection from the same address.",
               );
               packet.reason = DisconnectReason.Kicked;
               packet.hideDisconnectScreen = false;
               existing.send(packet.serialize());
            } catch (err) {
               Logger.error(err as Error);
            }
         }

         const player = new Player(this, connection);
         this.players.set(key, player);
         this.emit("playerConnect", player);

         Logger.info(`Session received from: ${connection.identifier}`);

         connection.on("disconnect", () => {
            this.onDisconnect(player);
         });
      });

      await this.raknet.start();
   }

   public onDisconnect(player: Player): void {
      const key = this.getKey(player.connection);
      const displayName = player.username || key;
      Logger.info(`Player disconnected: ${displayName}`);
      this.emit("disconnect", displayName, player);
      this.players.delete(key);
   }
}
