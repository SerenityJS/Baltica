const KNOWN_IDENTITY_KEYS = new Set([
   "certificateAuthority",
   "cpk",
   "exp",
   "extraData",
   "iat",
   "identityPublicKey",
   "iss",
   "mid",
   "nbf",
   "pfcd",
   "randomNonce",
   "tid",
   "xid",
   "xname",
]);

const KNOWN_IDENTITY_EXTRA_DATA_KEYS = new Set([
   "XUID",
   "displayName",
   "identity",
   "sandboxId",
   "titleId",
]);

const KNOWN_CLIENT_DATA_KEYS = new Set([
   "AnimatedImageData",
   "ArmSize",
   "CapeData",
   "CapeId",
   "CapeImageHeight",
   "CapeImageWidth",
   "CapeOnClassicSkin",
   "ClientRandomId",
   "CompatibleWithClientSideChunkGen",
   "CurrentInputMode",
   "DefaultInputMode",
   "DeviceId",
   "DeviceModel",
   "DeviceOS",
   "GameVersion",
   "GraphicsMode",
   "GuiScale",
   "IsEditorMode",
   "LanguageCode",
   "MaxViewDistance",
   "MemoryTier",
   "OverrideSkin",
   "PartyId",
   "PersonaPieces",
   "PersonaSkin",
   "PieceTintColors",
   "PlatformOfflineId",
   "PlatformOnlineId",
   "PlatformType",
   "PlayFabId",
   "PlayformType",
   "PremiumSkin",
   "SelfSignedId",
   "ServerAddress",
   "SkinAnimationData",
   "SkinColor",
   "SkinData",
   "SkinGeometryData",
   "SkinGeometryDataEngineVersion",
   "SkinId",
   "SkinImageHeight",
   "SkinImageWidth",
   "SkinResourcePatch",
   "ThirdPartyName",
   "ThirdPartyNameOnly",
   "TrustedSkin",
   "UIProfile",
   "pfcd",
]);

const KNOWN_TOKEN_KEYS = new Set([
   "aud",
   "cpk",
   "exp",
   "iat",
   "ipt",
   "iss",
   "leguuid",
   "mid",
   "nbf",
   "nid",
   "nname",
   "pfcd",
   "pid",
   "pname",
   "sub",
   "tid",
   "xid",
   "xname",
]);

export type LoginPayloadObject = Record<string, unknown>;

export function decodeJwtPayload(jwt: string): LoginPayloadObject | null {
   const payload = jwt.split(".")[1];
   if (!payload) return null;

   try {
      return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as LoginPayloadObject;
   } catch {
      try {
         return JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as LoginPayloadObject;
      } catch {
         return null;
      }
   }
}

function unknownKeys(
   payload: LoginPayloadObject,
   knownKeys: ReadonlySet<string>,
): string[] {
   return Object.keys(payload)
      .filter((key) => !knownKeys.has(key))
      .sort();
}

export function summarizeUnknownIdentityPayloadFields(payload: LoginPayloadObject): string[] {
   const unknown = unknownKeys(payload, KNOWN_IDENTITY_KEYS);
   const extraData = payload.extraData;

   if (extraData && typeof extraData === "object" && !Array.isArray(extraData)) {
      const nestedUnknown = unknownKeys(
         extraData as LoginPayloadObject,
         KNOWN_IDENTITY_EXTRA_DATA_KEYS,
      ).map((key) => `extraData.${key}`);
      unknown.push(...nestedUnknown);
   }

   return unknown.sort();
}

export function summarizeUnknownClientPayloadFields(payload: LoginPayloadObject): string[] {
   return unknownKeys(payload, KNOWN_CLIENT_DATA_KEYS);
}

export function summarizeUnknownTokenPayloadFields(payload: LoginPayloadObject): string[] {
   return unknownKeys(payload, KNOWN_TOKEN_KEYS);
}

export function summarizeClientPayloadForLog(
   payload: LoginPayloadObject,
): LoginPayloadObject {
   const summary: LoginPayloadObject = {};

   const copyIfPresent = (key: string): void => {
      if (payload[key] !== undefined) {
         summary[key] = payload[key];
      }
   };

   copyIfPresent("DeviceId");
   copyIfPresent("DeviceOS");
   copyIfPresent("DeviceModel");
   copyIfPresent("GameVersion");
   copyIfPresent("SkinId");
   copyIfPresent("PartyId");
   copyIfPresent("PlayFabId");
   copyIfPresent("PlatformOnlineId");
   copyIfPresent("SelfSignedId");

   if (typeof payload.SkinData === "string") {
      summary.SkinDataLength = payload.SkinData.length;
   }

   if (Array.isArray(payload.PersonaPieces)) {
      summary.PersonaPiecesCount = payload.PersonaPieces.length;
   }

   return summary;
}
