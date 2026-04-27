import { Emitter } from "@baltica/utils";
import type { AuthEvents, AuthOptions, AuthResult, AuthFlow, CachedKeyPair, MicrosoftTokens, TokenCache, UserProfile } from "./types";
import { defaultAuthOptions } from "./types";
import { requestDeviceCode, pollDeviceCode, refreshMicrosoftToken, authenticateWithPassword } from "./microsoft";
import { authenticateXbl, authenticateXsts } from "./xbox";
import { loginWithPlayFab } from "./playfab";
import { getBedrockChain, getMinecraftServicesToken, getMultiplayerSessionToken } from "./session";
import { AuthCache, isTokenValid, type ICacheProvider } from "./cache";
import { generateKeyPair } from "./keypair";

export class Auth extends Emitter<AuthEvents> {
   public options: AuthOptions;
   private cache: ICacheProvider;

   constructor(options: Partial<AuthOptions> = {}) {
      super();
      this.options = { ...defaultAuthOptions, ...options };

      // Auto-derive cache username from email when using password flow
      if (this.options.flow === "password" && this.options.email && !options.username) {
         this.options.username = this.options.email.split("@")[0]!;
      }

      this.cache = this.options.cacheProvider ?? new AuthCache(this.options.cacheDir, this.options.username);
   }

   public async login(): Promise<AuthResult> {
      if (!this.options.clientId) {
         throw new Error(
            "Missing clientId. Register an Azure app at https://portal.azure.com and pass the Application (client) ID.",
         );
      }

      const flow = this.options.flow ?? (this.options.deviceCode !== false ? "deviceCode" : "deviceCode");

      if (flow === "password") {
         if (!this.options.email || !this.options.password) {
            throw new Error(
               'Missing email or password. Both are required when using the "password" auth flow.',
            );
         }
      }

      if (flow === "xboxToken") {
         if (!this.options.xboxToken) {
            throw new Error(
               'Missing xboxToken. Provide the full "XBL3.0 x={userHash};{token}" string when using the "xboxToken" auth flow.',
            );
         }
         return this.loginWithXboxToken(this.options.xboxToken);
      }

      try {
         const cached = await this.cache.load();
         const keypair = cached.keypair ?? generateKeyPair();

         const cachedResult = await this.tryUseCached(cached, keypair);
         if (cachedResult) {
            this.emit("login", cachedResult);
            return cachedResult;
         }

         let msTokens: MicrosoftTokens;
         if (cached.microsoft?.refreshToken) {
            try {
               msTokens = await refreshMicrosoftToken(
                  this.options.clientId,
                  cached.microsoft.refreshToken,
               );
            } catch {
               msTokens = await this.obtainMicrosoftTokens(flow);
            }
         } else {
            msTokens = await this.obtainMicrosoftTokens(flow);
         }

         const result = await this.authenticateChain(msTokens, keypair);

         await this.cache.save({
            microsoft: msTokens,
            xbl: result.xbl,
            xsts: result.xsts,
            playFab: result.playFab,
            mcServices: result.mcServices,
            keypair,
         });

         this.emit("login", result);
         return result;
      } catch (error) {
         const err = error instanceof Error ? error : new Error(String(error));
         this.emit("error", err);
         throw err;
      }
   }

   public async logout(): Promise<void> {
      const cached = await this.cache.load();
      await this.cache.save({
         microsoft: cached.microsoft,
         keypair: cached.keypair,
      });
      this.emit("logout");
   }

   private async tryUseCached(cached: TokenCache, keypair: CachedKeyPair): Promise<AuthResult | null> {
      if (
         cached.xbl && isTokenValid(cached.xbl.expiresAt) &&
         cached.xsts && isTokenValid(cached.xsts.expiresAt) &&
         cached.playFab && isTokenValid(cached.playFab.expiresAt) &&
         cached.mcServices && isTokenValid(cached.mcServices.expiresAt)
      ) {
         const clientPublicKey = this.options.clientPublicKey ?? keypair.publicKey;
         const bedrock = await getBedrockChain(cached.xsts.token, cached.xsts.userHash, clientPublicKey);
         let multiplayerSession = { signedToken: "", expiresAt: 0 };
         if (clientPublicKey) {
            multiplayerSession = await getMultiplayerSessionToken(
               cached.mcServices.authorizationHeader,
               clientPublicKey,
            );
         }
         const profile = extractProfileFromChains(bedrock.chain);
         return {
            profile,
            xbl: cached.xbl,
            xsts: cached.xsts,
            playFab: cached.playFab,
            mcServices: cached.mcServices,
            multiplayerSession,
            bedrockChain: bedrock.chain,
            keypair,
         };
      }
      return null;
   }

   private async doDeviceCodeFlow(): Promise<MicrosoftTokens> {
      const deviceCode = await requestDeviceCode(this.options.clientId);
      this.emit("deviceCode", deviceCode);
      return pollDeviceCode(
         this.options.clientId,
         deviceCode.deviceCode,
         deviceCode.interval,
         deviceCode.expiresIn,
      );
   }

   private async obtainMicrosoftTokens(flow: AuthFlow): Promise<MicrosoftTokens> {
      if (flow === "password") {
         return authenticateWithPassword(
            this.options.clientId,
            this.options.email!,
            this.options.password!,
         );
      }
      return this.doDeviceCodeFlow();
   }

   private async loginWithXboxToken(xboxToken: string): Promise<AuthResult> {
      try {
         // Parse "XBL3.0 x={userHash};{token}"
         const match = xboxToken.match(/^XBL3\.0\s+x=([^;]+);(.+)$/);
         if (!match) {
            throw new Error('Invalid xboxToken format. Expected "XBL3.0 x={userHash};{token}"');
         }
         const userHash = match[1]!;
         const token = match[2]!;

         const keypair = (await this.cache.load()).keypair ?? generateKeyPair();
         const clientPublicKey = this.options.clientPublicKey ?? keypair.publicKey;

         const xsts = { token, userHash, gamertag: "", xuid: "", expiresAt: Date.now() + 24 * 60 * 60 * 1000 };

         const xbl = { token, userHash, expiresAt: xsts.expiresAt };

         const bedrock = await getBedrockChain(xsts.token, xsts.userHash, clientPublicKey);

         // Extract gamertag/xuid from bedrock chain JWTs
         const profile = extractProfileFromChains(bedrock.chain);
         xsts.gamertag = profile.username;
         xsts.xuid = profile.xuid;

         const playFab = { sessionTicket: "", entityToken: "", expiresAt: 0 };
         const mcServices = { authorizationHeader: "", expiresAt: 0 };
         let multiplayerSession = { signedToken: "", expiresAt: 0 };

         const result: AuthResult = { profile, xbl, xsts, playFab, mcServices, multiplayerSession, bedrockChain: bedrock.chain, keypair };

         await this.cache.save({
            xbl: result.xbl,
            xsts: result.xsts,
            playFab: result.playFab,
            mcServices: result.mcServices,
            keypair,
         });

         this.emit("login", result);
         return result;
      } catch (error) {
         const err = error instanceof Error ? error : new Error(String(error));
         this.emit("error", err);
         throw err;
      }
   }

   private async authenticateChain(
      msTokens: MicrosoftTokens,
      keypair: CachedKeyPair,
   ): Promise<AuthResult> {
      const xbl = await authenticateXbl(msTokens.accessToken);
      const xsts = await authenticateXsts(xbl.token);

      const { Endpoint } = await import("./constants");
      const xstsPlayFab = await authenticateXsts(xbl.token, Endpoint.PlayFabRelyingParty);

      // Grab gamertag/xuid from whichever XSTS response has them
      if (!xsts.gamertag && xstsPlayFab.gamertag) xsts.gamertag = xstsPlayFab.gamertag;
      if (!xsts.xuid && xstsPlayFab.xuid) xsts.xuid = xstsPlayFab.xuid;

      // If still missing, try to extract from the JWT payload
      if (!xsts.gamertag || !xsts.xuid) {
         try {
            const payload = JSON.parse(
               Buffer.from(xsts.token.split(".")[1]!, "base64").toString(),
            ) as { extraData?: { displayName?: string; XUID?: string } };
            if (!xsts.gamertag && payload.extraData?.displayName) {
               xsts.gamertag = payload.extraData.displayName;
            }
            if (!xsts.xuid && payload.extraData?.XUID) {
               xsts.xuid = payload.extraData.XUID;
            }
         } catch { /* not a JWT or no extraData */ }
      }

      const playFab = await loginWithPlayFab(xstsPlayFab);
      const mcServices = await getMinecraftServicesToken(playFab.sessionTicket);

      const clientPublicKey = this.options.clientPublicKey ?? keypair.publicKey;

      const bedrock = await getBedrockChain(xsts.token, xsts.userHash, clientPublicKey);

      // Extract gamertag/xuid from bedrock chain JWTs if still missing
      const chainProfile = extractProfileFromChains(bedrock.chain);
      if (!xsts.gamertag && chainProfile.username) xsts.gamertag = chainProfile.username;
      if (!xsts.xuid && chainProfile.xuid) xsts.xuid = chainProfile.xuid;

      // Build the user profile
      const profile: UserProfile = {
         username: xsts.gamertag || chainProfile.username,
         xuid: xsts.xuid || chainProfile.xuid,
         uuid: chainProfile.uuid,
      };

      let multiplayerSession = { signedToken: "", expiresAt: 0 };
      if (clientPublicKey) {
         multiplayerSession = await getMultiplayerSessionToken(
            mcServices.authorizationHeader,
            clientPublicKey,
         );
      }

      return { profile, xbl, xsts, playFab, mcServices, multiplayerSession, bedrockChain: bedrock.chain, keypair };
   }
}

function extractProfileFromChains(chains: string[]): UserProfile {
   for (const chain of chains) {
      try {
         const payload = JSON.parse(
            Buffer.from(chain.split(".")[1]!, "base64").toString(),
         ) as { extraData?: { displayName?: string; XUID?: string; identity?: string } };
         if (payload.extraData?.displayName) {
            return {
               username: payload.extraData.displayName,
               xuid: payload.extraData.XUID ?? "",
               uuid: payload.extraData.identity ?? "",
            };
         }
      } catch { /* skip */ }
   }
   return { username: "", xuid: "", uuid: "" };
}
