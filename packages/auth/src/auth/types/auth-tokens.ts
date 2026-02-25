export interface MicrosoftTokens {
   accessToken: string;
   refreshToken: string;
   expiresAt: number;
}

export interface XblToken {
   token: string;
   userHash: string;
   expiresAt: number;
}

export interface XstsToken {
   token: string;
   userHash: string;
   gamertag: string;
   xuid: string;
   expiresAt: number;
}

export interface PlayFabToken {
   sessionTicket: string;
   entityToken: string;
   expiresAt: number;
}

export interface McServicesToken {
   authorizationHeader: string;
   expiresAt: number;
}

export interface CachedKeyPair {
   privateKey: string;
   publicKey: string;
}

export interface TokenCache {
   microsoft?: MicrosoftTokens;
   xbl?: XblToken;
   xsts?: XstsToken;
   playFab?: PlayFabToken;
   mcServices?: McServicesToken;
   keypair?: CachedKeyPair;
}

export interface DeviceCodeResponse {
   deviceCode: string;
   userCode: string;
   verificationUri: string;
   expiresIn: number;
   interval: number;
}

export interface MultiplayerSessionToken {
   signedToken: string;
   expiresAt: number;
}

export interface UserProfile {
   xuid: string;
   uuid: string;
   username: string;
}

export interface AuthResult {
   profile: UserProfile;
   xbl: XblToken;
   xsts: XstsToken;
   playFab: PlayFabToken;
   mcServices: McServicesToken;
   multiplayerSession: MultiplayerSessionToken;
   bedrockChain: string[];
   keypair: CachedKeyPair;
}
