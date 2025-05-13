require('dotenv').config();

module.exports = {
  botToken: process.env.BOT_TOKEN,
  webhookUrl: process.env.WEBHOOK_URL, // Опционально

  mongoURI: process.env.MONGO_URI || 'mongodb://mongodb:27017/remnawave-bot',
  mongoUser: process.env.MONGO_USER,
  mongoPassword: process.env.MONGO_PASSWORD,

  remnawaveApiUrl: process.env.REMNAWAVE_API_URL,
  remnawaveApiToken: process.env.REMNAWAVE_API_TOKEN,
  remnawaveApiCookie: process.env.REMWAVE_API_COOKIE, // Optional

  telegramStarsToken: process.env.TELEGRAM_STARS_TOKEN,
  cryptobotToken: process.env.CRYPTOBOT_TOKEN,

  helpUrl: process.env.HELP_URL,
  channelUrl: process.env.CHANNEL_URL,

  tariffCoefficients: {
    month1: parseFloat(process.env.MONTH_1) || 1,
    month3: parseFloat(process.env.MONTH_3) || 2.5,
    month6: parseFloat(process.env.MONTH_6) || 4.5,
    month12: parseFloat(process.env.MONTH_12) || 7.5,
    gb50: parseFloat(process.env.GB_50) || 100,
    gb100: parseFloat(process.env.GB_100) || 180,
    gb250: parseFloat(process.env.GB_250) || 350,
    gb1000: parseFloat(process.env.GB_1000) || 1000,
    gb5000: parseFloat(process.env.GB_5000) || 4000,
    connections5: parseFloat(process.env.CONNECTIONS_5) || 1,
    connections10: parseFloat(process.env.CONNECTIONS_10) || 1.3,
    connections25: parseFloat(process.env.CONNECTIONS_25) || 1.5,
    connections100: parseFloat(process.env.CONNECTIONS_100) || 2,
  },

  trialEnabled: process.env.TRIAL_ENABLED === 'true',
  trialDuration: parseInt(process.env.TRIAL_DURATION, 10) || 3,
  trialTraffic: parseInt(process.env.TRIAL_TRAFFIC, 10) || 1,
  trialDeviceLimit: parseInt(process.env.TRIAL_DEVICE_LIMIT, 10) || 1,

  referralEnabled: process.env.REFERRAL_ENABLED === 'true',
  referralBonusDays: parseInt(process.env.REFERRAL_BONUS, 10) || 5, // N дней за реферала
};