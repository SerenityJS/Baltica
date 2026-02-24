import { Packet } from "../../enums/packet";
import { DataPacket } from "../data-packet";
import { Magic } from "../../types/magic";

export class OpenConnectionReplyOne extends DataPacket {
   public static override ID = Packet.OpenConnectionReply1;

   public guid!: bigint;
   public security!: boolean;
   public hasCookie!: boolean;
   public cookie!: number | null;
   public serverPublicKey!: Buffer | null;
   public mtu!: number;

   public override serialize(): Buffer {
      this.writeUint8(OpenConnectionReplyOne.ID);
      new Magic().write(this);
      this.writeUint64(this.guid);
      this.writeBool(this.security);
      if (this.security) {
         if (this.cookie != null) {
            this.writeUint32(this.cookie);
         }
         if (this.serverPublicKey) {
            this.write(this.serverPublicKey);
         }
      }
      this.writeUint16(this.mtu);
      return this.getBuffer();
   }

   public override deserialize(): this {
      Magic.read(this);
      this.guid = this.readUint64();
      this.security = this.readBool();
      this.cookie = null;
      this.hasCookie = false;
      this.serverPublicKey = null;
      if (this.security) {
         this.hasCookie = true;
         this.cookie = this.readUint32();
      }
      this.mtu = this.readUint16();
      return this;
   }
}
