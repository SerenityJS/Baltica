# Baltica

Baltica is a TypeScript toolkit for Minecraft Bedrock Edition. It provides a client, server, and bridge (proxy) for building bots, inspecting packets, and working with vanilla gameplay.

Built on Bun. Uses a custom RakNet implementation with SOCKS5 proxy support and Email + Password authentication, but still supports OATH2!.

[❗❗ Join our Discord server!❗❗](https://discord.gg/t72KcmT6dY)

## Packages

| Package | Description |
|---|---|
| `baltica` | Core package — Client, Server, and Bridge |
| `@baltica/raknet` | RakNet protocol implementation |
| `@baltica/auth` | Xbox Live / Microsoft authentication |
| `@baltica/utils` | Shared utilities (logger, typed event emitter) |

## Getting Started

```bash
bun add baltica
```

## Usage

### Client

Connect to a server as a bot:

```ts
import { Client } from "baltica";

const client = new Client({
  address: "127.0.0.1",
  port: 19132,
  offline: true,
  username: "Bot",
});

client.on("disconnect", (reason) => {
  console.log("Disconnected:", reason);
});

await client.connect();
console.log("Spawned in world");
```

### Client with Proxy

Route traffic through a SOCKS5 proxy:

```ts
const client = new Client({
  address: "play.example.net",
  proxy: {
    host: "proxy.example.com",
    port: 1080,
    username: "user",
    password: "pass",
  },
});

await client.connect();
```

### Server

Accept incoming Bedrock connections:

```ts
import { Server } from "baltica";

const server = new Server({
  port: 19132,
  motd: "MCPE;My Server;0;0.0.0;0;0;0;Baltica;Survival;1;19132;19133;0;",
});

server.on("playerConnect", (player) => {
  console.log("Player connected:", player.connection.identifier);
});

server.on("disconnect", (name, player) => {
  console.log("Player left:", name);
});

await server.start();
```

### Bridge (Proxy)

Sit between a client and a remote server to inspect or modify traffic:

```ts
import { Bridge } from "baltica";

const bridge = new Bridge({
  port: 19132,
  destination: {
    address: "play.example.net",
    port: 19132,
  },
  email: "user@example.com",
  password: "super-secret-password",
  proxy: {
    host: "proxy.example.com",
    port: 1080,
    username: "user",
    password: "pass",
  },
});

bridge.on("connect", con => {
  con.on("serverBound-PlayerAuthInputPacket", (packet) => {
    console.log(packet.packet);
  })
})

bridge.on("disconnect", (player) => {
  console.log("Player left bridge");
});

await bridge.start();
```

## Listening to Packets

All Bedrock protocol packets from `@serenityjs/protocol` can be listened to by name on the client:

```ts
client.on("TextPacket", (packet) => {
  console.log(`Chat: ${packet.variant.message}`);
});

client.on("MovePlayerPacket", (packet) => {
  console.log(`Moved to ${packet.position.x}, ${packet.position.y}, ${packet.position.z}`);
});
```

## Protocol Version

Currently targets Bedrock `1.26.1` and `1.21.2` (protocol `924`).

## Project Structure

```
packages/
  baltica/       Core client, server, and bridge
  raknet/        RakNet protocol layer
  auth/          Xbox Live authentication flow
  utils/         Logger and typed event emitter
apps/
  raknet/        Example / test app
```

## License

See individual packages for license information.
