import * as ds from '../utils/debugScopes';
import * as rest from '../utils/rest';
import * as config from '../config.json';
import * as t from './../utils/types';
import { NO_BLOCK_NUM } from '../utils/constants';

import * as dotenv from 'dotenv';
dotenv.config();

const log = ds.getLog('sushiswap');

/**
 *  getRawPairsV2:
 *    Call this initially with lastId = "". Then get the last id in the
 *    returned response and pass that in.
 *
 * @param fetchAmt
 * @param lastId
 * @returns
 *
 * Notes:
 *   This method uses the ID technique described in the last example from:
 *   https://thegraph.com/docs/graphql-api#pagination
 *
 *   Taken from that page:
 *
 *   If a client needs to retrieve a large number of entities, it is much more
 *   performant to base queries on an attribute and filter by that attribute. For
 *   example, a client would retrieve a large number of tokens using this query:
 *   {
 *     query manyTokens($lastID: String) {
 *       tokens(first: 1000, where: { id_gt: $lastID  }) {
 *   	     id
 *   	     owner
 *       }
 *     }
 *   }
 *
 *   The first time, it would send the query with lastID = "", and for subsequent
 *   requests would set lastID to the id attribute of the last entity in the previous
 *   request. This approach will perform significantly better than using increasing
 *   skip values.
 *
 *   Occasionally the graph just fails on a query so there is also retry if the response is
 *   missing the data field.  The default is 5 for missingDataRetries.
 *
 * TODO: modify this to update to a specific block number (or lock it in to
 *       the block number of the first fetch to keep the block number
 *       consistent across all fetches).
 */
const getRawPairsV2 = async (
  fetchAmt: number,
  lastId: string,
  missingDataRetries = 5,
): Promise<any> => {
  const payload = {
    query: `{
      pairs(first: ${fetchAmt}, 
            where: { id_gt: "${lastId}"} ) {
        id
        reserve0
        reserve1
        reserveUSD
        token0 {
          id
          symbol
          name
        }
        token1 {
          id
          symbol
          name
        }
        token0Price
        token1Price
        liquidityProviderCount
      }
      _meta {
        block {
          number
        }
      }
    }`,
    variables: {},
  };

  let attempt = 0;
  let response: any = undefined;
  while (attempt < missingDataRetries) {
    try {
      attempt++;
      response = await rest.postWithRetry(config.uniswap_v2_graph_url, payload);
    } catch (error) {
      throw new Error('Failed to fetch data from SushiSwap Graph\n' + error);
    }

    if (response && response.data && response.data.pairs) {
      return response.data;
    } else {
      const _responseStr = JSON.stringify(response);
      const _responseStrShort =
        _responseStr && _responseStr.length
          ? _responseStr.substr(0, 1024)
          : _responseStr;
      log.warn(`Attempt ${attempt} of ${missingDataRetries}.`);
      log.warn(
        'Response from SushiSwap Graph does not contain property "data"\n' +
          `  url: ${config.uniswap_v2_graph_url}\n` +
          `  response: ${_responseStrShort}...\n` +
          `  query: ${JSON.stringify(payload.query)}\n`,
      );
    }
  }
  return undefined;
};

/**
 * fetchAllPairs:
 *   Fetches all uniswap pairs from the SushiSwap Graph.
 *
 * TODO: Look at extracting an error for the unexpected condition termination
 * TODO: See above TO DO for getRawPairsV2 for block number consistency.
 */
export const fetchAllRawPairsV2 = async (): Promise<t.Pairs> => {
  let lastId = '';
  let numPairsToGet = 1000;
  let lowestBlockNumber = -1;

  const pairArr: any = [];

  while (numPairsToGet > 0) {
    const rawPairData: any = await getRawPairsV2(numPairsToGet, lastId);

    if (!rawPairData || !rawPairData.hasOwnProperty('pairs')) {
      throw new Error(
        `Unexpected request response. No pair data received after ` +
          `fetching ${pairArr.length} pairs.`,
      );
    }

    const { pairs, _meta }: any = rawPairData;
    if (_meta && _meta.block && _meta.block.number) {
      const blockNumber = parseInt(_meta.block.number);
      if (
        (!isNaN(blockNumber) && lowestBlockNumber === -1) ||
        lowestBlockNumber > blockNumber
      ) {
        lowestBlockNumber = blockNumber;
      }
    }
    if (pairs.length < numPairsToGet) {
      // End the loop if less than numPairsToGet received:
      numPairsToGet = 0;
    } else if (pairs.length > 0) {
      lastId = pairs[pairs.length - 1].id;
    }

    pairArr.push(...pairs);
    log.debug(
      `Received ${pairs.length} pairs (total received: ${pairArr.length}) ...`,
    );
  }

  // Convert from array to object/dictionary storage of pairs based on id:
  const allPairs = new t.Pairs();
  for (const pair of pairArr) {
    allPairs.addPair(pair);
  }
  allPairs.setLowestBlockNumber(lowestBlockNumber);
  allPairs.clearUpdatedSinceLowestBlockNumber();

  return allPairs;
};

export const _getPairUpdate = async (
  pairIds: string[],
  blockNumber: number = NO_BLOCK_NUM,
  missingDataRetries: number = 5,
): Promise<t.PairLite[] | undefined> => {
  const timeTravelQuery =
    blockNumber !== NO_BLOCK_NUM ? `block: { number: ${blockNumber} }` : '';

  // Probably faster to not do id_in below but build individual queries w/ equality (
  // Postgres n^2 problem): (TODO change query and test)
  const payload = {
    query: `{
      pairs(first: 1000
            where: {id_in: ["${pairIds.join('", "')}"]}
            ${timeTravelQuery}) {
        id,
        reserve0,
        reserve1,
        reserveUSD
        token0Price,
        token1Price
      }
    }`,
    variables: {},
  };

  let attempt = 0;
  let response: any = undefined;
  while (attempt < missingDataRetries) {
    try {
      attempt++;
      response = await rest.postWithRetry(config.uniswap_v2_graph_url, payload);
    } catch (error) {
      throw new Error('Failed to fetch data from SushiSwap Graph\n' + error);
    }

    if (response && response.data && response.data.pairs) {
      return response.data.pairs;
    } else {
      const _responseStr = JSON.stringify(response);
      const _responseStrShort =
        _responseStr && _responseStr.length
          ? _responseStr.substr(0, 1024)
          : _responseStr;
      const _payloadQueryShort = `${JSON.stringify(payload.query).substr(
        0,
        1024,
      )} ...`;
      log.warn(`Attempt ${attempt} of ${missingDataRetries}.`);
      log.warn(
        'Response from SushiSwap Graph does not contain property "data"\n' +
          `  url: ${config.uniswap_v2_graph_url}\n` +
          `  response: ${_responseStrShort}...\n` +
          `  query: ${_payloadQueryShort}\n`,
      );
    }
  }

  return undefined;
};

export const getUpdatedPairData = async (
  pairIds: Set<string>,
  blockNumber: number = NO_BLOCK_NUM,
  missingDataRetries: number = 5,
): Promise<t.PairLite[]> => {
  const pairs: t.PairLite[] = [];

  let offset = 0;
  let promises: Promise<t.PairLite[] | undefined>[] = [];
  const pairIdArr: string[] = [...pairIds];
  while (offset < pairIdArr.length) {
    // Process in chunks of 1k:
    const pairIdSubArr = pairIdArr.slice(offset, offset + 1000);
    offset += 1000;

    // log.debug(`getUpdatedPairData:  updating ${pairIdSubArr.length} / ${pairIds.size} pairs.`)
    promises.push(
      _getPairUpdate(pairIdSubArr, blockNumber, missingDataRetries).catch(
        (error) => {
          log.warn(`🆘 ERROR in concurrent call to _getPairUpdate:\n${error}`);
          return undefined;
        },
      ),
    );
  }

  const _pairsToMerge = await Promise.all(promises);
  for (const _pair of _pairsToMerge) {
    if (_pair) {
      pairs.push(..._pair);
    } else {
      log.warn(
        `🆘 Failed to get data in one or more concurrent calls to _getPairUpdate. Ignoring.`,
      );
    }
  }

  // log.debug(`getUpdatedPairData:  returning ${pairs.length} updated pairs.`)
  return pairs;
};

// TODO: refactor and combine w/ getRawPairsV2
const getTokensV2 = async (
  fetchAmt: number,
  lastId: string,
  missingDataRetries = 5,
): Promise<any> => {
  const payload = {
    query: `{
      tokens(first: ${fetchAmt}, 
             where: { id_gt: "${lastId}"} ) {
        id
        symbol
        name
        decimals
      }
    }`,
    variables: {},
  };

  let attempt = 0;
  let response: any = undefined;
  while (attempt < missingDataRetries) {
    try {
      attempt++;
      response = await rest.postWithRetry(config.uniswap_v2_graph_url, payload);
    } catch (error) {
      throw new Error('🆘 Failed to fetch data from SushiSwap Graph\n' + error);
    }

    if (response && response.data && response.data.tokens) {
      return response.data;
    } else {
      const _responseStr = JSON.stringify(response);
      const _responseStrShort =
        _responseStr && _responseStr.length
          ? _responseStr.substr(0, 1024)
          : _responseStr;
      log.warn(`Attempt ${attempt} of ${missingDataRetries}.`);
      log.warn(
        'Response from SushiSwap Graph does not contain property "data"\n' +
          `  url: ${config.uniswap_v2_graph_url}\n` +
          `  response: ${_responseStrShort}...\n` +
          `  query: ${JSON.stringify(payload.query)}\n`,
      );
    }
  }
  return undefined;
};

export const fetchAllTokensV2 = async (): Promise<t.Tokens> => {
  let lastId = '';
  let numTokensToGet = 1000;

  const tokenArr: any = [];

  while (numTokensToGet > 0) {
    const rawTokenData: any = await getTokensV2(numTokensToGet, lastId);

    if (!rawTokenData || !rawTokenData.hasOwnProperty('tokens')) {
      throw new Error(
        `🆘 Unexpected request response. No token data received after ` +
          `fetching ${tokenArr.length} tokens.`,
      );
    }

    const { tokens }: any = rawTokenData;
    if (tokens.length < numTokensToGet) {
      // End the loop if less than numTokensToGet received:
      numTokensToGet = 0;
    } else if (tokens.length > 0) {
      lastId = tokens[tokens.length - 1].id;
    }

    tokenArr.push(...tokens);
    log.debug(
      `Received ${tokens.length} tokens (total received ${tokenArr.length}) ...`,
    );
  }

  // Convert from array to object/dictionary storage of pairs based on id
  const _allTokens = new t.Tokens();
  for (const token of tokenArr) {
    _allTokens.addToken(token);
  }

  return _allTokens;
};
