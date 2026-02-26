import type { MicrosoftTokens, DeviceCodeResponse } from "./types";
import { Endpoint } from "./constants";

export async function requestDeviceCode(clientId: string): Promise<DeviceCodeResponse> {
   const response = await fetch(Endpoint.LiveDeviceCode, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
         client_id: clientId,
         scope: "service::user.auth.xboxlive.com::MBI_SSL",
         response_type: "device_code",
      }),
   });

   if (!response.ok) {
      const text = await response.text();
      throw new Error(`Device code request failed: ${response.status} - ${text}`);
   }

   const data = await response.json() as Record<string, unknown>;

   return {
      deviceCode: data.device_code as string,
      userCode: data.user_code as string,
      verificationUri: (data.verification_uri as string) ?? "https://www.microsoft.com/link",
      expiresIn: data.expires_in as number,
      interval: (data.interval as number) ?? 5,
   };
}

export async function pollDeviceCode(
   clientId: string,
   deviceCode: string,
   interval: number,
   expiresIn: number,
): Promise<MicrosoftTokens> {
   const deadline = Date.now() + expiresIn * 1000;

   while (Date.now() < deadline) {
      await sleep(interval * 1000);

      const response = await fetch(Endpoint.LiveToken, {
         method: "POST",
         headers: { "Content-Type": "application/x-www-form-urlencoded" },
         body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            client_id: clientId,
            device_code: deviceCode,
         }),
      });

      const data = await response.json() as Record<string, unknown>;

      if (response.ok && data.access_token) {
         return {
            accessToken: data.access_token as string,
            refreshToken: data.refresh_token as string,
            expiresAt: Date.now() + (data.expires_in as number) * 1000,
         };
      }

      const error = data.error as string;
      if (error === "authorization_pending") continue;
      if (error === "slow_down") {
         interval += 5;
         continue;
      }

      throw new Error(`Device code poll failed: ${error} - ${data.error_description}`);
   }

   throw new Error("Device code flow timed out");
}

export async function refreshMicrosoftToken(
   clientId: string,
   refreshToken: string,
): Promise<MicrosoftTokens> {
   const response = await fetch(Endpoint.LiveToken, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
         grant_type: "refresh_token",
         client_id: clientId,
         refresh_token: refreshToken,
         scope: "service::user.auth.xboxlive.com::MBI_SSL",
      }),
   });

   if (!response.ok) {
      const text = await response.text();
      throw new Error(`Token refresh failed: ${response.status} - ${text}`);
   }

   const data = await response.json() as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
   };

   return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
   };
}

export async function authenticateWithPassword(
   clientId: string,
   email: string,
   password: string,
): Promise<MicrosoftTokens> {
   const authorizeUrl =
      `https://login.live.com/oauth20_authorize.srf?client_id=${clientId}` +
      `&redirect_uri=https://login.live.com/oauth20_desktop.srf` +
      `&scope=service::user.auth.xboxlive.com::MBI_SSL` +
      `&display=touch&response_type=token&locale=en`;

   const pageResponse = await fetch(authorizeUrl);
   if (!pageResponse.ok) {
      throw new Error(`Failed to load Microsoft login page: ${pageResponse.status}`);
   }
   const pageHtml = await pageResponse.text();

   const ppftMatch = pageHtml.match(/sFTTag":".*?value=\\"(.+?)\\"/)
      ?? pageHtml.match(/sFTTag':'.*?value="(.+?)"/);
   if (!ppftMatch) throw new Error("Could not extract PPFT token from login page");
   const ppft = ppftMatch[1]!;

   const urlPostMatch = pageHtml.match(/urlPost":"(.+?)"/)
      ?? pageHtml.match(/urlPost:\s*'(.+?)'/);
   if (!urlPostMatch) throw new Error("Could not extract post URL from login page");
   const urlPost = urlPostMatch[1]!.replace(/\\\//g, "/");

   const cookies = extractCookies(pageResponse);

   const loginResponse = await fetch(urlPost, {
      method: "POST",
      headers: {
         "Content-Type": "application/x-www-form-urlencoded",
         Cookie: cookies,
      },
      body: new URLSearchParams({
         login: email,
         loginfmt: email,
         passwd: password,
         PPFT: ppft,
      }),
      redirect: "manual",
   });

   let location = loginResponse.headers.get("location");
   let allCookies = mergeCookies(cookies, extractCookies(loginResponse));
   let lastRedirectBody = "";
   const maxRedirects = 10;

   for (let i = 0; i < maxRedirects && location; i++) {
      if (location.includes("access_token")) break;

      const redirectResponse = await fetch(location, {
         headers: { Cookie: allCookies },
         redirect: "manual",
      });
      allCookies = mergeCookies(allCookies, extractCookies(redirectResponse));

      const nextLocation = redirectResponse.headers.get("location");
      if (!nextLocation) {
         // No more redirects — capture the final page body for error detection
         lastRedirectBody = await redirectResponse.text().catch(() => "");
      }
      location = nextLocation ?? location;
   }

   if (!location || !location.includes("access_token")) {
      const body = lastRedirectBody || await loginResponse.text().catch(() => "");
      const lastUrl = location ?? "";

      // Identity confirmation / account protection (captcha, email code, phone, etc.)
      if (
         lastUrl.includes("identity/confirm") ||
         body.includes("identity/confirm") ||
         body.includes("Help us protect your account") ||
         body.includes("account.live.com/identity")
      ) {
         throw new Error(
            "Microsoft requires identity verification for this account. " +
            "Complete the verification at https://login.live.com in a browser, or use the device code flow instead.",
         );
      }

      // Two-factor / two-step verification
      if (
         lastUrl.includes("LiveTwoStepVerification") ||
         body.includes("two-step verification") ||
         body.includes("2FA")
      ) {
         throw new Error(
            "Two-factor authentication is enabled on this account. Use the device code flow instead.",
         );
      }

      // Actual bad credentials
      if (
         body.includes("Sign in to") ||
         body.includes("sign in") ||
         body.includes("incorrect") ||
         body.includes("That Microsoft account doesn")
      ) {
         throw new Error("Invalid email or password");
      }

      throw new Error(
         "Email/password authentication failed: could not obtain access token from redirect",
      );
   }

   const fragment = location.split("#")[1];
   if (!fragment) throw new Error("No token fragment found in redirect URL");

   const params = new URLSearchParams(fragment);
   const accessToken = params.get("access_token");
   const refreshToken = params.get("refresh_token");
   const expiresIn = params.get("expires_in");

   if (!accessToken) throw new Error("No access_token in redirect response");

   return {
      accessToken: decodeURIComponent(accessToken),
      refreshToken: refreshToken ? decodeURIComponent(refreshToken) : "",
      expiresAt: Date.now() + (Number(expiresIn) || 86400) * 1000,
   };
}

function extractCookies(response: Response): string {
   const setCookies = response.headers.getSetCookie?.() ?? [];
   return setCookies.map((c) => c.split(";")[0]).join("; ");
}

function mergeCookies(existing: string, incoming: string): string {
   if (!incoming) return existing;
   if (!existing) return incoming;
   return `${existing}; ${incoming}`;
}

function sleep(ms: number): Promise<void> {
   return new Promise((resolve) => setTimeout(resolve, ms));
}
