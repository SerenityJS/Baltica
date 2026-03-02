import { createSocket, RemoteInfo, Socket } from "node:dgram";
import { randomBytes } from "node:crypto";
import { Emitter } from "@baltica/utils";
import {
   NetworkSession, Packet, Address,
   UnconnectedPing, UnconnectedPong,
   OpenConnectionRequestOne, OpenConnectionReplyOne,
   OpenConnectionRequestTwo, OpenConnectionReplyTwo,
} from "../shared";
import { ServerEvents, ServerOptions, defaultServerOptions } from "./types";
import { Connection } from "./connection";

const RAKNET_PROTOCOL = 11;

export class Server extends Emitter<ServerEvents> {
   private socket: Socket;
   private connections = new Map<string, Connection>();
   public options: ServerOptions;

   constructor(options: Partial<ServerOptions> = {}) {
      super();
      this.options = { ...defaultServerOptions, guid: randomBytes(8).readBigUInt64BE(), ...options };
      this.socket = createSocket(this.options.family);
   }

   private static key(rinfo: RemoteInfo): string {
      return `${rinfo.address}:${rinfo.port}`;
   }

   public async start(): Promise<void> {
      return new Promise((resolve) => {
         this.socket.bind(this.options.port, this.options.address);
         this.socket.on("listening", () => {
            this.socket.on("message", (buffer, rinfo) => this.handleMessage(buffer, rinfo));
            resolve();
         });
      });
   }

   public stop(): void {
      for (const conn of this.connections.values()) conn.disconnect();
      this.connections.clear();
      this.socket.close();
   }

   public getConnection(rinfo: RemoteInfo): Connection | undefined {
      return this.connections.get(Server.key(rinfo));
   }

   public getConnections(): Map<string, Connection> {
      return this.connections;
   }

   private tick(): void {
      for (const conn of this.connections.values()) conn.network.tick();
   }

   private sendTo(data: Buffer, rinfo: RemoteInfo): void {
      this.socket.send(data, rinfo.port, rinfo.address);
   }

   private handleMessage(buffer: Buffer, rinfo: RemoteInfo): void {
      const key = Server.key(rinfo);
      const conn = this.connections.get(key);

      if (conn) {
         conn.network.receive(buffer);
         return;
      }

      const id = buffer[0]!;
      const payload = buffer.subarray(1);

      switch (id) {
         case Packet.UnconnectedPing:
         case Packet.UnconnectedPingOpenConnections: {
            const ping = new UnconnectedPing(payload).deserialize();
            const pong = new UnconnectedPong();
            pong.timestamp = ping.timestamp;
            pong.guid = this.options.guid;
            pong.message = this.options.message;
            this.sendTo(pong.serialize(), rinfo);
            break;
         }
         case Packet.OpenConnectionRequest1: {
            const req = new OpenConnectionRequestOne(payload).deserialize();
            if (req.protocol !== RAKNET_PROTOCOL) break;
            const reply = new OpenConnectionReplyOne();
            reply.guid = this.options.guid;
            reply.security = false;
            reply.cookie = null;
            reply.hasCookie = false;
            reply.serverPublicKey = null;
            reply.mtu = Math.min(this.options.mtu, req.mtu);
            this.sendTo(reply.serialize(), rinfo);
            break;
         }
         case Packet.OpenConnectionRequest2: {
            if (this.connections.size >= this.options.maxConnections) break;
            const req = new OpenConnectionRequestTwo(payload).deserialize();
            const mtu = Math.min(this.options.mtu, req.mtu);

            const session = new NetworkSession(mtu, false);
            session.guid = this.options.guid;
            session.remoteGuid = req.guid;
            session.address = Address.fromIdentifier(rinfo);
            session.serverMessage = this.options.message;
            session.send = (data) => this.sendTo(data, rinfo);

            const reply = new OpenConnectionReplyTwo();
            reply.guid = this.options.guid;
            reply.address = Address.fromIdentifier(rinfo);
            reply.mtu = mtu;
            reply.encryptionEnabled = false;
            session.send(reply.serialize());

            const connection = new Connection(session);

            connection.on("connect", () => this.emit("connect", connection));
            connection.on("disconnect", () => {
               this.connections.delete(key);
               this.emit("disconnect", connection);
            });
            connection.on("encapsulated", (payload) => this.emit("encapsulated", payload, connection));

            this.connections.set(key, connection);
            break;
         }
      }
   }
}
