import type { Player } from "../player";

export type ServerEvents = {
   playerConnect: [player: Player];
   disconnect: [name: string, player: Player];
};
