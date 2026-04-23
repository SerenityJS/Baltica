import {
   createECDH,
   createHash,
   generateKeyPairSync,
   type KeyObject,
   KeyObject as KeyObjectClass,
   randomUUID,
} from "node:crypto";
import { DeviceOS, LoginPacket, LoginTokens } from "@serenityjs/protocol";
import * as jose from "jose";
import type {
   AnimatedImageData,
   PersonaPieces,
   PieceTintColors,
} from "../../skin/Skin.d";
import * as skin from "../../skin/Skin.json";
import { CurrentVersionConst, ProtocolList } from "../../../shared/types";
import type { ClientOptions, PlayerProfile } from "../client-options";

const CURVE = "secp384r1";
const ALGORITHM = "ES384";
const UUID_NAMESPACE = randomUUID();

const PUBLIC_KEY =
   "MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAECRXueJeTDqNRRgJi/vlRufByu/2G0i2Ebt6YMar5QX/R0DIIyrJMcUpruK4QveTfJSTp3Shlq4Gk34cD/4GUWwkv0DVuzeuB+tXija7HBxii03NHDbPAD0AKnLr2wdAp";

export interface SkinData {
   AnimatedImageData: AnimatedImageData[];
   ArmSize: string;
   CapeData: string;
   CapeId: string;
   CapeImageHeight: number;
   CapeImageWidth: number;
   CapeOnClassicSkin: boolean;
   PieceTintColors: PieceTintColors[];
   PersonaPieces: PersonaPieces[];
   PersonaSkin: boolean;
   PremiumSkin: boolean;
   SkinAnimationData: string;
   SkinColor: string;
   SkinData: string;
   SkinGeometryData: string;
   SkinGeometryDataEngineVersion: string;
   SkinId: string;
   SkinImageHeight: number;
   SkinImageWidth: number;
   SkinResourcePatch: string;
   TrustedSkin: boolean;
}

export interface Payload extends SkinData {
   ClientRandomId: number;
   CompatibleWithClientSideChunkGen: boolean;
   CurrentInputMode: number;
   DefaultInputMode: number;
   DeviceId: string;
   DeviceModel: string;
   DeviceOS: number;
   GameVersion: string;
   GuiScale: number;
   IsEditorMode: boolean;
   LanguageCode: string;
   MaxViewDistance: number;
   MemoryTier: number;
   OverrideSkin: boolean;
   PlatformOfflineId: string;
   PlatformOnlineId: string;
   PlatformType: number;
   PlayFabId: string;
   pfcd?: string;
   SelfSignedId: string;
   ServerAddress: string;
   ThirdPartyName: string;
   UIProfile: number;
   GraphicsMode: number;
}

export const defaultSkinData: SkinData = {
   AnimatedImageData: skin.skinData.AnimatedImageData as AnimatedImageData[],
   ArmSize: skin.skinData.ArmSize,
   CapeData: skin.skinData.CapeData,
   CapeId: skin.skinData.CapeId,
   CapeImageHeight: skin.skinData.CapeImageHeight,
   CapeImageWidth: skin.skinData.CapeImageWidth,
   CapeOnClassicSkin: skin.skinData.CapeOnClassicSkin,
   PersonaPieces: skin.skinData.PersonaPieces,
   PersonaSkin: skin.skinData.PersonaSkin,
   PieceTintColors: skin.skinData.PieceTintColors,
   PremiumSkin: skin.skinData.PremiumSkin,
   SkinAnimationData: skin.skinData.SkinAnimationData,
   SkinColor: skin.skinData.SkinColor,
   SkinData: skin.skinData.SkinData,
   SkinGeometryData: skin.skinData.SkinGeometryData,
   SkinGeometryDataEngineVersion: skin.skinData.SkinGeometryDataEngineVersion,
   SkinId: skin.skinData.SkinId,
   SkinImageHeight: skin.skinData.SkinImageHeight,
   SkinImageWidth: skin.skinData.SkinImageWidth,
   SkinResourcePatch: skin.skinData.SkinResourcePatch,
   TrustedSkin: skin.skinData.TrustedSkin,
};

export function createDefaultPayload(options: ClientOptions, profile: PlayerProfile): Payload {
   const username = profile.name ?? options.username;
   return {
      ...defaultSkinData,
      ClientRandomId: LoginData.generateRandomId(),
      CompatibleWithClientSideChunkGen: false,
      CurrentInputMode: options.loginOptions.currentInputMode,
      DefaultInputMode: options.loginOptions.defaultInputMode,
      DeviceId: LoginData.nextUUID(username),
      DeviceModel: options.loginOptions.deviceModel,
      DeviceOS: options.loginOptions.deviceOS ?? DeviceOS.Win10,
      GameVersion: CurrentVersionConst,
      GuiScale: 0,
      IsEditorMode: false,
      LanguageCode: "en_US",
      MaxViewDistance: options.viewDistance,
      MemoryTier: options.loginOptions.memoryTier,
      OverrideSkin: false,
      PlatformOfflineId:
         options.offline ? "" : LoginData.nextUUID(username).replace(/-/g, ""),
      PlatformOnlineId:
         options.offline ? "" : LoginData.generateOnlineId(),
      PlatformType: options.loginOptions.platformType,
      PlayFabId: LoginData.nextUUID(username).replace(/-/g, "").slice(0, 16).toLowerCase(),
      SelfSignedId: LoginData.nextUUID(username),
      ServerAddress: `${options.address}:${options.port}`,
      ThirdPartyName: username,
      UIProfile: options.loginOptions.uiProfile,
      GraphicsMode: options.loginOptions.graphicsMode,
   };
}

export class LoginData {
   iv!: Buffer;
   secretKeyBytes!: Buffer;
   sharedSecret!: Buffer;

   publicKey!: KeyObject;
   privateKey!: KeyObject;
   publicKeyDER!: Buffer;
   privateKeyPEM!: string;
   clientX509!: string;

   clientIdentityChain!: string;
   clientUserChain!: string;

   sessionTokenData?: {
      ipt: string;
      tid: string;
      mid: string;
      xid: string;
      cpk: string;
   };

   accessToken: string[] = [];
   loginToken = "";
   legacy = true;
   payload!: Payload;

   static prepare(options: ClientOptions, profile: PlayerProfile): LoginData {
      const data = new LoginData();
      const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: CURVE });

      data.publicKey = publicKey;
      data.privateKey = privateKey;
      data.publicKeyDER = publicKey.export({ format: "der", type: "spki" });
      data.privateKeyPEM = Buffer.from(
         privateKey.export({ format: "pem", type: "sec1" }),
      ).toString("base64");
      data.clientX509 = data.publicKeyDER.toString("base64");
      data.clientIdentityChain = "";
      data.clientUserChain = "";
      data.payload = createDefaultPayload(options, profile);

      if (options.skinData) {
         Object.assign(data.payload, options.skinData);
      }

      return data;
   }

   createLoginPacket(options: ClientOptions): LoginPacket {
      const loginPacket = new LoginPacket();
      const chain = [this.clientIdentityChain, ...this.accessToken].filter(
         (value): value is string => typeof value === "string" && value.length > 0,
      );
      const certificate = JSON.stringify({ chain });

      const identityObj: Record<string, unknown> = {
         AuthenticationType: options.offline ? 2 : 0,
         Certificate: certificate,
      };

      if (this.loginToken) {
         identityObj.Token = this.loginToken;
      }

      loginPacket.protocol = ProtocolList[CurrentVersionConst];
      loginPacket.tokens = new LoginTokens(this.clientUserChain, JSON.stringify(identityObj));
      return loginPacket;
   }

   async createOfflineToken(profile: PlayerProfile): Promise<string> {
      const josePrivateKey = await jose.importPKCS8(
         this.privateKey.export({ format: "pem", type: "pkcs8" }) as string,
         ALGORITHM,
      );

      const payload = {
         aud: "api://auth-minecraft-services/multiplayer",
         cpk: this.clientX509,
         exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365,
         leguuid: profile.uuid,
         mid: LoginData.nextUUID(profile.name).replace(/-/g, "").slice(0, 16).toUpperCase(),
         nid: "",
         nname: "",
         pid: "",
         pname: "",
         xid: profile.xuid || "",
         xname: profile.name,
      };

      return new jose.SignJWT(payload)
         .setProtectedHeader({ alg: ALGORITHM as "ES384", x5u: this.clientX509 })
         .sign(josePrivateKey);
   }

   async createClientChain(
      profile: PlayerProfile,
      mojangKey: string | null,
      offline: boolean,
   ): Promise<string> {
      let payload: Record<string, unknown>;
      let header: jose.JWTHeaderParameters;

      if (offline) {
         payload = {
            nbf: Math.floor(Date.now() / 1000),
            randomNonce: Math.floor(Math.random() * 100000),
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 3600,
            extraData: {
               displayName: profile.name,
               identity: profile.uuid,
               titleId: "89692877",
               sandboxId: "",
               XUID: "",
            },
            certificateAuthority: true,
            identityPublicKey: this.clientX509,
         };
         header = { alg: ALGORITHM as "ES384", x5u: this.clientX509 };
      } else {
         payload = {
            identityPublicKey: mojangKey || PUBLIC_KEY,
            certificateAuthority: true,
         };

         if (this.sessionTokenData) {
            payload.ipt = this.sessionTokenData.ipt;
            payload.tid = this.sessionTokenData.tid;
            payload.mid = this.sessionTokenData.mid;
            payload.xid = this.sessionTokenData.xid;
            payload.cpk = this.sessionTokenData.cpk;
            payload.xname = profile.name;
         }

         if (this.payload.pfcd) {
            payload.pfcd = this.payload.pfcd;
         }

         header = { alg: ALGORITHM as "ES384", x5u: this.clientX509 };
      }

      const privateKey = await jose.importPKCS8(
         this.privateKey.export({ format: "pem", type: "pkcs8" }) as string,
         ALGORITHM,
      );

      return new jose.SignJWT(payload)
         .setProtectedHeader(header)
         .sign(privateKey);
   }

   async createClientUserChain(
      privateKey: KeyObject,
      profile: PlayerProfile,
      options: ClientOptions,
   ): Promise<string> {
      const customPayload = { ...options.skinData };
      const payload: Payload = {
         ...this.payload,
         ...customPayload,
         ServerAddress: `${options.address}:${options.port}`,
         ClientRandomId: Date.now(),
         DeviceId: LoginData.nextUUID(profile.name),
         PlayFabId: LoginData.nextUUID(profile.name).replace(/-/g, "").slice(0, 16),
         SelfSignedId: LoginData.nextUUID(profile.name),
      };

      const josePrivateKey = await jose.importPKCS8(
         privateKey.export({ format: "pem", type: "pkcs8" }) as string,
         ALGORITHM,
      );

      return new jose.SignJWT(payload as unknown as jose.JWTPayload)
         .setProtectedHeader({ alg: ALGORITHM as "ES384", x5u: this.clientX509 })
         .sign(josePrivateKey);
   }

   static createSharedSecret(privateKey: KeyObject, publicKey: KeyObject): Buffer {
      LoginData.validateKeys(privateKey, publicKey);

      const curve = privateKey.asymmetricKeyDetails?.namedCurve;
      if (!curve) throw new Error("Invalid private key format. Named curve is missing.");

      const ecdh = createECDH(curve);
      const privateKeyJwk = privateKey.export({ format: "jwk" }) as { d?: string };
      const publicKeyJwk = publicKey.export({ format: "jwk" }) as { x?: string; y?: string };

      if (!privateKeyJwk.d || !publicKeyJwk.x || !publicKeyJwk.y) {
         throw new Error("Invalid key format. Missing 'd', 'x', or 'y' parameters.");
      }

      ecdh.setPrivateKey(new Uint8Array(Buffer.from(privateKeyJwk.d, "base64")));

      const publicKeyBuffer = Buffer.concat([
         new Uint8Array([0x04]),
         new Uint8Array(Buffer.from(publicKeyJwk.x, "base64")),
         new Uint8Array(Buffer.from(publicKeyJwk.y, "base64")),
      ]);

      const computedSecret = ecdh.computeSecret(new Uint8Array(publicKeyBuffer));
      return Buffer.from(new Uint8Array(computedSecret));
   }

   static validateKeys(privateKey: KeyObject, publicKey: KeyObject): void {
      if (!(privateKey instanceof KeyObjectClass) || !(publicKey instanceof KeyObjectClass)) {
         throw new Error("Both privateKey and publicKey must be crypto.KeyObject instances");
      }
      if (privateKey.type !== "private" || publicKey.type !== "public") {
         throw new Error("Invalid key types. Expected private and public keys.");
      }
   }

   static nextUUID(username: string): string {
      if (!username) throw new Error("nextUUID requires a non-empty username");
      const hash = createHash("md5")
         .update(UUID_NAMESPACE)
         .update(username)
         .digest("hex");
      return [
         hash.slice(0, 8),
         hash.slice(8, 12),
         `3${hash.slice(13, 16)}`,
         ((parseInt(hash[16]!, 16) & 0x3) | 0x8).toString(16) + hash.slice(17, 20),
         hash.slice(20, 32),
      ].join("-");
   }

   static generateRandomId(): number {
      const n = Math.floor(Math.random() * 9_000_000_000_000_000) + 1_000_000_000_000_000;
      return -n;
   }

   static generateOnlineId(): string {
      const n = Math.floor(Math.random() * 9_000_000_000_000_000) + 1_000_000_000_000_000;
      return `${n}`;
   }
}
