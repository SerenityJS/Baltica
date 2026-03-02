import { BinaryStream } from "@serenityjs/binarystream";
import {
   Ack, Frame, FrameSet, Nack, Packet, Priority, Reliability, Status,
   UnconnectedPing, UnconnectedPong,
   OpenConnectionRequestOne, OpenConnectionReplyOne,
   OpenConnectionRequestTwo, OpenConnectionReplyTwo,
   ConnectionRequest, ConnectionRequestAccepted,
   NewIncomingConnection, ConnectedPing, ConnectedPong, Disconnect,
   Address,
} from "./proto";
import { Emitter } from "@baltica/utils";

const MTU_HEADER_SIZE = 36;
const RECEIVE_WINDOW = 2048;
const RELIABLE_WINDOW = 4096;
const FRAGMENT_TIMEOUT = 30_000;
const ORDER_QUEUE_MAX = 4096; 
const ORDER_SKIP_THRESHOLD = 8192;
const RAKNET_PROTOCOL = 11;
const GAME_PACKET_ID = 0xfe;

export type NetworkEvents = {
   encapsulated: [payload: Buffer];
   pong: [message: string];
   connect: [];
   disconnect: [];
   error: [error: Error];
};

export class NetworkSession extends Emitter<NetworkEvents> {
   public mtu: number;
   public client: boolean;
   public guid!: bigint;
   public remoteGuid!: bigint;
   public status: Status = Status.Disconnected;
   public address!: Address;
   public send!: (data: Buffer) => void;
   public serverMessage?: string;
   public maxRetransmit = 3;
   public retransmitInterval = 1000;

   public outputReliableIndex = 0;
   public outputSplitIndex = 0;
   private outputSequence = 0;
   public outputSequenceIndex = new Array<number>(32).fill(0);
   public outputOrderIndex = new Array<number>(32).fill(0);
   public outputFrames = new Set<Frame>();
   public outputBackup = new Map<number, Frame[]>();

   public receivedFrameSequences = new Set<number>();
   public lostFrameSequences = new Set<number>();
   public pendingAcks = new Set<number>();
   public lastInputSequence = -1;
   public fragmentsQueue = new Map<number, { frames: Map<number, Frame>; timestamp: number }>();
   public inputHighestSequenceIndex = new Array<number>(32).fill(0);
   public inputOrderIndex = new Array<number>(32).fill(0);
   private inputOrderingQueue = new Map<number, Map<number, Frame>>();
   private receivedReliableFrameIndices = new Set<number>();
   private highestReliableIndex = -1;
   private offlineRetry: { data: Buffer; attempts: number; maxAttempts: number; lastSent: number; interval: number } | null = null;
   private outputBackupTimestamps = new Map<number, number>();
   
   private ackTimer?: ReturnType<typeof setTimeout>;
   private retransmitTimer?: ReturnType<typeof setTimeout>;
   private cleanupTimer?: ReturnType<typeof setTimeout>;
   private lastCleanup = 0;

   constructor(mtu: number, client: boolean) {
      super();
      this.mtu = mtu;
      this.client = client;
      for (let i = 0; i < 32; i++) this.inputOrderingQueue.set(i, new Map());
   }

   sendOfflineWithRetry(data: Buffer): void {
      this.offlineRetry = { data, attempts: 1, maxAttempts: this.maxRetransmit, lastSent: Date.now(), interval: this.retransmitInterval };
      this.send(data);
      if (!this.retransmitTimer) {
         this.retransmitTimer = setTimeout(() => this.tick(), this.retransmitInterval);
      }
   }

   private clearOfflineRetry(): void {
      this.offlineRetry = null;
      if (this.retransmitTimer) {
         clearTimeout(this.retransmitTimer);
         this.retransmitTimer = undefined;
      }
   }

   destroy(): void {
      if (this.ackTimer) clearTimeout(this.ackTimer);
      if (this.retransmitTimer) clearTimeout(this.retransmitTimer);
      if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
      this.removeAllListeners();
   }

   receive(buffer: Buffer): void {
      const id = buffer[0]!;
      const payload = buffer.subarray(1);
      if (id === Packet.Ack) return this.onAck(new Ack(payload).deserialize());
      if (id === Packet.Nack) return this.onNack(new Nack(payload).deserialize());
      if (id >= Packet.FrameSetMin && id <= Packet.FrameSetMax) return this.onFrameSet(new FrameSet(payload).deserialize());
      if (this.client) this.handleClientOffline(id, buffer);
      else this.handleServerOffline(id, buffer);
   }

   private handleClientOffline(id: number, buffer: Buffer): void {
      const payload = buffer.subarray(1);
      switch (id) {
         case Packet.UnconnectedPong: {
            this.clearOfflineRetry();
            const pong = new UnconnectedPong(payload).deserialize();
            this.serverMessage = pong.message;
            this.remoteGuid = pong.guid;
            this.emit("pong", pong.message);
            break;
         }
         case Packet.OpenConnectionReply1: {
            this.clearOfflineRetry();
            const reply = new OpenConnectionReplyOne(payload).deserialize();
            this.remoteGuid = reply.guid;
            this.mtu = Math.min(this.mtu, reply.mtu);
            const req = new OpenConnectionRequestTwo();
            req.address = this.address;
            req.mtu = this.mtu;
            req.guid = this.guid;
            req.cookie = reply.cookie;
            req.clientSupportsecurity = false;
            this.sendOfflineWithRetry(req.serialize());
            break;
         }
         case Packet.OpenConnectionReply2: {
            this.clearOfflineRetry();
            const reply = new OpenConnectionReplyTwo(payload).deserialize();
            this.mtu = Math.min(this.mtu, reply.mtu);
            this.status = Status.Connecting;
            const req = new ConnectionRequest();
            req.guid = this.guid;
            req.timestamp = BigInt(Date.now());
            req.useSecurity = false;
            this.frameAndSend(req.serialize(), Priority.High);
            break;
         }
         case Packet.AlreadyConnected: {
            this.clearOfflineRetry();
            this.status = Status.Disconnected;
            this.emit("disconnect");
            break;
         }
         case Packet.IncompatibleProtocolVersion: {
            this.clearOfflineRetry();
            this.status = Status.Disconnected;
            this.emit("error", new Error("Incompatible protocol version"));
            break;
         }
      }
   }

   private handleServerOffline(id: number, buffer: Buffer): void {
      const payload = buffer.subarray(1);
      switch (id) {
         case Packet.UnconnectedPing:
         case Packet.UnconnectedPingOpenConnections: {
            const ping = new UnconnectedPing(payload).deserialize();
            const pong = new UnconnectedPong();
            pong.timestamp = ping.timestamp;
            pong.guid = this.guid;
            pong.message = this.serverMessage ?? "";
            this.send(pong.serialize());
            break;
         }
         case Packet.OpenConnectionRequest1: {
            const req = new OpenConnectionRequestOne(payload).deserialize();
            const reply = new OpenConnectionReplyOne();
            reply.guid = this.guid;
            reply.security = false;
            reply.cookie = null;
            reply.hasCookie = false;
            reply.serverPublicKey = null;
            reply.mtu = Math.min(this.mtu, req.mtu);
            this.send(reply.serialize());
            break;
         }
         case Packet.OpenConnectionRequest2: {
            const req = new OpenConnectionRequestTwo(payload).deserialize();
            this.mtu = Math.min(this.mtu, req.mtu);
            this.remoteGuid = req.guid;
            this.address = req.address;
            const reply = new OpenConnectionReplyTwo();
            reply.guid = this.guid;
            reply.address = req.address;
            reply.mtu = this.mtu;
            reply.encryptionEnabled = false;
            this.send(reply.serialize());
            this.status = Status.Connecting;
            break;
         }
      }
   }

   private handleOnlinePacket(payload: Buffer): void {
      const id = payload[0]!;
      const data = payload.subarray(1);
      
      switch (id) {
         case Packet.ConnectionRequestAccepted: {
            if (!this.client) break;
            const accepted = new ConnectionRequestAccepted(data).deserialize();
            const nic = new NewIncomingConnection();
            nic.address = this.address;
            nic.internalAddress = new Address("0.0.0.0", 0, 4);
            nic.incomingTimestamp = accepted.requestTimestamp;
            nic.serverTimestamp = BigInt(Date.now());
            this.frameAndSend(nic.serialize(), Priority.High);
            this.status = Status.Connected;
            this.emit("connect");
            break;
         }
         case Packet.ConnectionRequest: {
            if (this.client) break;
            const req = new ConnectionRequest(data).deserialize();
            const accepted = new ConnectionRequestAccepted();
            accepted.address = this.address;
            accepted.systemIndex = 0;
            accepted.addresses = Array.from({ length: 20 }, () => new Address("0.0.0.0", 0, 4));
            accepted.requestTimestamp = req.timestamp;
            accepted.timestamp = BigInt(Date.now());
            this.frameAndSend(accepted.serialize(), Priority.High);
            break;
         }
         case Packet.NewIncomingConnection: {
            if (this.client) break;
            this.status = Status.Connected;
            this.emit("connect");
            break;
         }
         case Packet.ConnectedPing: {
            const ping = new ConnectedPing(data).deserialize();
            const pong = new ConnectedPong();
            pong.pingTimestamp = ping.timestamp;
            pong.pongTimestamp = BigInt(Date.now());
            this.frameAndSend(pong.serialize(), Priority.High);
            break;
         }
         case Packet.ConnectedPong:
            break;
         case Packet.DisconnectionNotification:
            this.status = Status.Disconnected;
            this.emit("disconnect");
            break;
         default:
            if (id === GAME_PACKET_ID) this.emit("encapsulated", payload);
            break;
      }
   }

   tick(): void {
      if (this.status === Status.Disconnected) return;
      const now = Date.now();
      
      if (this.offlineRetry) {
         const r = this.offlineRetry;
         if (now - r.lastSent >= r.interval) {
            if (r.attempts >= r.maxAttempts) {
               this.offlineRetry = null;
               this.status = Status.Disconnected;
               this.emit("error", new Error("Connection timed out after " + r.maxAttempts + " attempts"));
               return;
            }
            r.attempts++;
            r.lastSent = now;
            this.send(r.data);
            if (this.retransmitTimer) clearTimeout(this.retransmitTimer);
            this.retransmitTimer = setTimeout(() => this.tick(), r.interval);
            return;
         }
      }

      if (now - this.lastCleanup > 5000) {
         this.lastCleanup = now;
         const windowStart = this.lastInputSequence - RECEIVE_WINDOW;
         if (windowStart > 0) {
            for (const s of this.receivedFrameSequences) if (s < windowStart) this.receivedFrameSequences.delete(s);
            for (const s of this.lostFrameSequences) if (s < windowStart) this.lostFrameSequences.delete(s);
         }
         const relStart = this.highestReliableIndex - RELIABLE_WINDOW;
         if (relStart > 0) {
            for (const i of this.receivedReliableFrameIndices) if (i < relStart) this.receivedReliableFrameIndices.delete(i);
         }
         for (const [id, entry] of this.fragmentsQueue) {
            if (now - entry.timestamp > FRAGMENT_TIMEOUT) this.fragmentsQueue.delete(id);
         }
      }

      if (this.pendingAcks.size > 0 || this.lostFrameSequences.size > 0) {
         if (this.pendingAcks.size > 0) {
            const ack = new Ack();
            ack.sequences = [...this.pendingAcks];
            this.pendingAcks.clear();
            this.send(ack.serialize());
         }
         if (this.lostFrameSequences.size > 0) {
            const nack = new Nack();
            nack.sequences = [...this.lostFrameSequences];
            this.lostFrameSequences.clear();
            this.send(nack.serialize());
         }
      }

      let nextRetransmit = Infinity;
      for (const [seq, sentAt] of this.outputBackupTimestamps) {
         const age = now - sentAt;
         if (age >= this.retransmitInterval) {
            const frames = this.outputBackup.get(seq);
            if (frames) {
               const fs = new FrameSet();
               fs.sequence = seq;
               fs.frames = frames;
               this.send(fs.serialize());
               this.outputBackupTimestamps.set(seq, now);
               nextRetransmit = Math.min(nextRetransmit, this.retransmitInterval);
            } else {
               this.outputBackupTimestamps.delete(seq);
            }
         } else {
            nextRetransmit = Math.min(nextRetransmit, this.retransmitInterval - age);
         }
      }

      if (this.outputFrames.size > 0) this.flush();

      if (nextRetransmit < Infinity) {
         if (this.retransmitTimer) clearTimeout(this.retransmitTimer);
         this.retransmitTimer = setTimeout(() => this.tick(), nextRetransmit);
      }
   }

   private onAck(ack: Ack): void {
      for (const seq of ack.sequences) {
         this.outputBackup.delete(seq);
         this.outputBackupTimestamps.delete(seq);
      }
      if (this.outputBackupTimestamps.size === 0 && this.retransmitTimer) {
         clearTimeout(this.retransmitTimer);
         this.retransmitTimer = undefined;
      }
   }

   private onNack(nack: Nack): void {
      for (const seq of nack.sequences) {
         const frames = this.outputBackup.get(seq);
         if (!frames) continue;
         const fs = new FrameSet();
         fs.sequence = seq;
         fs.frames = frames;
         this.send(fs.serialize());
      }
   }

   frameAndSend(data: Buffer, priority: Priority = Priority.Medium): void {
      const frame = new Frame();
      frame.reliability = Reliability.ReliableOrdered;
      frame.orderChannel = 0;
      frame.payload = data;
      this.sendFrame(frame, priority);
   }

   sendFrame(frame: Frame, priority: Priority = Priority.Medium): void {
      const channel = frame.orderChannel;
      if (frame.isSequenced()) {
         frame.orderedFrameIndex = this.outputOrderIndex[channel]!;
         frame.sequenceFrameIndex = this.outputSequenceIndex[channel]!++;
      } else if (frame.isOrdered()) {
         frame.orderedFrameIndex = this.outputOrderIndex[channel]!++;
         this.outputSequenceIndex[channel] = 0;
      }
      const maxSize = this.mtu - MTU_HEADER_SIZE;
      if (frame.payload.byteLength > maxSize) {
         this.sendSplit(frame, maxSize, priority);
      } else {
         if (frame.isReliable()) frame.reliableFrameIndex = this.outputReliableIndex++;
         this.queueFrame(frame, priority);
      }
   }

   private sendSplit(frame: Frame, maxSize: number, priority: Priority): void {
      const payload = frame.payload;
      const splitSize = Math.ceil(payload.byteLength / maxSize);
      const splitId = this.outputSplitIndex++ & 0xffff;
      for (let i = 0; i < splitSize; i++) {
         const nf = new Frame();
         nf.reliability = frame.reliability;
         nf.sequenceFrameIndex = frame.sequenceFrameIndex;
         nf.orderedFrameIndex = frame.orderedFrameIndex;
         nf.orderChannel = frame.orderChannel;
         if (nf.isReliable()) nf.reliableFrameIndex = this.outputReliableIndex++;
         nf.payload = payload.subarray(i * maxSize, Math.min((i + 1) * maxSize, payload.byteLength));
         nf.splitFrameIndex = i;
         nf.splitId = splitId;
         nf.splitSize = splitSize;
         this.queueFrame(nf, priority);
      }
   }

   private queueFrame(frame: Frame, priority: Priority): void {
      let length = 4;
      for (const f of this.outputFrames) length += f.getByteLength();
      if (length + frame.getByteLength() > this.mtu - MTU_HEADER_SIZE) this.flush();
      this.outputFrames.add(frame);
      if (priority === Priority.High) this.flush();
   }

   private flush(): void {
      if (this.outputFrames.size === 0) return;
      const fs = new FrameSet();
      fs.sequence = this.outputSequence++;
      fs.frames = [...this.outputFrames];
      this.outputBackup.set(fs.sequence, fs.frames);
      this.outputBackupTimestamps.set(fs.sequence, Date.now());
      this.outputFrames.clear();
      this.send(fs.serialize());
      
      if (!this.retransmitTimer) {
         this.retransmitTimer = setTimeout(() => this.tick(), this.retransmitInterval);
      }
   }

   private onFrameSet(fs: FrameSet): void {
      if (this.receivedFrameSequences.has(fs.sequence)) return;
      this.lostFrameSequences.delete(fs.sequence);
      this.receivedFrameSequences.add(fs.sequence);
      this.pendingAcks.add(fs.sequence);
      if (fs.sequence > this.lastInputSequence) {
         for (let i = this.lastInputSequence + 1; i < fs.sequence; i++) {
            if (!this.receivedFrameSequences.has(i)) this.lostFrameSequences.add(i);
         }
         this.lastInputSequence = fs.sequence;
      }
      for (const frame of fs.frames) this.handleFrame(frame);
      
      if (!this.ackTimer) {
         this.ackTimer = setTimeout(() => {
            this.ackTimer = undefined;
            this.tick();
         }, 10);
      }
   }

   private handleFrame(frame: Frame): void {
      if (frame.isReliable()) {
         if (this.receivedReliableFrameIndices.has(frame.reliableFrameIndex)) return;
         this.receivedReliableFrameIndices.add(frame.reliableFrameIndex);
         if (frame.reliableFrameIndex > this.highestReliableIndex) this.highestReliableIndex = frame.reliableFrameIndex;
      }
      if (frame.isSplit()) this.handleSplit(frame);
      else if (frame.isSequenced()) this.handleSequenced(frame);
      else if (frame.isOrdered()) this.handleOrdered(frame);
      else this.handleOnlinePacket(frame.payload);
   }

   private handleSplit(frame: Frame): void {
      let entry = this.fragmentsQueue.get(frame.splitId);
      if (!entry) {
         entry = { frames: new Map(), timestamp: Date.now() };
         this.fragmentsQueue.set(frame.splitId, entry);
      }
      entry.frames.set(frame.splitFrameIndex, frame);
      if (entry.frames.size !== frame.splitSize) return;
      const stream = new BinaryStream();
      for (let i = 0; i < frame.splitSize; i++) {
         const f = entry.frames.get(i);
         if (!f) { this.fragmentsQueue.delete(frame.splitId); return; }
         stream.write(f.payload);
      }
      this.fragmentsQueue.delete(frame.splitId);
      const reassembled = new Frame();
      reassembled.reliability = frame.reliability;
      reassembled.reliableFrameIndex = frame.reliableFrameIndex;
      reassembled.sequenceFrameIndex = frame.sequenceFrameIndex;
      reassembled.orderedFrameIndex = frame.orderedFrameIndex;
      reassembled.orderChannel = frame.orderChannel;
      reassembled.splitSize = 0;
      reassembled.payload = stream.getBuffer();
      if (reassembled.isSequenced()) this.handleSequenced(reassembled);
      else if (reassembled.isOrdered()) this.handleOrdered(reassembled);
      else this.handleOnlinePacket(reassembled.payload);
   }

   private handleSequenced(frame: Frame): void {
      const ch = frame.orderChannel;
      if (frame.sequenceFrameIndex < this.inputHighestSequenceIndex[ch]!) return;
      this.inputHighestSequenceIndex[ch] = frame.sequenceFrameIndex + 1;
      this.handleOnlinePacket(frame.payload);
   }

   private handleOrdered(frame: Frame): void {
      const ch = frame.orderChannel;
      const expected = this.inputOrderIndex[ch]!;
      if (frame.orderedFrameIndex === expected) {
         this.inputHighestSequenceIndex[ch] = 0;
         this.inputOrderIndex[ch] = expected + 1;
         this.handleOnlinePacket(frame.payload);
         const queue = this.inputOrderingQueue.get(ch)!;
         let next = expected + 1;
         while (queue.has(next)) {
            this.handleOnlinePacket(queue.get(next)!.payload);
            queue.delete(next);
            next++;
         }
         this.inputOrderIndex[ch] = next;
      } else if (frame.orderedFrameIndex > expected) {
         if (frame.orderedFrameIndex - expected > ORDER_SKIP_THRESHOLD) {
            const queue = this.inputOrderingQueue.get(ch);
            if (queue) queue.clear();
            this.inputOrderIndex[ch] = frame.orderedFrameIndex + 1;
            this.handleOnlinePacket(frame.payload);
            return;
         }
         const queue = this.inputOrderingQueue.get(ch)!;
         if (queue.size < ORDER_QUEUE_MAX) queue.set(frame.orderedFrameIndex, frame);
      }
   }
}
