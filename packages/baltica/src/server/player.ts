import { type Connection, Priority } from "@baltica/raknet";
import { Emitter, Logger } from "@baltica/utils";
import {
   CompressionMethod, Framer, getPacketId,
   NetworkSettingsPacket, Packets,
   PlayStatus, PlayStatusPacket,
   ServerToClientHandshakePacket,
} from "@serenityjs/protocol";
import * as jose from "jose";
import { createHash, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { PacketCompressor, PacketEncryptor } from "../shared";
import { type PacketNames } from "../shared/types";
import type { PlayerEvents } from "./types";
import type { Server } from "./server";

const SALT = "\u{1F9C2}";
const SALT_BUFFER = Buffer.from(SALT);
const CURVE = "secp384r1";
const ALGORITHM = "ES384";

export class Player extends Emitter<PlayerEvents> {
   public packetCompressor: PacketCompressor;
   public packetEncryptor: PacketEncryptor | null = null;
   public server: Server;
   public connection: Connection;
   public username: string = "";
   public xuid: string = "";
   private isDisconnected: boolean = false;

   private privateKey: KeyObject;
   private publicKeyDER: Buffer;
   private clientX509: string;
   private sharedSecret!: Buffer;

   constructor(server: Server, connection: Connection) {
      super();
      this.server = server;
      this.connection = connection;
      this.packetCompressor = new PacketCompressor();

      const keypair = generateKeyPairSync("ec", { namedCurve: CURVE });
      this.privateKey = keypair.privateKey;
      this.publicKeyDER = keypair.publicKey.export({ format: "der", type: "spki" });
      this.clientX509 = this.publicKeyDER.toString("base64");

      this.connection.on("encapsulated", (buf) => this.onEncapsulated(buf));
      this.registerHandlers();
   }

   private registerHandlers(): void {
      this.on("RequestNetworkSettingsPacket", () => {
         const settings = new NetworkSettingsPacket();
         settings.compressionThreshold = this.server.options.compressionThreshold;
         settings.clientScalar = 0;
         settings.clientThreshold = 0;
         settings.clientThrottle = false;
         settings.compressionMethod = this.server.options.compressionMethod;
         this.sendUncompressed(settings.serialize());

         this.packetCompressor.compressionMethod = this.server.options.compressionMethod;
         this.packetCompressor.compressionThreshold = this.server.options.compressionThreshold;
      });

      this.on("LoginPacket", async (packet) => {
         try {
            await this.handleLogin(packet);
         } catch (err) {
            Logger.error("Login handling failed:", err);
         }
      });

      this.on("ClientToServerHandshakePacket", () => {
         const status = new PlayStatusPacket();
         status.status = PlayStatus.LoginSuccess;
         this.send(status.serialize());
      });
   }

   private async handleLogin(packet: InstanceType<typeof import("@serenityjs/protocol").LoginPacket>): Promise<void> {
      const identityRaw = packet.tokens.identity;
      const identity = JSON.parse(identityRaw);
      const certData = JSON.parse(identity.Certificate ?? identity.certificate ?? "{}");
      const chain: string[] = certData.chain ?? [];

      let displayName = "";
      let xuid = "";
      let identityPublicKey = "";

      for (const jwt of chain) {
         try {
            const payload = JSON.parse(
               Buffer.from(jwt.split(".")[1]!, "base64").toString(),
            );
            if (payload?.extraData?.displayName) {
               displayName = payload.extraData.displayName;
               xuid = payload.extraData.XUID ?? "";
            }
            if (payload?.identityPublicKey) {
               identityPublicKey = payload.identityPublicKey;
            }
         } catch { }
      }

      // New client versions use Token instead of Certificate chain.
      // The Token JWT payload contains cpk (client public key), xname, and xid.
      if (!identityPublicKey) {
         const token = identity.Token ?? identity.token;
         if (token) {
            try {
               const payload = JSON.parse(
                  Buffer.from(token.split(".")[1]!, "base64").toString(),
               );
               if (payload?.cpk) identityPublicKey = payload.cpk;
               if (payload?.xname && !displayName) displayName = payload.xname;
               if (payload?.xid && !xuid) xuid = payload.xid;
            } catch { }
         }
      }

      this.username = displayName;
      this.xuid = xuid;

      if (!identityPublicKey) {
         Logger.error("No identity public key found in login chain");
         return;
      }

      const pubKeyDer = createPublicKey({
         key: Buffer.from(identityPublicKey, "base64"),
         format: "der",
         type: "spki",
      });

      const { LoginData } = await import("../client/types/login/login-data");
      this.sharedSecret = LoginData.createSharedSecret(this.privateKey, pubKeyDer);

      const secretHash = createHash("sha256")
         .update(SALT_BUFFER)
         .update(this.sharedSecret);
      const secretKeyBytes = secretHash.digest();
      const iv = secretKeyBytes.subarray(0, 16);

      const privateKey = await jose.importPKCS8(
         this.privateKey.export({ format: "pem", type: "pkcs8" }) as string,
         ALGORITHM,
      );

      const token = await new jose.SignJWT({
         salt: SALT_BUFFER.toString("base64"),
         signedToken: this.clientX509,
      })
         .setProtectedHeader({ alg: ALGORITHM, x5u: this.clientX509 })
         .sign(privateKey);

      const handshake = new ServerToClientHandshakePacket();
      handshake.token = token;
      this.send(handshake.serialize());

      this.enableEncryption(secretKeyBytes, iv);
      this.emit("login");
   }

   enableEncryption(secretKeyBytes: Buffer, iv: Buffer): void {
      this.packetEncryptor = new PacketEncryptor(secretKeyBytes, iv);
      this.packetCompressor.setEncryptor(this.packetEncryptor);
   }

   public onEncapsulated(buffer: Buffer): void {
      try {
         const decompressed = this.packetCompressor.decompress(buffer);
         for (const packet of decompressed) {
            this.handlePacket(packet);
         }
      } catch (err) {
         Logger.error("Failed to decompress packet", err);
         if (err instanceof Error && err.message.includes("Checksum mismatch")) {
            this.disconnect("Encryption checksum mismatch: Connection corrupted");
         }
      }
   }

   public handlePacket(buffer: Buffer): void {
      if (buffer.length < 1) return;

      const id = getPacketId(buffer);
      const PacketClass = Packets[id];

      if (!PacketClass) {
         Logger.debug(`Unknown packet: ${id}`);
         return;
      }

      try {
         const instance = new PacketClass(buffer).deserialize();

         if (this.listenerCount("packet") > 0) {
            this.emit("packet", instance);
         }

         this.emit(PacketClass.name as PacketNames, instance);
      } catch (err) {
         Logger.error(`Failed to deserialize ${PacketClass.name ?? id}`, err);
      }
   }

   public send(
      packet: Buffer | Buffer[],
      priority: Priority = Priority.High,
      compressionMethod?: CompressionMethod,
   ): void {
      if (this.isDisconnected) return;
      try {
         const compressed = this.packetCompressor.compress(packet, compressionMethod);
         this.connection.send(compressed, priority);
      } catch (err) {
         Logger.error("Failed to send packet", err);
      }
   }

   public queue(packet: Buffer | Buffer[]): void {
      this.send(packet, Priority.Medium);
   }

   public sendUncompressed(packet: Buffer, priority: Priority = Priority.High): void {
      const framed = Framer.frame(packet);
      const buf = Buffer.allocUnsafe(1 + framed.length);
      buf[0] = 0xfe;
      framed.copy(buf, 1);
      this.connection.send(buf, priority);
   }


   public disconnect(reason = "disconnected"): void {
      if (this.isDisconnected) return;
      this.isDisconnected = true;
      Logger.info(`Disconnecting ${this.username || "player"}: ${reason}`);
      this.connection.disconnect();
      this.emit("disconnect");
   }

}
