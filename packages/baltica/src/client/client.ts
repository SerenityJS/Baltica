import { Priority, Client as Raknet } from "@baltica/raknet";
import { Emitter } from "@baltica/utils";
import { ClientEvents, ClientOptions, defaultClientOptions, LoginData, PlayerProfile, createDefaultPayload } from "./types";
import { Auth, AuthResult } from "@baltica/auth";
import { Logger } from "@baltica/utils";
import { PacketEncryptor } from "../shared/serializer/packet-encryptor";
import { PacketCompressor } from "../shared/serializer/packet-compressor";
import {
   ClientCacheStatusPacket, ClientToServerHandshakePacket, CompressionMethod,
   Framer, getPacketId, NetworkSettingsPacket, Packet, Packets, PlayStatus, PlayStatusPacket,
   RequestChunkRadiusPacket, RequestedResourcePack, RequestNetworkSettingsPacket,
   ResourcePackClientResponsePacket, ResourcePackResponse, ResourcePacksInfoPacket,
   ResourcePackStackPacket, ServerboundLoadingScreenPacketPacket,
   ServerboundLoadingScreenType, ServerToClientHandshakePacket,
   SetLocalPlayerAsInitializedPacket, StartGamePacket,
} from "@serenityjs/protocol";
import { CurrentVersionConst, PacketNames, ProtocolList } from "../shared";
import { createHash, createPublicKey } from "node:crypto";

export class Client extends Emitter<ClientEvents> {
   public options: ClientOptions;
   public raknet: Raknet;
   public packetEncryptor: PacketEncryptor | null = null;
   public packetCompressor: PacketCompressor;
   public profile!: PlayerProfile;
   public loginData!: LoginData;
   public stopPastLogin: boolean = false;
   public startGameData!: StartGamePacket;

   constructor(options: Partial<ClientOptions>) {
      super();
      this.options = { ...defaultClientOptions, ...options } as ClientOptions;
      this.raknet = new Raknet(this.options);
      this.packetCompressor = new PacketCompressor();
   }

   public async connect(): Promise<void> {
      this.raknet.on("encapsulated", (buf) => this.onEncapsulated(buf));

      this.registerHandshakeHandlers();

      if (!this.stopPastLogin) {
         this.registerLoginSequenceHandlers();
      }

      this.registerDiagnosticHandlers();

      await this.authenticate();
      await this.raknet.connect();
      this.requestNetworkSettings();

      return new Promise((resolve, reject) => {
         this.on("SetLocalPlayerAsInitializedPacket", () => {
            resolve();
            this.emit("spawn");
            this.emit("connect");
         });

         this.on("disconnect", (reason) => {
            reject(new Error(`Disconnected during login: ${reason}`));
         });
      });
   }

   private registerHandshakeHandlers(): void {
      this.on("NetworkSettingsPacket", (settings) => this.onNetworkSettings(settings));
      this.once("ServerToClientHandshakePacket", (packet) => this.onServerHandshake(packet));
   }

   private onNetworkSettings(settings: NetworkSettingsPacket): void {
      this.options.compressionMethod = settings.compressionMethod;
      this.options.compressionThreshold = settings.compressionThreshold;
      this.packetCompressor.compressionMethod = settings.compressionMethod;
      this.packetCompressor.compressionThreshold = settings.compressionThreshold;

      const packet = this.loginData.createLoginPacket(this.options);
      this.send(packet.serialize());
   }

   private onServerHandshake(packet: ServerToClientHandshakePacket): void {
      const [header, payload] = packet.token
         .split(".")
         .map((k: string) => Buffer.from(k, "base64"));
      const { x5u } = JSON.parse(header.toString());
      const { salt } = JSON.parse(payload.toString());

      const pubKeyDer = createPublicKey({
         key: Buffer.from(x5u, "base64"),
         type: "spki",
         format: "der",
      });

      this.loginData.sharedSecret = LoginData.createSharedSecret(
         this.loginData.privateKey,
         pubKeyDer,
      );

      const secretHash = createHash("sha256")
         .update(new Uint8Array(Buffer.from(salt, "base64")))
         .update(new Uint8Array(this.loginData.sharedSecret))
         .digest();

      this.enableEncryption(secretHash, secretHash.subarray(0, 16));

      const handshake = new ClientToServerHandshakePacket();
      this.send(handshake.serialize());
   }

   enableEncryption(secretKeyBytes: Buffer, iv: Buffer): void {
      this.packetEncryptor = new PacketEncryptor(secretKeyBytes, iv);
      this.packetCompressor.setEncryptor(this.packetEncryptor);
   }

   private registerLoginSequenceHandlers(): void {
      this.once("ResourcePacksInfoPacket", (packet) => this.onResourcePacksInfo(packet));
      this.once("ResourcePackStackPacket", (packet) => this.onResourcePackStack(packet));
      this.once("StartGamePacket", (packet) => this.onStartGame(packet));
      this.on("PlayStatusPacket", (packet) => this.onPlayStatus(packet));
   }

   private onResourcePacksInfo(packet: ResourcePacksInfoPacket): void {
      const response = new ResourcePackClientResponsePacket();
      response.packs = packet.packs.map(
         (p) => new RequestedResourcePack(p.uuid, p.version),
      );
      response.response = ResourcePackResponse.HaveAllPacks;

      const cacheStatus = new ClientCacheStatusPacket();
      cacheStatus.enabled = false;
      this.send([response.serialize(), cacheStatus.serialize()]);
   }

   private onResourcePackStack(packet: ResourcePackStackPacket): void {
      const response = new ResourcePackClientResponsePacket();
      response.packs = packet.texturePacks.map(
         (p) => new RequestedResourcePack(p.uuid, p.version),
      );
      response.response = ResourcePackResponse.Completed;
      this.send(response.serialize());
   }

   private onStartGame(packet: StartGamePacket): void {
      this.startGameData = packet;
      const radius = new RequestChunkRadiusPacket();
      radius.radius = this.options.viewDistance;
      radius.maxRadius = this.options.viewDistance;
      this.send(radius.serialize());
   }

   private onPlayStatus(packet: PlayStatusPacket): void {
      if (packet.status !== PlayStatus.PlayerSpawn) return;

      const init = new SetLocalPlayerAsInitializedPacket();
      init.runtimeEntityId = this.startGameData.runtimeEntityId;

      const loadingScreen = new ServerboundLoadingScreenPacketPacket();
      loadingScreen.type = ServerboundLoadingScreenType.EndLoadingScreen;
      loadingScreen.hasScreenId = false;

      this.send([
         loadingScreen.serialize(),
         init.serialize(),
      ])
      this.emit("SetLocalPlayerAsInitializedPacket", init);
   }

   private registerDiagnosticHandlers(): void {
      this.on("PacketViolationWarningPacket" as PacketNames, (pkt: any) => {
         Logger.error("PacketViolation:", JSON.stringify(pkt, null, 2));
      });

      this.on("DisconnectPacket" as PacketNames, (pkt: any) => {
         const reason = pkt?.message?.message ?? pkt?.message ?? "Unknown reason";
         Logger.info(`Disconnected by server: ${reason}`);
         this.close();
         this.emit("disconnect", String(reason));
      });
   }

   public close(): void {
      try { this.raknet.close(); } catch { }
      this.removeAllListeners();
   }

   public disconnect(reason = "client disconnect"): void {
      try {
         const packet = new (Packets[Packet.Disconnect] as any)();
         this.send(packet.serialize());
      } catch { }
      this.raknet.disconnect();
      this.removeAllListeners();
      this.emit("disconnect", reason);
   }

   private async authenticate(): Promise<void> {
      if (this.options.offline) {
         return this.authenticateOffline();
      }
      return this.authenticateOnline();
   }

   private async authenticateOffline(): Promise<void> {
      const username = this.options.username;
      this.profile = {
         name: username,
         uuid: LoginData.nextUUID(username),
         xuid: "",
      };
      this.loginData = LoginData.prepare(this.options, this.profile);
      this.loginData.clientIdentityChain = await this.loginData.createClientChain(
         this.profile, null, true,
      );
      this.loginData.clientUserChain = await this.loginData.createClientUserChain(
         this.loginData.privateKey, this.profile, this.options,
      );
   }

   private authenticateOnline(): Promise<void> {
      const tempProfile: PlayerProfile = {
         name: this.options.username,
         uuid: LoginData.nextUUID(this.options.username),
         xuid: "",
      };
      this.loginData = LoginData.prepare(this.options, tempProfile);

      const { username, tokensFolder } = this.options;

      const flow = this.options.email && this.options.password
         ? "password" as const
         : this.options.xboxToken
            ? "xboxToken" as const
            : "deviceCode" as const;

      const auth = new Auth({
         flow,
         username: flow === "deviceCode" ? username : undefined,
         cacheDir: tokensFolder,
         clientPublicKey: this.loginData.clientX509,
         email: this.options.email,
         password: this.options.password,
         xboxToken: this.options.xboxToken,
      });

      return new Promise((resolve, reject) => {
         auth.on("deviceCode", (r) => {
            Logger.info(`Please login at ${r.verificationUri}?otc=${r.userCode}`);
         });

         auth.on("login", async (result) => {
            Logger.info(`Logged in as §a${result.profile.username}§r`);
            this.applyAuthResult(result);
            resolve();
         });

         auth.on("error", reject);
         auth.login();
      });
   }

   private async applyAuthResult(result: AuthResult): Promise<void> {
      const gamertag = result.profile.username || this.options.username;
      const xuid = result.profile.xuid || "";
      const uuid = result.profile.uuid || LoginData.nextUUID(gamertag);

      this.profile = { name: result.profile.username, uuid, xuid };
      this.loginData.payload = createDefaultPayload(this.options, this.profile);
      if (this.options.skinData) {
         Object.assign(this.loginData.payload, this.options.skinData);
      }
      this.loginData.loginToken = result.multiplayerSession.signedToken;
      this.loginData.accessToken = result.bedrockChain;
      this.loginData.clientIdentityChain = await this.loginData.createClientChain(
         this.profile, null, false,
      );
      this.loginData.clientUserChain = await this.loginData.createClientUserChain(
         this.loginData.privateKey, this.profile, this.options,
      );
   }

   private requestNetworkSettings(): void {
      const request = new RequestNetworkSettingsPacket();
      request.protocol = ProtocolList[CurrentVersionConst];
      this.sendUncompressed(request.serialize(), Priority.High);
   }

   public send(
      packet: Buffer | Buffer[],
      priority: Priority = Priority.Medium,
      compressionMethod?: CompressionMethod,
   ) {
      try {
         const compressed = this.packetCompressor.compress(packet, compressionMethod);
         this.raknet.sendReliable(compressed, priority);
      } catch (err) {
         Logger.error("Failed to compress packet", err);
      }
   }

   public onEncapsulated(packet: Buffer) {
      try {
         const decompressed = this.packetCompressor.decompress(packet);
         for (const packet of decompressed) {
            this.handlePacket(packet);
         }
      } catch (err) {
         Logger.error("Failed to decompress packet", err);
      }
   }

   public handlePacket(buffer: Buffer) {
      if (buffer.length < 1) return;

      const id = getPacketId(buffer);
      const PacketClass = Packets[id];

      if (!PacketClass) return;

      if (this.listenerCount(PacketClass.name as PacketNames) > 0) {
         const deserialized = new PacketClass(buffer).deserialize();
         this.emit(PacketClass.name as PacketNames, deserialized);
      }
   }

   public sendUncompressed(packet: Buffer, priority: Priority = Priority.Medium) {
      const framed = Framer.frame(packet);
      const buf = Buffer.allocUnsafe(1 + framed.length);
      buf[0] = 0xfe;
      framed.copy(buf, 1);
      this.raknet.sendReliable(buf, priority);
   }
}