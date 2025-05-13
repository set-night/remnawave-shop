const express = require('express');
const crypto = require('crypto');
const bot = require('./bot');
const connectDB = require('./database');
const config = require('./config');
const Payment = require('./database/models/payment'); // For updating payment status
const User = require('./database/models/user'); // For notifying user
const { getLocalizedString } = require('./localization'); // For user notifications

// Connect to MongoDB
connectDB();

const app = express();
// Middleware to parse JSON bodies. CryptoBot sends JSON.
app.use(express.json());
// Middleware to parse URL-encoded bodies (though CryptoBot uses JSON)
app.use(express.urlencoded({ extended: true }));

// --- CryptoBot Webhook Handler ---
// The path for the webhook, e.g., /webhook/cryptobot
const CRYPTOBOT_WEBHOOK_PATH = process.env.CRYPTOBOT_WEBHOOK_PATH || '/payment/cryptobot-status';

app.post(CRYPTOBOT_WEBHOOK_PATH, async (req, res) => {
  console.log('[CryptoBot Webhook] Received request');
  const signature = req.headers['crypto-pay-signature'];
  const body = req.body; // Already parsed by express.json()

  if (!config.cryptobotToken) {
    console.error('[CryptoBot Webhook] CryptoBot API token is not configured.');
    return res.status(500).send('CryptoBot integration not configured.');
  }

  if (!signature || !body) {
    console.warn('[CryptoBot Webhook] Missing signature or body.');
    return res.status(400).send('Bad Request: Missing signature or body.');
  }

  try {
    // Verify the signature
    const secret = crypto.createHash('sha256').update(config.cryptobotToken).digest();
    const checkString = JSON.stringify(body, Object.keys(body).sort()); // Ensure keys are sorted for consistent hashing
    const hmac = crypto.createHmac('sha256', secret).update(checkString).digest('hex');

    if (hmac !== signature) {
      console.warn('[CryptoBot Webhook] Invalid signature.');
      return res.status(403).send('Forbidden: Invalid signature.');
    }

    console.log('[CryptoBot Webhook] Signature verified. Processing update:', body);
    const { update_type, invoice_id, status, amount, asset, fee_asset, fee_amount, pay_url } = body;

    if (update_type === 'invoice_paid') {
      if (status === 'paid') {
        const payment = await Payment.findOne({ paymentId: invoice_id, paymentSystem: 'cryptobot' });

        if (!payment) {
          console.error(`[CryptoBot Webhook] Payment not found for invoice_id: ${invoice_id}`);
          // Acknowledge receipt to CryptoBot even if we can't find the payment,
          // to prevent retries for this specific issue.
          return res.status(200).send('OK - Payment not found internally');
        }

        if (payment.status === 'active' || payment.status === 'completed') {
          console.warn(`[CryptoBot Webhook] Invoice ${invoice_id} already processed. Status: ${payment.status}`);
          return res.status(200).send('OK - Already processed');
        }

        // Verify amount and asset if necessary, though CryptoBot should handle this.
        // payment.amount was stored in crypto (e.g. USDT)
        // body.amount is also in crypto (string)
        const paidAmount = parseFloat(body.amount);
        if (payment.currency !== body.asset || Math.abs(payment.amount - paidAmount) > 0.000001) { // Check asset and amount with tolerance
            console.warn(`[CryptoBot Webhook] Amount or asset mismatch for invoice ${invoice_id}. Expected ${payment.amount} ${payment.currency}, got ${paidAmount} ${body.asset}`);
            // Decide how to handle: update status to 'failed' or 'requires_review'?
            // For now, we'll proceed if CryptoBot says it's paid.
        }

        payment.status = 'active'; // Or 'completed'
        // payment.startDate and payment.endDate were set when invoice was created in buy.js
        payment.updatedAt = new Date();
        await payment.save();

        console.log(`[CryptoBot Webhook] Payment ${invoice_id} successfully updated to ${payment.status}.`);

        // Notify the user
        const user = await User.findOne({ telegramId: payment.userId });
        if (user) {
          const lang = user.languageCode || 'ru';
          const tariffName = payment.tariffId; // Or reconstruct
          const message = getLocalizedString(lang, 'paymentSuccessfulCryptoBot', {
            tariffName: tariffName,
            endDate: payment.endDate.toLocaleDateString(lang === 'ru' ? 'ru-RU' : 'en-US'), // Adjust locale as needed
            traffic: payment.trafficAllocatedGb,
            amount: paidAmount,
            asset: body.asset
          });
          try {
            await bot.telegram.sendMessage(payment.userId, message);
          } catch (e) {
            console.error(`[CryptoBot Webhook] Failed to send success message to user ${payment.userId}:`, e);
          }
        }
        res.status(200).send('OK - Processed');
      } else if (status === 'expired') {
        // Handle expired invoice
        const payment = await Payment.findOneAndUpdate(
          { paymentId: invoice_id, paymentSystem: 'cryptobot', status: 'pending' },
          { $set: { status: 'expired', updatedAt: new Date() } },
          { new: true }
        );
        if (payment) {
          console.log(`[CryptoBot Webhook] Invoice ${invoice_id} expired.`);
           // Notify user if desired
        }
        res.status(200).send('OK - Expired');
      } else {
        console.log(`[CryptoBot Webhook] Received unhandled status '${status}' for invoice ${invoice_id}.`);
        res.status(200).send('OK - Status not handled');
      }
    } else {
      console.log(`[CryptoBot Webhook] Received unhandled update_type: ${update_type}`);
      res.status(200).send('OK - Update type not handled');
    }
  } catch (error) {
    console.error('[CryptoBot Webhook] Error processing webhook:', error);
    res.status(500).send('Internal Server Error');
  }
});

// --- Bot Launching ---
const PORT = process.env.PORT || 3000;

if (config.webhookUrl) {
  // Production mode: use webhook
  // Telegraf will use the same Express app instance for its webhook.
  // The path for Telegraf webhook should be different from CryptoBot webhook.
  // Telegraf generates a random path by default if not specified, or uses /telegraf/<BOT_TOKEN_HASH>
  // We can set a specific path for Telegraf webhook.
  const telegrafWebhookPath = `/telegraf/${bot.secretPathComponent()}`; // Or a custom path
  
  app.use(bot.webhookCallback(telegrafWebhookPath)); // Telegraf handles its own webhook path
  bot.telegram.setWebhook(`${config.webhookUrl}${telegrafWebhookPath}`)
    .then(() => {
      console.log(`Bot webhook set to ${config.webhookUrl}${telegrafWebhookPath}`);
      app.listen(PORT, () => {
        console.log(`Express server listening on port ${PORT}`);
        console.log(`CryptoBot webhook endpoint: ${config.webhookUrl}${CRYPTOBOT_WEBHOOK_PATH}`);
        console.log('Bot started in webhook mode via Express.');
      });
    })
    .catch(err => {
      console.error('Failed to set Telegraf webhook or start Express server:', err);
      // Fallback to polling if webhook setup fails? Or exit?
      console.log('Attempting to start in polling mode as a fallback...');
      bot.launch().then(() => console.log('Bot started in polling mode (fallback).'))
                 .catch(pollErr => console.error('Fallback polling mode failed:', pollErr));
    });
} else {
  // Development mode: use polling for Telegraf, but still run Express for CryptoBot webhook
  bot.launch()
    .then(() => {
      console.log('Bot started in polling mode');
      app.listen(PORT, () => {
        console.log(`Express server listening on port ${PORT} for CryptoBot webhooks.`);
        console.log(`CryptoBot webhook endpoint should be configured to: http://<YOUR_PUBLIC_IP_OR_DOMAIN>:${PORT}${CRYPTOBOT_WEBHOOK_PATH}`);
        console.log('Note: For CryptoBot webhooks in dev, you might need a tunneling service like ngrok.');
      });
    })
    .catch(err => console.error('Failed to launch bot in polling mode or start Express server:', err));
}

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));