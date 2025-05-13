const axios = require('axios');
const config = require('../config');
const { v4: uuidv4 } = require('uuid');

const apiClient = axios.create({
  baseURL: config.remnawaveApiUrl,
  headers: {
    'Content-Type': 'application/json',
    // Authorization header будет добавляться по-разному:
    // для некоторых запросов может не требоваться,
    // для других - токен пользователя, для третьих - глобальный API токен.
  },
  timeout: 10000, // 10 секунд
});

// Interceptor для добавления глобального API токена, если он есть и нужен
// Этот токен может использоваться для административных действий или если API так спроектировано
apiClient.interceptors.request.use(
  (axiosConfig) => {
    // Add Authorization header if remnawaveApiToken is configured
    // This is now handled per-request for more flexibility, but an interceptor could be used
    // if all or most requests to this baseURL need it.

    // Add Cookie header if remnawaveApiCookie is configured
    if (config.remnawaveApiCookie) {
      axiosConfig.headers['Cookie'] = config.remnawaveApiCookie;
    }
    return axiosConfig;
  },
  (error) => {
    return Promise.reject(error);
  }
);

apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    // Логирование ошибок или специфическая обработка
    console.error('API Call Error:', error.response ? error.response.data : error.message);
    // Можно выбросить кастомную ошибку или обработать ее здесь
    return Promise.reject(error);
  }
);

/**
 * Creates or updates a user in Remnawave panel.
 * @param {object} userData - Data for the user.
 * @param {string} userData.username - Username for Remnawave (e.g., "user_TELEGRAMID").
 * @param {number} userData.telegramId - User's Telegram ID.
 * @param {string} userData.expireAt - Subscription expiration date in ISO format.
 * @param {number} userData.trafficLimitGb - Data limit in GB.
 * @param {number} userData.hwidDeviceLimit - Device limit.
 * @param {string} [userData.status="ACTIVE"] - User status.
 * @param {string} [userData.trafficLimitStrategy="NO_RESET"] - Traffic limit strategy.
 * @param {boolean} [userData.activateAllInbounds=true] - Whether to activate all inbounds.
 * @param {string} [userData.description=""] - Description for the user.
 * @param {string} [userData.email=null] - User's email.
 * @param {string} [userData.tag=null] - User's tag.
 * @returns {Promise<object>} The API response from Remnawave.
 */
const createRemnawaveUser = async (userData) => {
  if (!config.remnawaveApiUrl) {
    console.error('Remnawave API URL is not configured.');
    return { success: false, message: 'Remnawave API URL is not configured.' };
  }
  if (!config.remnawaveApiToken) {
    console.error('Remnawave API token is not configured.');
    return { success: false, message: 'Remnawave API token is not configured.' };
  }

  // Validate required fields based on openapi.json
  if (!userData.username || !userData.expireAt || userData.telegramId === undefined) {
    console.error('Missing required fields for creating Remnawave user (username, expireAt, telegramId):', userData);
    return { success: false, message: 'Missing required fields: username, expireAt, telegramId.' };
  }
  if (userData.username.length < 6 || userData.username.length > 34 || !/^[a-zA-Z0-9_-]+$/.test(userData.username)) {
    console.error('Invalid username format or length:', userData.username);
    return { success: false, message: 'Invalid username format or length (6-34 chars, a-z, A-Z, 0-9, _, -).' };
  }

  const trafficLimitBytes = userData.trafficLimitGb !== undefined ? userData.trafficLimitGb * 1024 * 1024 * 1024 : 0;

  // Generate required UUIDs and passwords
  const crypto = require('crypto');
  
  const subscriptionUuid = uuidv4();
  const shortUuid = crypto.randomBytes(8).toString('hex');
  const vlessUuid = uuidv4();
  const trojanPassword = crypto.randomBytes(12).toString('hex');
  const ssPassword = crypto.randomBytes(12).toString('hex');

  // Parse INBOUND_UUIDS from config if available
  const inboundUuids = config.inboundUuids ?
    config.inboundUuids.split(',').map(uuid => uuid.trim()) :
    [];

  const activeInbounds = inboundUuids.map(uuid => ({
    uuid: uuid,
    tag: `Inbound-${uuid.substring(0, 8)}`,
    type: "vless",
    network: "tcp",
    security: "reality"
  }));

  const payload = {
    username: userData.username || `user${userData.telegramId}_${Math.random().toString(36).substring(2, 8)}`,
    status: userData.status || 'ACTIVE',
    subscriptionUuid: subscriptionUuid,
    shortUuid: shortUuid,
    trojanPassword: trojanPassword,
    vlessUuid: vlessUuid,
    ssPassword: ssPassword,
    trafficLimitBytes: trafficLimitBytes,
    trafficLimitStrategy: userData.trafficLimitStrategy || 'NO_RESET',
    activeUserInbounds: activeInbounds,
    expireAt: userData.expireAt, // ISO string "2025-01-17T15:38:45.065Z"
    description: userData.description || '',
    tag: "SHOP",
    telegramId: parseInt(userData.telegramId, 10),
    email: userData.email || 'no-email@example.com', // Provide default email if null
    hwidDeviceLimit: userData.hwidDeviceLimit !== undefined ? parseInt(userData.hwidDeviceLimit, 10) : 1,
    activateAllInbounds: userData.activateAllInbounds !== undefined ? userData.activateAllInbounds : true,
  };

  try {
    console.log('[API] Calling createRemnawaveUser with payload:', JSON.stringify(payload, null, 2));
    // The endpoint is /api/users as per openapi.json and user's example
    const response = await apiClient.post('/api/users', payload, {
      headers: {
        'Authorization': `Bearer ${config.remnawaveApiToken}`,
        'Content-Type': 'application/json',
      }
    });
    
    console.log('[API] Remnawave user creation/update response:', response.data);
    // Assuming success if status is 200-299. openapi.json specifies 201 for creation.
    if (response.status === 201 || response.status === 200) {
         // Extract the user UUID from the response, which is crucial for future updates or references.
        // Based on CreateUserResponseDto, it should be in response.data.response.uuid
        const createdOrUpdatedUser = response.data && response.data.response ? response.data.response : response.data;
        return { success: true, data: createdOrUpdatedUser };
    } else {
        // Handle non-2xx responses that are not thrown as errors by axios (if any custom handling)
        console.error('Error creating/updating Remnawave user, non-2xx status:', response.status, response.data);
        return { success: false, message: `Remnawave API returned status ${response.status}`, data: response.data };
    }

  } catch (error) {
    const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
    console.error('Error creating/updating Remnawave user:', errorMessage);
    // Pass along the error response data if available, it might contain useful info from the panel
    return { success: false, message: `Failed to create/update Remnawave user: ${errorMessage}`, errorData: error.response ? error.response.data : null };
  }
};


/**
 * Fetches subscriptions for a given Telegram ID from Remnawave API.
 * @param {string|number} telegramId - The Telegram ID of the user.
 * @returns {Promise<Array<object>>} A promise that resolves to an array of subscription objects.
 */
const getRemnawaveSubscriptionsByTelegramId = async (telegramId) => {
  if (!config.remnawaveApiToken) {
    console.error('Remnawave API token is not configured.');
    // Depending on desired behavior, could return empty array or throw error
    return []; 
  }
  if (!telegramId) {
    console.error('Telegram ID is required to fetch subscriptions.');
    return [];
  }

  try {
    // Corrected endpoint based on openapi.json
    const response = await apiClient.get(`/api/users/by-telegram-id/${telegramId}`, {
      headers: {
        'Authorization': `Bearer ${config.remnawaveApiToken}`,
        'Accept': 'application/json' // Explicitly request JSON
      }
    });

    const contentType = response.headers['content-type'];

    if (!contentType || !contentType.includes('application/json')) {
      return [];
    }

    // Log the JSON response if Content-Type is correct
    
    // According to GetUserByTelegramIdResponseDto, response.data.response is an array of user objects.
    if (response.data && response.data.response && Array.isArray(response.data.response)) {
      return response.data.response; // Returns an array of user objects
    }
    
    return []; // Return empty array if data is not in expected structure
  } catch (error) {
    console.error(`Error fetching subscriptions for telegramId ${telegramId} from Remnawave:`, error.response ? error.response.data : error.message);
    return []; // Return empty array on error to prevent scene crash
  }
};

// Другие функции для работы с API Remnawave (получение подписок, продление и т.д.)
// будут добавлены по мере необходимости.

module.exports = {
  apiClient,
  createRemnawaveUser, // Renamed from createRemnawaveSubscription
  getRemnawaveSubscriptionsByTelegramId,
  // ... другие экспортируемые функции
};