import { connect, Socket as TcpSocket } from "node:net";
import { createSocket, Socket as UdpSocket } from "node:dgram";

export type Socks5Options = {
   host: string;
   port: number;
   username?: string;
   password?: string;
};

export type Socks5Relay = {
   socket: UdpSocket;
   tcp: TcpSocket;
   send: (data: Buffer, targetAddress: string, targetPort: number) => void;
   close: () => void;
   onMessage: (handler: (data: Buffer, senderAddress: string, senderPort: number) => void) => void;
};

export async function createSocks5Relay(
   proxy: Socks5Options,
   family: "udp4" | "udp6" = "udp4"
): Promise<Socks5Relay> {
   const tcp = await tcpConnect(proxy.host, proxy.port);
   await authenticate(tcp, proxy.username, proxy.password);
   const relay = await udpAssociate(tcp);
   const udp = createSocket(family);

   await new Promise<void>((resolve) => {
      udp.bind(0, () => resolve());
   });

   let messageHandler: ((data: Buffer, addr: string, port: number) => void) | null = null;

   udp.on("message", (msg) => {
      if (msg.length < 10) return;
      if (msg[0] !== 0 || msg[1] !== 0 || msg[2] !== 0) return;
      const atyp = msg[3]!;
      let offset: number;
      let addr: string;
      if (atyp === 0x01) {
         addr = `${msg[4]}.${msg[5]}.${msg[6]}.${msg[7]}`;
         offset = 8;
      } else if (atyp === 0x03) {
         const len = msg[4]!;
         addr = msg.subarray(5, 5 + len).toString("ascii");
         offset = 5 + len;
      } else if (atyp === 0x04) {
         const parts: string[] = [];
         for (let i = 0; i < 8; i++) parts.push(msg.readUInt16BE(4 + i * 2).toString(16));
         addr = parts.join(":");
         offset = 20;
      } else return;
      const port = msg.readUInt16BE(offset);
      const payload = msg.subarray(offset + 2);
      if (messageHandler) messageHandler(payload, addr, port);
   });

   let closed = false;

   tcp.on("close", () => {
      if (closed) return;
      closed = true;
      try { udp.close(); } catch {}
   });

   return {
      socket: udp,
      tcp,
      send(data: Buffer, targetAddress: string, targetPort: number) {
         if (closed) return;
         const header = buildUdpHeader(targetAddress, targetPort);
         const packet = Buffer.concat([header, data]);
         udp.send(packet, relay.port, relay.address);
      },
      close() {
         if (closed) return;
         closed = true;
         try { udp.close(); } catch {}
         tcp.destroy();
      },
      onMessage(handler) {
         messageHandler = handler;
      },
   };
}

function tcpConnect(host: string, port: number): Promise<TcpSocket> {
   return new Promise((resolve, reject) => {
      const socket: TcpSocket = connect(port, host, () => resolve(socket));
      socket.once("error", reject);
   });
}

function authenticate(tcp: TcpSocket, username?: string, password?: string): Promise<void> {
   return new Promise((resolve, reject) => {
      const methods = username && password ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]);
      tcp.write(methods);
      tcp.once("data", (raw) => {
         const response = Buffer.from(raw);
         if (response[0] !== 0x05) return reject(new Error("Invalid SOCKS5 response"));
         const method = response[1];
         if (method === 0x00) return resolve();
         if (method === 0x02 && username && password) {
            const uBuf = Buffer.from(username, "utf8");
            const pBuf = Buffer.from(password, "utf8");
            const auth = Buffer.alloc(3 + uBuf.length + pBuf.length);
            auth[0] = 0x01;
            auth[1] = uBuf.length;
            uBuf.copy(auth, 2);
            auth[2 + uBuf.length] = pBuf.length;
            pBuf.copy(auth, 3 + uBuf.length);
            tcp.write(auth);
            tcp.once("data", (authRaw) => {
               const authResp = Buffer.from(authRaw);
               if (authResp[1] === 0x00) resolve();
               else reject(new Error("SOCKS5 authentication failed"));
            });
         } else {
            reject(new Error(`SOCKS5 unsupported auth method: ${method}`));
         }
      });
   });
}

function udpAssociate(tcp: TcpSocket): Promise<{ address: string; port: number }> {
   return new Promise((resolve, reject) => {
      const request = Buffer.from([
         0x05, 0x03, 0x00,
         0x01, 0x00, 0x00, 0x00, 0x00,
         0x00, 0x00,
      ]);
      tcp.write(request);
      tcp.once("data", (raw) => {
         const response = Buffer.from(raw);
         if (response[0] !== 0x05 || response[1] !== 0x00) {
            return reject(new Error(`SOCKS5 UDP ASSOCIATE failed: ${response[1]}`));
         }
         const atyp = response[3]!;
         let address: string;
         let portOffset: number;
         if (atyp === 0x01) {
            address = `${response[4]}.${response[5]}.${response[6]}.${response[7]}`;
            portOffset = 8;
         } else if (atyp === 0x03) {
            const len = response[4]!;
            address = response.subarray(5, 5 + len).toString("ascii");
            portOffset = 5 + len;
         } else if (atyp === 0x04) {
            const parts: string[] = [];
            for (let i = 0; i < 8; i++) parts.push(response.readUInt16BE(4 + i * 2).toString(16));
            address = parts.join(":");
            portOffset = 20;
         } else {
            return reject(new Error(`SOCKS5 unsupported address type: ${atyp}`));
         }
         const port = response.readUInt16BE(portOffset);
         if (address === "0.0.0.0" || address === "::") {
            address = tcp.remoteAddress!;
         }
         resolve({ address, port });
      });
   });
}

function buildUdpHeader(address: string, port: number): Buffer {
   const isIPv4 = address.includes(".");
   if (isIPv4) {
      const header = Buffer.alloc(10);
      header[3] = 0x01;
      const parts = address.split(".");
      for (let i = 0; i < 4; i++) header[4 + i] = parseInt(parts[i]!, 10);
      header.writeUInt16BE(port, 8);
      return header;
   }
   const header = Buffer.alloc(22);
   header[3] = 0x04;
   const parts = address.split(":");
   for (let i = 0; i < 8; i++) header.writeUInt16BE(parseInt(parts[i]!, 16), 4 + i * 2);
   header.writeUInt16BE(port, 20);
   return header;
}
