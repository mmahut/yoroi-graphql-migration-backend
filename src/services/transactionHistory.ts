import { errMsgs, UtilEither, getAddressesByType } from "../utils";

import { rowToCertificate, BlockEra, BlockFrag, Certificate, TransInputFrag, TransOutputFrag, TransactionFrag} from "../Transactions/types";

import {
  TransactionMetadata,
  TransactionMetadatum,
  BigNum,
} from "@emurgo/cardano-serialization-lib-nodejs";

import { Pool } from "pg";

/**
  Everything else in this repo is using graphql, so why psql here?
  Hasura and the rest of the GraphQL start are _slow_ for this sort of thing.
  The psql query generated by Hasura for the equiv GraphQL does several layers
  of lateral joins.  On my machine, such queries can take as long as 41s to run.
  This SQL is fast, averaging about 10ms (though, clearly, the time scales poorly
  with the number of results, as you can see by the subqueries in the select clause.
  As we anticipate cardano-graphql being able to handle this in the future, I have
  left the interface to match what graphql would do.  For posterity's sake, I have
  also left the original GraphQL query in this file. 
  Beware! The GraphQL query never passed tests, and doesn't pull blockindex/tx_ordinal/tx_index.
**/
const askTransactionSqlQuery = `
  with
    hashes as (
      select distinct hash
      from (
            ${/* 1) Get all inputs for the transaction */""}

            select tx.hash as hash
            FROM tx

            JOIN tx_in 
              ON tx_in.tx_in_id = tx.id

            ${/**
              note: input table doesn't contain addresses directly
              so to check for all inputs that use address X
              we have to check the address for all outputs that occur in the input table
            **/""}
            JOIN tx_out source_tx_out 
              ON tx_in.tx_out_id = source_tx_out.tx_id 
             AND tx_in.tx_out_index::smallint = source_tx_out.index::smallint

            JOIN tx source_tx 
              ON source_tx_out.tx_id = source_tx.id

            WHERE source_tx_out.address = ANY(($1)::varchar array)
               OR source_tx_out.payment_cred = ANY(($6)::bytea array)

          UNION
            ${/* 2) Get all outputs for the transaction */""}
            select tx.hash as hash
            from tx

            JOIN tx_out
              on tx.id = tx_out.tx_id

            where tx_out.address = ANY(($1)::varchar array)
              or tx_out.payment_cred = ANY(($6)::bytea array)

          UNION
            ${/* 3) Get all certificates for the transaction */""}
            select tx.hash as hash
            from tx 

            JOIN combined_certificates as certs 
              on tx.id = certs."txId" 
            where
              (
                certs."formalType" in ('CertRegKey', 'CertDeregKey','CertDelegate')
                and certs."stakeCred" = any(
                  ${/* stakeCred is encoded as a string, so we have to convert from a byte array to a hex string */""}
                  (SELECT array_agg(encode(addr, 'hex')) from UNNEST($7::bytea array) as addr)::varchar array
                )
              ) or (
                ${/* note: PoolRetirement only contains pool key hash, so no way to map it to an address */""}
                certs."formalType" in ('CertRegPool')
                and certs."poolParamsRewardAccount" = any(
                  ${/* poolParamsRewardAccount is encoded as a string, so we have to convert from a byte array to a hex string */""}
                  (SELECT array_agg(encode(addr, 'hex')) from UNNEST($7::bytea array) as addr)::varchar array
                )
              )

          UNION
            ${/* 4) Get all withdrawals for the transaction */""}

            select tx.hash as hash
            from tx

            JOIN withdrawal as w
            on tx.id = w."tx_id"

            JOIN stake_address as addr
            on w.addr_id = addr.id

            where addr.hash_raw = any(($7)::bytea array)
           ) hashes
    )
  select tx.hash
       , tx.fee
       , metadata.map as "metadata"
       , tx.block_index as "txIndex"
       , block.block_no as "blockNumber"
       , block.hash as "blockHash"
       , block.epoch_no as "blockEpochNo"
       , block.slot_no as "blockSlotNo"
       , block.epoch_slot_no as "blockSlotInEpoch"
       , case when vrf_key is null then 'byron' 
              else 'shelley' end 
         as "blockEra"
       , block.time at time zone 'UTC' as "includedAt"
       , (select json_agg(( source_tx_out.address
                          , source_tx_out.value
                          , encode(source_tx.hash, 'hex')
                          , tx_in.tx_out_index) order by tx_in.id asc) as inAddrValPairs
          FROM tx inadd_tx
          JOIN tx_in
            ON tx_in.tx_in_id = inadd_tx.id
          JOIN tx_out source_tx_out 
            ON tx_in.tx_out_id = source_tx_out.tx_id AND tx_in.tx_out_index::smallint = source_tx_out.index::smallint
          JOIN tx source_tx 
            ON source_tx_out.tx_id = source_tx.id
          where inadd_tx.hash = tx.hash) as "inAddrValPairs"
       , (select json_agg(("address", "value") order by "index" asc)  as outAddrValPairs
          from "TransactionOutput" hasura_to
          where hasura_to."txHash" = tx.hash) as "outAddrValPairs"
       , (select json_agg((encode(addr."hash_raw",'hex'), "amount") order by w."id" asc)
          from withdrawal as w
          join stake_address as addr
          on addr.id = w.addr_id
          where tx_id = tx.id) as withdrawals
       , (select json_agg(row_to_json(combined_certificates) order by "certIndex" asc)
          from combined_certificates 
          where "txId" = tx.id) as certificates
                            
  from tx

  LEFT OUTER JOIN (
    select
      tx_id,
      jsonb_object_agg(key, bytes) as map
    from tx_metadata
    group by tx_id
  ) as metadata on metadata.tx_id = tx.id

  JOIN hashes
    on hashes.hash = tx.hash

  JOIN block
    on block.id = tx.block_id

  LEFT JOIN pool_meta_data 
    on tx.id = pool_meta_data.registered_tx_id 

  where 
        ${/* is within untilBlock (inclusive) */""}
        block.block_no <= $2
        and (
          ${/* Either: */""}
          ${/* 1) comes in block strict after the "after" field */""}
          block.block_no > $3
            or
          ${/* 2) Is in the same block as the "after" field, but is tx that appears afterwards */""}
          (block.block_no = $3 and tx.block_index > $4)
        ) 

  order by block.time asc, tx.block_index asc
  limit $5;
`;


// const graphQLQuery = `
//   query TxsHistory(
//     $addresses: [String]
//     $limit: Int
//     $afterBlockNum: Int
//     $untilBlockNum: Int
//   ) {
//     transactions(
//       where: {
//         _and: [
//           { block: { number: { _gte: $afterBlockNum, _lte: $untilBlockNum } } }
//           {
//             _or: [
//               { inputs: { address: { _in: $addresses } } }
//               { outputs: { address: { _in: $addresses } } }
//             ]
//           }
//         ]
//       }
//       limit: $limit
//       order_by: { includedAt: asc }
//     ) {
//       hash
  
//       block {
//         number
//         hash
//         epochNo
//         slotNo
//       }
//       includedAt
//       inputs {
//         address
//         value
//       }
//       outputs {
//         address
//         value
//       }
//     }
//   }
// `;

const MAX_INT = "2147483647";

function buildMetadataObj(
  metadataMap: null | Record<string, string>
): (null | string) {
  if (metadataMap == null) return null;
  const metadataWasm = TransactionMetadata.new();
  for (const key of Object.keys(metadataMap)) {
    const keyWasm = BigNum.from_str(key);
    // the cbor inserted into SQL is not the full metadata for the transaction
    // instead, each row is a CBOR map with a single entry <transaction_metadatum_label, transaction_metadatum>
    const singletonMap = TransactionMetadatum.from_bytes(
      Buffer.from(
        // need to cutoff the \\x prefix added by SQL
        metadataMap[key].substring(2),
        "hex"
      )
    );
    const map = singletonMap.as_map();
    const keys = map.keys();
    for (let i = 0; i < keys.len(); i++) {
      const cborKey = keys.get(i);
      const datumWasm = map.get(cborKey);
      metadataWasm.insert(
        keyWasm,
        datumWasm
      );
      datumWasm.free();
      cborKey.free();
    }
    keyWasm.free();
    singletonMap.free();
    map.free();
    keys.free();
  }
  const result = Buffer.from(metadataWasm.to_bytes()).toString("hex");
  metadataWasm.free();

  return result;
}

export const askTransactionHistory = async ( 
  pool: Pool
  , limit: number
  , addresses: string[]
  , after: {
    blockNumber: number,
    txIndex: number,
  }
  , untilNum: number
): Promise<UtilEither<TransactionFrag[]>> => {
    const addressTypes = getAddressesByType(addresses);
  const ret = await pool.query(askTransactionSqlQuery, [
      [
        ...addressTypes.legacyAddr,
        ...addressTypes.bech32,
      ]
    , untilNum
    , after.blockNumber
    , after.txIndex
    , limit
    , addressTypes.paymentCreds
    , addressTypes.stakingKeys
  ]);
  const txs = ret.rows.map( (row: any):TransactionFrag => {
    const inputs = row.inAddrValPairs 
      ? row.inAddrValPairs.map( ( obj:any ): TransInputFrag => 
        ({ address: obj.f1
          , amount: obj.f2.toString() 
          , id: obj.f3.concat(obj.f4.toString())
          , index: obj.f4
          , txHash: obj.f3}))
      : []; 
    const outputs = row.outAddrValPairs 
      ? row.outAddrValPairs.map( ( obj:any ): TransOutputFrag => ({ address: obj.f1, amount: obj.f2.toString() }))
      : [];
    const withdrawals : TransOutputFrag[] = row.withdrawals 
      ? row.withdrawals.map( ( obj:any ): TransOutputFrag => ({ address: obj.f1, amount: obj.f2.toString() })) 
      : [];
    const certificates = row.certificates !== null
      ? row.certificates
        .map(rowToCertificate) 
        .filter( (i:Certificate|null) => i !== null)
      : [];
    const blockFrag : BlockFrag = { number: row.blockNumber
      , hash: row.blockHash.toString("hex")
      , epochNo: row.blockEpochNo
      , slotNo: row.blockSlotInEpoch };
    return { hash: row.hash.toString("hex")
      , block: blockFrag
      , fee: row.fee.toString()
      , metadata: buildMetadataObj(row.metadata)
      , includedAt: row.includedAt
      , inputs: inputs
      , outputs: outputs
      , ttl: MAX_INT // https://github.com/input-output-hk/cardano-db-sync/issues/212
      , blockEra: row.blockEra === "byron" ? BlockEra.Byron : BlockEra.Shelley
      , txIndex: row.txIndex
      , withdrawals: withdrawals
      , certificates: certificates
    };
  });
            

  return { kind: "ok", value: txs } ;
  //if('data' in ret && 'data' in ret.data && 'transactions' in ret.data.data)
  //    return {'kind':'ok', value:ret.data.data.transactions};
  //else
  //    return {'kind':'error', errMsg:'TxsHistory, could not understand graphql response'};


};

export interface BlockNumByTxHashFrag {
  block: BlockByTxHashFrag;
  hash: string;
  blockIndex: number, // this is actually the index of the transaction in the block
}
interface BlockByTxHashFrag {
  hash: string;
  number: number;
}

const askBlockNumByTxHashQuery = `
  SELECT "tx"."hash" AS "hash", "tx"."block_index" as "blockIndex", "Block"."block_no" AS "blockNumber", "Block"."hash" AS "blockHash"
  FROM "tx"
  LEFT JOIN "block" "Block" ON "tx"."block_id" = "Block"."id"
  WHERE "tx"."hash"=decode($1, 'hex')
`;

export const askBlockNumByTxHash = async (pool: Pool, hash : string | undefined): Promise<UtilEither<BlockNumByTxHashFrag>> => {
    if(!hash)
        return {kind:"error", errMsg: errMsgs.noValue};

    try {
        const res = await pool.query(askBlockNumByTxHashQuery, [hash]);
        return {
            kind:"ok",
            value: {
                block: {
                    hash: res.rows[0].blockHash.toString("hex"),
                    number: res.rows[0].blockNumber,
                },
                hash: res.rows[0].hash.toString("hex"),
                blockIndex: res.rows[0].blockIndex
            }
        };
    } catch (err) {
        const errString = err.stack + "";
        return {kind:"error", errMsg: "askBlockNumByTxHash error: " + errString};
    }
};

const askBlockNumByHashQuery = `
  SELECT "block"."block_no" AS "blockNumber"
  FROM "block"
  WHERE "block"."hash"=decode($1, 'hex')
`;

export const askBlockNumByHash = async (pool: Pool, hash : string) : Promise<UtilEither<number>> => {
    if(!hash)
        return {kind:"error", errMsg: errMsgs.noValue};

    try {
        const res = await pool.query(askBlockNumByHashQuery, [hash]);
        return {
            kind:"ok",
            value: res.rows[0].blockNumber
        };
    } catch (err) {
        const errString = err.stack + "";
        return {kind:"error", errMsg: "askBlockNumByHash error: " + errString};
    }
};
