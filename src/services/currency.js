const axios = require('axios');
const COINGECKO_API_URL = 'https://api.coingecko.com/api/v3';
const CACHE_DURATION_MS = 10 * 60 * 1000; // 10 minutes
const exchangeRatesCache = {
  // Example structure:
  // 'tether_usd': { value: 1.0, lastFetched: 1678886400000 },
  // 'tether_rub': { value: 75.0, lastFetched: 1678886400000 }
};

/**
 * Fetches the current price of a cryptocurrency in USD.
 * @param {string} coinId The CoinGecko ID of the cryptocurrency (e.g., 'bitcoin', 'ethereum', 'tether').
 * @returns {Promise<number|null>} The price in USD, or null if an error occurs.
 */
async function getCryptoPriceInUSD(coinId) {
  const cacheKey = `${coinId}_usd`;
  if (exchangeRatesCache[cacheKey] && (Date.now() - exchangeRatesCache[cacheKey].lastFetched < CACHE_DURATION_MS)) {
    // console.log(`[CurrencyService] Using cached USD price for ${coinId}`);
    return exchangeRatesCache[cacheKey].value;
  }

  try {
    // console.log(`[CurrencyService] Fetching fresh USD price for ${coinId}`);
    const response = await axios.get(`${COINGECKO_API_URL}/simple/price`, {
      params: {
        ids: coinId,
        vs_currencies: 'usd',
      },
    });
    if (response.data && response.data[coinId] && response.data[coinId].usd) {
      const price = response.data[coinId].usd;
      exchangeRatesCache[cacheKey] = { value: price, lastFetched: Date.now() };
      return price;
    }
    console.error(`[CurrencyService] Could not find USD price for ${coinId} in CoinGecko response:`, response.data);
    return null;
  } catch (error) {
    console.error(`[CurrencyService] Error fetching price for ${coinId} from CoinGecko:`, error.message);
    if (error.response) {
      console.error('[CurrencyService] CoinGecko API Error Response:', error.response.data);
    }
    return null;
  }
}

/**
 * Converts an amount from a given cryptocurrency to USD.
 * @param {number} amount The amount of cryptocurrency.
 * @param {string} coinId The CoinGecko ID of the cryptocurrency.
 * @returns {Promise<number|null>} The equivalent amount in USD, or null if conversion fails.
 */
async function convertCryptoToUSD(amount, coinId) {
  const price = await getCryptoPriceInUSD(coinId);
  if (price === null) {
    return null;
  }
  return amount * price;
}

/**
 * Converts an amount from USD to a given cryptocurrency.
 * @param {number} usdAmount The amount in USD.
 * @param {string} coinId The CoinGecko ID of the cryptocurrency.
 * @returns {Promise<number|null>} The equivalent amount in the cryptocurrency, or null if conversion fails.
 */
async function convertUSDToCrypto(usdAmount, coinId) {
  const price = await getCryptoPriceInUSD(coinId);
  if (price === null || price === 0) {
    return null;
  }
  return usdAmount / price;
}

/**
 * Fetches the current price of one asset in terms of another.
 * @param {string} baseAssetId CoinGecko ID of the base asset (e.g., 'tether')
 * @param {string} quoteAssetId CoinGecko ID of the quote asset (e.g., 'rub')
 * @returns {Promise&lt;number|null&gt;} The price of baseAssetId in quoteAssetId, or null.
 */
async function getPairPrice(baseAssetId, quoteAssetId) {
  const cacheKey = `${baseAssetId}_${quoteAssetId}`;
  if (exchangeRatesCache[cacheKey] && (Date.now() - exchangeRatesCache[cacheKey].lastFetched < CACHE_DURATION_MS)) {
    // console.log(`[CurrencyService] Using cached price for ${baseAssetId}/${quoteAssetId}`);
    return exchangeRatesCache[cacheKey].value;
  }

  try {
    // console.log(`[CurrencyService] Fetching fresh price for ${baseAssetId}/${quoteAssetId}`);
    const response = await axios.get(`${COINGECKO_API_URL}/simple/price`, {
      params: {
        ids: baseAssetId,
        vs_currencies: quoteAssetId,
      },
    });
    if (response.data && response.data[baseAssetId] && response.data[baseAssetId][quoteAssetId]) {
      const price = response.data[baseAssetId][quoteAssetId];
      exchangeRatesCache[cacheKey] = { value: price, lastFetched: Date.now() };
      return price;
    }
    console.error(`[CurrencyService] Could not find ${quoteAssetId} price for ${baseAssetId} in CoinGecko response:`, response.data);
    return null;
  } catch (error) {
    console.error(`[CurrencyService] Error fetching price for ${baseAssetId}/${quoteAssetId} from CoinGecko:`, error.message);
    if (error.response) {
      console.error('[CurrencyService] CoinGecko API Error Response:', error.response.data);
    }
    return null;
  }
}

module.exports = {
  getCryptoPriceInUSD,
  convertCryptoToUSD,
  convertUSDToCrypto,
  getPairPrice, // Added
  // Constants for Telegram Stars
  TELEGRAM_STAR_TO_USD_RATE: 0.013,
  COINGECKO_API_URL, // Exported for potential direct use, though encapsulation is preferred
};