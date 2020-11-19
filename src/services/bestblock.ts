import { Pool } from "pg";
import { Request, Response } from "express";

import { UtilEither } from "../utils";

export interface CardanoFrag {
  currentEpoch: EpochFrag;
}

export interface EpochFrag {
  blocks: BlockFrag[];
  number: number;
}

export interface BlockFrag {
  hash: string;
  number: number;
  slotNo: number;
  slotInEpoch: number;
}

export const askBestBlock = (pool: Pool) => async (
  req: Request,
  res: Response
): Promise<void> => {
  const query = `
         SELECT epoch_no AS "epoch",
           epoch_slot_no AS "slot",
           encode(hash, 'hex') as hash,
           block_no AS height,
         FROM BLOCK
         ORDER BY id DESC
         LIMIT 1;
       `;
  const bestBlock = await pool.query(query);
  res.send(bestBlock.rows[0]);
  return;
};
