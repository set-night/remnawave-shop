const { Telegraf, Markup, session, Scenes } = require('telegraf'); // Added session and Scenes
const LocalSession = require('telegraf-session-local'); // Added LocalSession
const config = require('./config');
const { getLocalizedString, supportedLanguages } = require('./localization');
const User = require('./database/models/user');
const Payment = require('./database/models/payment'); // Added Payment model
const { createRemnawaveUser, getRemnawaveSubscriptionsByTelegramId } = require('./api');
const currencyService = require('./services/currency'); // Added currency service
// Импортируем функции, которые создают сцены, передавая им showMainMenu
const createTrialScene = require('./scenes/trial');
const createBuyScene = require('./scenes/buy');
const bot = new Telegraf(config.botToken);

// Initialize scenes
const trialScene = createTrialScene(showMainMenu);
const buyScene = createBuyScene(showMainMenu);

const stage = new Scenes.Stage([trialScene, buyScene]);

// Initialize session middleware
bot.use((new LocalSession({ database: 'sessions_db.json' })).middleware()); // Changed filename to avoid conflict if sessions.json is used elsewhere

// Middleware для выбора языка (по умолчанию русский) и сохранения данных пользователя
// Этот middleware должен быть ПЕРЕД stage.middleware(), чтобы ctx.i18n и ctx.dbUser были доступны в сценах
bot.use(async (ctx, next) => {
  ctx.session.language = ctx.session.language || ctx.from?.language_code || 'ru';
  // Ensure language is one of supported, e.g. 'ru' or 'en'
  if (!['ru', 'en'].includes(ctx.session.language)) {
    ctx.session.language = 'ru';
  }
  ctx.i18n = (key, params) => getLocalizedString(ctx.session.language, key, params);

  if (ctx.from) {
    try {
      const userData = {
        firstName: ctx.from.first_name,
        lastName: ctx.from.last_name,
        username: ctx.from.username,
        languageCode: ctx.session.language,
        isBot: ctx.from.is_bot,
      };

      const updateData = {
        $set: userData,
        $setOnInsert: { // These fields are set only on creation
          telegramId: ctx.from.id,
          referralCode: `REF-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`,
          createdAt: new Date(), // Mongoose default works, but explicit is fine
        }
      };
      
      // Atomically find and update or create user
      const user = await User.findOneAndUpdate(
        { telegramId: ctx.from.id },
        updateData,
        { new: true, upsert: true, setDefaultsOnInsert: true }
      );

      if (user) {
        // console.log(`User upserted: ${user.username || user.telegramId}`);
        ctx.dbUser = user; // Make user object available in context
      } else {
        // This case should ideally not be reached with upsert:true
        console.error('User upsert failed for telegramId:', ctx.from.id);
      }

    } catch (error) {
      console.error('Error in user middleware (findOneAndUpdate):', error);
      if (error.code === 11000) { // Duplicate key error, should be handled by findOneAndUpdate but good to log
          console.warn(`Attempted to insert duplicate telegramId: ${ctx.from.id}. findOneAndUpdate should prevent this.`);
          // Try to fetch the user again if upsert somehow failed to return it or if there was a race condition before this logic
          const existingUser = await User.findOne({ telegramId: ctx.from.id });
          if (existingUser) ctx.dbUser = existingUser;
      }
      // Decide if you want to stop execution or inform user
    }
  }

  await next();
});

bot.use(stage.middleware()); // Register stage middleware AFTER custom i18n/user middleware

// Функция для отображения главного меню
async function showMainMenu(ctx) {
  // Удаляем предыдущую reply-клавиатуру, если она была
  // Отправляем короткое сообщение с removeKeyboard, затем основное меню.
  // Это гарантирует, что если предыдущее сообщение было с reply-клавиатурой, она исчезнет.
  // Убираем явную отправку сообщения для удаления ReplyKeyboardMarkup.
  // Отправка нового сообщения с InlineKeyboardMarkup обычно сама убирает ReplyKeyboard.

  let mainMenuText = ctx.i18n('mainMenuMessage') || ctx.i18n('welcomeMessage');
  if (ctx.dbUser && typeof ctx.dbUser.balance === 'number') {
    mainMenuText += `\n\nВаш баланс: $${ctx.dbUser.balance.toFixed(2)}`;
  }
  // Если пользователь — админ, добавить справку по админ-командам
  const adminIds = (config.botAdmins || []).map(id => String(id));
  if (ctx.from && adminIds.includes(String(ctx.from.id))) {
    mainMenuText += `\n\n<b>Админ-команды:</b>\n/admin_balance user_id amount — выдать баланс пользователю по ID`;
  }
  const mainMenuKeyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(ctx.i18n('buyButton'), 'enter_buy_scene'),
      Markup.button.callback(ctx.i18n('trialButton'), 'enter_trial_scene')
    ],
    [Markup.button.callback(ctx.i18n('mySubscriptionsButton'), 'enter_subscriptions_scene')],
    [Markup.button.callback(ctx.i18n('referralProgramButton'), 'enter_referral_scene')],
    [
      Markup.button.callback(ctx.i18n('helpButton'), 'enter_help_scene'),
      Markup.button.url(ctx.i18n('channelButton'), config.channelUrl || 'https://t.me/your_channel')
    ]
  ]);
  // Удаляем предыдущее сообщение бота, если это был callback_query от инлайн кнопки, чтобы "обновить" меню
  if (ctx.callbackQuery && ctx.callbackQuery.message) {
    try {
        await ctx.editMessageText(mainMenuText, {
          parse_mode: 'HTML',
          ...mainMenuKeyboard
        });
      // Answer the callback query to remove the "loading" state from the button
      await ctx.answerCbQuery().catch(e => console.warn("Error answering CB query after edit:", e.message));
    } catch (e) {
      console.warn("Could not edit previous message (e.g., message not modified or too old), sending new one as fallback:", e.message);
      // Fallback: If editing fails, delete the old message (if possible) and send a new one.
      // This handles cases like "Bad Request: message is not modified"
      try {
        // Attempt to delete only if the error is NOT "message is not modified"
        // as in that case, the message still exists and should be replaced.
        // However, for simplicity and to avoid complex error checking here,
        // we'll try to delete and then reply, similar to original fallback.
        await ctx.deleteMessage(ctx.callbackQuery.message.message_id);
      } catch (delErr) {
        // Log if deletion fails, but proceed to reply with a new message.
        console.warn("Could not delete message during edit fallback:", delErr.message);
      }
        await ctx.reply(mainMenuText, {
          parse_mode: 'HTML',
          ...mainMenuKeyboard
        });
    }
  } else {
    // If not a callback query (e.g. /start or a command), or no message associated with callback
      await ctx.reply(mainMenuText, {
        parse_mode: 'HTML',
        ...mainMenuKeyboard
      });
  }
}

bot.start(async (ctx) => {
  // If the user is in a scene, leave it first
  if (ctx.scene && ctx.scene.current) {
    await ctx.scene.leave();
    // Сообщение о выходе из сцены можно убрать, так как сразу будет главное меню
  }
  // Удаляем предыдущую клавиатуру и отправляем приветственное сообщение с инлайн-меню
  // Markup.removeKeyboard() удалит reply-клавиатуру, если она была.
  // Markup.inlineKeyboard создаст новое инлайн-меню.

  const startPayload = ctx.startPayload;
  const currentUser = ctx.dbUser; // User from our middleware

  if (startPayload && currentUser && !currentUser.referredBy && !currentUser.trialUsed) { // Check if not already referred and not used trial
    // Payload likely contains a referral code
    const referringUser = await User.findOne({ referralCode: startPayload });
    if (referringUser && referringUser.telegramId !== currentUser.telegramId) {
      currentUser.referredBy = referringUser.telegramId;
      await currentUser.save();

  referringUser.balance = (referringUser.balance || 0) + config.referralBonusAmount;
  referringUser.referralEarnings = (referringUser.referralEarnings || 0) + config.referralBonusAmount;
      await referringUser.save();

      await ctx.reply(ctx.i18n('welcomeReferredMessage', { referrerName: referringUser.firstName || referringUser.username || referringUser.telegramId.toString() }));

      // Notify the referring user
      try {
        await ctx.telegram.sendMessage(referringUser.telegramId, ctx.i18n('referralSuccessfulNotification', {
          referredUserName: currentUser.firstName || currentUser.username || currentUser.telegramId.toString(),
          bonusAmount: config.referralBonusAmount,
          totalBalance: referringUser.balance.toFixed(2)
        }));
      } catch (e) {
        console.error(`Failed to send referral notification to ${referringUser.telegramId}`, e);
      }
    }
  }

  // TODO: Implement language selection on first start if not set by TG client
  
  // Показываем главное меню
  await showMainMenu(ctx);
});

// Команда для админов: /balanceAdd <user_id> <amount>
bot.command('balanceAdd', async (ctx) => {
  const adminIds = (config.botAdmins || []).map(id => String(id));
  if (!ctx.from || !adminIds.includes(String(ctx.from.id))) {
    return ctx.reply('⛔️ У вас нет прав для этой команды.');
  }
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length !== 2) {
    return ctx.reply('Использование: /balanceAdd <user_id> <amount>');
  }
  const [userId, amountStr] = args;
  const amount = parseFloat(amountStr);
  if (isNaN(amount) || amount <= 0) {
    return ctx.reply('Сумма должна быть положительным числом.');
  }
  const user = await User.findOne({ telegramId: Number(userId) });
  if (!user) {
    return ctx.reply('Пользователь с таким ID не найден.');
  }
  user.balance = (user.balance || 0) + amount;
  await user.save();
  await ctx.reply(`Пользователю ${userId} успешно начислено $${amount.toFixed(2)}. Новый баланс: $${user.balance.toFixed(2)}`);
});

// Action handlers for inline menu buttons
// Simple command handlers
bot.action('enter_buy_scene', Scenes.Stage.enter('buyScene'));
bot.action('enter_trial_scene', Scenes.Stage.enter('trialScene'));

bot.action('enter_subscriptions_scene', async (ctx) => {
  try {
    // Answer callback query immediately to avoid timeout
    await ctx.answerCbQuery();
    const user = ctx.dbUser;
    
    // Получаем подписки из VPN панели
    const result = await getRemnawaveSubscriptionsByTelegramId(user.telegramId);
    const subscriptions = result || [];
    
    let message = `<b>${ctx.i18n('yourSubscriptionsTitle')}</b>`;
    if (!subscriptions || subscriptions.length === 0) {
    message += `\n\n<i>${ctx.i18n('noActiveSubscriptions')}</i>`;
  } else {
    // Фильтруем активные подписки, сортируем по дате окончания (новые сверху)
    const activeSubs = subscriptions
      .filter(sub => sub.status === 'ACTIVE')
      .sort((a, b) => new Date(b.expireAt) - new Date(a.expireAt));
    
    // Форматируем каждую подписку
    activeSubs.forEach(sub => {
      const usedGB = Math.floor(sub.usedTrafficBytes / (1024 * 1024 * 1024));
      const totalGB = sub.trafficLimitBytes > 0 ?
        Math.floor(sub.trafficLimitBytes / (1024 * 1024 * 1024)) : '∞';
        
      message += `\n\n<blockquote>${ctx.i18n('subscriptionDetailsEntry', {
        tariffName: sub.username || 'Без названия',
        status: 'Активна ✅',
        startDate: new Date(sub.createdAt).toLocaleDateString(ctx.session.language === 'ru' ? 'ru-RU' : 'en-US'),
        endDate: new Date(sub.expireAt).toLocaleDateString(ctx.session.language === 'ru' ? 'ru-RU' : 'en-US'),
        traffic: `${usedGB}/${totalGB} ГБ`,
        subscriptionUrl: sub.subscriptionUrl || ctx.i18n('notApplicable')
      })}</blockquote>`;
    });
  }

  await ctx.editMessageText(message, {
     parse_mode: 'HTML',
     disable_web_page_preview: true,
     ...Markup.inlineKeyboard([
       [Markup.button.callback(ctx.i18n('backButton'), 'back_to_menu')]
     ])
  });
} catch (error) {
  console.error('Error in enter_subscriptions_scene:', error);
  // Attempt to use i18n for error message, fallback if not available
  const errorMessage = ctx.i18n ? ctx.i18n('errorMessage') : "An error occurred while fetching your subscriptions.";
  // Check if we can reply or edit
  if (ctx.callbackQuery) { // If it's a callback, try to edit the message or send a new one
    try {
      await ctx.editMessageText(errorMessage, Markup.inlineKeyboard([
        [Markup.button.callback(ctx.i18n ? ctx.i18n('backButton') : 'Back', 'back_to_menu')]
      ]));
    } catch (editError) {
      console.error('Failed to edit message with error in subscriptions scene:', editError);
      await ctx.reply(errorMessage); // Fallback to sending a new message
    }
  } else {
    await ctx.reply(errorMessage); // If not a callback, just reply
  }
}
});

bot.action('enter_referral_scene', async (ctx) => {
  await ctx.answerCbQuery();
  const user = ctx.dbUser;
  
  const message = ctx.i18n('referralProgramDetails', {
    referralCode: user.referralCode,
    referralLink: `https://t.me/${ctx.botInfo.username}?start=${user.referralCode}`,
    bonusDays: config.referralBonusDays,
    accumulatedDays: user.accumulatedReferralDays || 0
  });

  await ctx.editMessageText(message, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback(ctx.i18n('backButton'), 'back_to_menu')]
    ])
  });
});

bot.action('enter_help_scene', async (ctx) => {
  await ctx.answerCbQuery();

  const message = ctx.i18n('helpSceneMessage', {
    botUsername: ctx.botInfo.username,
    helpChannelUrl: config.helpChannelUrl || ctx.i18n('notConfigured'),
    mainChannelUrl: config.mainChannelUrl || ctx.i18n('notConfigured')

  });

  await ctx.editMessageText(message, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback(ctx.i18n('backButton'), 'back_to_menu'), Markup.button.url(ctx.i18n('helpButton'), config.helpUrl || 'https://t.me/your_channel')]
    ])
  });
});

bot.action('back_to_menu', async (ctx) => {
  await ctx.answerCbQuery();
  await showMainMenu(ctx);
});

// The 'channelButton' is now a URL button, so no specific action handler is needed here for it,
// unless you want to track clicks or do something else before redirecting.
// If config.channelUrl is not set, the button will point to a default placeholder.
// It's better to ensure config.channelUrl is always set.
const axios = require('axios'); // Ensure axios is required if not already at the top

// --- Command to check pending CryptoBot payments ---
bot.command('check_crypto_payments', async (ctx) => {
  if (!config.cryptobotToken) {
    return ctx.reply(ctx.i18n('cryptoBotNotConfiguredError', 'CryptoBot integration is not configured.'));
  }

  const userId = ctx.from.id;
  const pendingPayments = await Payment.find({
    userId: userId,
    paymentSystem: 'cryptobot',
    status: 'pending'
  }).sort({ createdAt: -1 }).limit(5); // Check last 5 pending invoices

  if (pendingPayments.length === 0) {
    return ctx.reply(ctx.i18n('noPendingCryptoBotPayments', 'You have no pending CryptoBot payments to check.'));
  }

  await ctx.reply(ctx.i18n('checkingCryptoBotPayments', { count: pendingPayments.length }));

  let updatedCount = 0;
  for (const payment of pendingPayments) {
    try {
      const response = await axios.get('https://pay.crypt.bot/api/getInvoices', {
        headers: { 'Crypto-Pay-API-Token': config.cryptobotToken },
        params: { invoice_ids: payment.paymentId } // paymentId here is CryptoBot's invoice_id
      });

      if (response.data && response.data.ok && response.data.result && response.data.result.items && response.data.result.items.length > 0) {
        const invoiceDetails = response.data.result.items[0];
        if (invoiceDetails.status === 'paid' && payment.status === 'pending') {
          payment.status = 'active'; // Or 'completed'
          payment.updatedAt = new Date();
          // Ensure startDate and endDate are correctly set if they weren't upon creation
          if (!payment.startDate) payment.startDate = new Date();
          if (!payment.endDate) {
              // This part is tricky as duration might not be easily available here.
              // It's better to ensure endDate is always set when payment record is first created.
              // For now, let's assume it was set. If not, this logic needs enhancement
              // or the payment record structure needs to store duration/tariff details.
              console.warn(`[CheckPayments] endDate was not set for payment ${payment._id}. This should be set at creation.`);
          }
          await payment.save();
          
          // Списываем баланс если был включен режим скидки
          if (payment.useBalance && payment.balanceUsed > 0) {
            const user = await User.findOne({ telegramId: payment.userId });
            if (user) {
              user.balance = Math.max(0, user.balance - payment.balanceUsed);
              await user.save();
              console.log(`[CheckPayments] Deducted $${payment.balanceUsed} from user ${user.telegramId} balance after CryptoBot payment`);
            }
          }

          // Создаём пользователя в Remnawave если его нет
          const user = await User.findOne({ telegramId: payment.userId });
          if (user) {
            let remnawaveUserId = user.remnawaveUserId;
            if (!remnawaveUserId) {
              try {
                const tariffParts = payment.tariffId.split('_');
                const deviceLimitPart = tariffParts.find(part => part.endsWith('dev'));
                const hwidDeviceLimit = deviceLimitPart ? parseInt(deviceLimitPart.replace('dev', ''), 10) : 1;

                // Создаём уникальное имя в формате user{telegramId}_{короткий_суффикс}
                // Ограничиваем длину до 34 символов для соответствия требованиям Remnawave
                const shortSuffix = Math.random().toString(36).substring(2, 6); // 4 символа
                const baseUsername = `user${user.telegramId}`;
                const usernameForPanel = baseUsername.length + shortSuffix.length + 1 <= 34 
                  ? `${baseUsername}_${shortSuffix}`
                  : `u${user.telegramId}_${shortSuffix}`; // Укороченная версия если слишком длинно

                const userDataForRemnawave = {
                  username: usernameForPanel,
                  telegramId: user.telegramId,
                  expireAt: payment.endDate.toISOString(),
                  trafficLimitGb: payment.trafficAllocatedGb,
                  hwidDeviceLimit: hwidDeviceLimit,
                  status: 'ACTIVE',
                  trafficLimitStrategy: 'NO_RESET',
                  activateAllInbounds: true,
                  description: `Payment ID: ${payment._id.toString()}; Tariff: ${payment.tariffId}; Method: CryptoBot`,
                };

                const remnaApiResponse = await createRemnawaveUser(userDataForRemnawave);

                if (remnaApiResponse.success && remnaApiResponse.data && remnaApiResponse.data.uuid) {
                  remnawaveUserId = remnaApiResponse.data.uuid;
                  user.remnawaveUserId = remnawaveUserId;
                  await user.save();
                  payment.remnawaveUserId = remnawaveUserId;
                  await payment.save();
                  console.log(`[CheckPayments] Remnawave user ${remnawaveUserId} created for TG User ${user.telegramId}.`);
                } else {
                  console.error(`[CheckPayments] Failed to create Remnawave user for TG ID ${user.telegramId}:`, remnaApiResponse.message, remnaApiResponse.errorData);
                }
              } catch (error) {
                console.error(`[CheckPayments] Exception during Remnawave user creation for ${user.telegramId}:`, error);
              }
            } else {
              // Пользователь уже есть, возможно нужно обновить подписку
              if (!payment.remnawaveUserId) {
                payment.remnawaveUserId = remnawaveUserId;
                await payment.save();
              }
            }
          }
          
          updatedCount++;

          // Notify user
          const lang = ctx.dbUser?.languageCode || ctx.session?.language || 'ru';
          const tariffName = payment.tariffId;
          const message = getLocalizedString(lang, 'paymentSuccessfulCryptoBot', {
            tariffName: tariffName,
            endDate: payment.endDate ? payment.endDate.toLocaleDateString(lang === 'ru' ? 'ru-RU' : 'en-US') : 'N/A',
            traffic: payment.trafficAllocatedGb,
            amount: parseFloat(invoiceDetails.amount),
            asset: invoiceDetails.asset
          });
          await ctx.telegram.sendMessage(userId, message, { parse_mode: 'HTML' });
          await ctx.reply(ctx.i18n('paymentManuallyConfirmed', { invoiceId: payment.paymentId, status: invoiceDetails.status }));

        } else if (invoiceDetails.status === 'expired' && payment.status === 'pending') {
            payment.status = 'expired';
            payment.updatedAt = new Date();
            await payment.save();
            await ctx.reply(ctx.i18n('paymentManuallyExpired', { invoiceId: payment.paymentId }));
            updatedCount++;
        } else if (payment.status === 'pending' && invoiceDetails.status !== 'pending') {
            // If status changed to something else we didn't explicitly handle (e.g. 'cancelled')
            // For simplicity, we can mark it based on CryptoBot's status or leave as pending if unsure.
            // Or, add more specific handling.
            console.log(`[CheckPayments] Invoice ${payment.paymentId} status is ${invoiceDetails.status} on CryptoBot, was ${payment.status}.`);
        }
      } else {
        console.error(`[CheckPayments] Could not get details for invoice ${payment.paymentId} from CryptoBot or no items returned. Response:`, response.data);
      }
    } catch (error) {
      console.error(`[CheckPayments] Error checking invoice ${payment.paymentId}:`, error.response ? error.response.data : error.message);
      await ctx.reply(ctx.i18n('errorCheckingSpecificPayment', { invoiceId: payment.paymentId }));
    }
  }

  if (updatedCount > 0) {
    await ctx.reply(ctx.i18n('cryptoBotPaymentsCheckCompletedUpdated', { count: updatedCount }));
  } else {
    await ctx.reply(ctx.i18n('cryptoBotPaymentsCheckCompletedNoUpdates'));
  }
});

// --- Telegram Stars Payment Handlers ---

// Handle PreCheckoutQuery: Required to confirm the order with Telegram.
bot.on('pre_checkout_query', async (ctx) => {
  const preCheckoutQuery = ctx.preCheckoutQuery;
  console.log('Received PreCheckoutQuery:', preCheckoutQuery);

  // The payload should be our internal_payment_id
  const internalPaymentId = preCheckoutQuery.invoice_payload;

  if (!internalPaymentId) {
    console.error('PreCheckoutQuery missing invoice_payload.');
    return ctx.answerPreCheckoutQuery(false, 'Internal payment identifier missing.');
  }

  try {
    // Verify the payment still exists and is in a pending state for Stars
    const payment = await Payment.findById(internalPaymentId);
    if (!payment || payment.paymentSystem !== 'telegram_stars' || payment.status !== 'pending_stars_invoice') {
      console.error(`Payment not found or invalid state for PreCheckoutQuery. ID: ${internalPaymentId}, Status: ${payment?.status}, System: ${payment?.paymentSystem}`);
      let userMessage = ctx.i18n ? ctx.i18n('paymentErrorPreCheckoutGeneric') : 'There was an issue validating your payment. Please try again or contact support.';
      if (payment && payment.status !== 'pending_stars_invoice') {
          userMessage = ctx.i18n ? ctx.i18n('paymentErrorPreCheckoutAlreadyProcessed') : 'This payment may have already been processed or cancelled.';
      }
      return ctx.answerPreCheckoutQuery(false, userMessage);
    }

    // All checks passed, confirm the pre-checkout query
    await ctx.answerPreCheckoutQuery(true);
    console.log(`PreCheckoutQuery for ${internalPaymentId} answered successfully.`);
  } catch (error) {
    console.error('Error processing PreCheckoutQuery:', error);
    const errorMessage = ctx.i18n ? ctx.i18n('paymentErrorPreCheckoutException') : 'An server error occurred while validating your payment. Please try again.';
    await ctx.answerPreCheckoutQuery(false, errorMessage);
  }
});

// Handle SuccessfulPayment: This is sent after the user successfully pays.
bot.on('successful_payment', async (ctx) => {
  const successfulPayment = ctx.message.successful_payment;
  console.log('Received SuccessfulPayment:', successfulPayment);

  const internalPaymentId = successfulPayment.invoice_payload;
  const telegramChargeId = successfulPayment.telegram_payment_charge_id;
  // const providerPaymentChargeId = successfulPayment.provider_payment_charge_id; // Usually same as telegram_payment_charge_id for Stars

  if (!internalPaymentId) {
    console.error('SuccessfulPayment missing invoice_payload.');
    // Cannot do much here other than log, as this is not a query to answer.
    return;
  }

  try {
    const payment = await Payment.findById(internalPaymentId);
    if (!payment) {
      console.error(`Payment not found for SuccessfulPayment. Internal ID: ${internalPaymentId}`);
      // Attempt to inform user if possible, though this is an async notification
      await ctx.reply(ctx.i18n ? ctx.i18n('paymentErrorSuccessfulPaymentNotFound') : 'We received your payment, but had trouble finding the order. Please contact support with this ID: ' + telegramChargeId);
      return;
    }

    if (payment.status === 'active' || payment.status === 'completed') {
        console.warn(`Payment ${internalPaymentId} already marked as ${payment.status}. Ignoring duplicate SuccessfulPayment.`);
        await ctx.reply(ctx.i18n ? ctx.i18n('paymentAlreadyCompleted') : 'Your payment was already processed. Thank you!');
        return;
    }
    
    if (payment.paymentSystem !== 'telegram_stars') {
        console.error(`Payment ${internalPaymentId} is not a Telegram Stars payment. System: ${payment.paymentSystem}`);
        await ctx.reply(ctx.i18n ? ctx.i18n('paymentErrorSystemMismatch') : 'There was an issue with the payment system. Please contact support.');
        return;
    }

    // Update payment record
    payment.status = 'active'; // Or 'completed'
    payment.paymentId = telegramChargeId; // Store Telegram's charge ID
    // payment.startDate is already set from buy.js
    // payment.endDate is already set from buy.js
    payment.updatedAt = new Date();
    await payment.save();

    const user = await User.findOne({ telegramId: payment.userId });
    if (user) {
      // Списываем баланс, если он использовался как скидка
      console.log(`[SuccessfulPayment Stars] Checking balance deduction: useBalance=${payment.useBalance}, balanceUsed=${payment.balanceUsed}, userBalance=${user.balance}`);
      if (payment.useBalance && payment.balanceUsed > 0) {
        const oldBalance = user.balance;
        user.balance = Math.max(0, user.balance - payment.balanceUsed);
        await user.save();
        console.log(`[SuccessfulPayment Stars] Deducted $${payment.balanceUsed} from user ${user.telegramId} balance: $${oldBalance} -> $${user.balance}`);
      } else {
        console.log(`[SuccessfulPayment Stars] No balance deduction needed: useBalance=${payment.useBalance}, balanceUsed=${payment.balanceUsed}`);
      }
      let remnawaveUserId = user.remnawaveUserId;
      if (!remnawaveUserId) { // If user doesn't have a Remnawave ID, create them in the panel
        try {
          const tariffParts = payment.tariffId.split('_');
          const deviceLimitPart = tariffParts.find(part => part.endsWith('dev'));
          const hwidDeviceLimit = deviceLimitPart ? parseInt(deviceLimitPart.replace('dev', ''), 10) : 1;

          // Создаём уникальное имя в формате user{telegramId}_{короткий_суффикс}
          const shortSuffix = Math.random().toString(36).substring(2, 6); // 4 символа
          const baseUsername = `user${user.telegramId}`;
          const usernameForPanel = baseUsername.length + shortSuffix.length + 1 <= 34 
            ? `${baseUsername}_${shortSuffix}`
            : `u${user.telegramId}_${shortSuffix}`; // Укороченная версия если слишком длинно

          const userDataForRemnawave = {
            username: usernameForPanel,
            telegramId: user.telegramId,
            expireAt: payment.endDate.toISOString(),
            trafficLimitGb: payment.trafficAllocatedGb,
            hwidDeviceLimit: hwidDeviceLimit,
            status: 'ACTIVE',
            trafficLimitStrategy: 'NO_RESET', // Assuming NO_RESET, adjust if tariff has this info
            activateAllInbounds: true,
            description: `Payment ID: ${payment._id.toString()}; Tariff: ${payment.tariffId}; Method: TelegramStars`,
          };

          const remnaApiResponse = await createRemnawaveUser(userDataForRemnawave);

          if (remnaApiResponse.success && remnaApiResponse.data && remnaApiResponse.data.uuid) {
            remnawaveUserId = remnaApiResponse.data.uuid;
            user.remnawaveUserId = remnawaveUserId;
            await user.save();
            payment.remnawaveUserId = remnawaveUserId; // Link payment to panel user UUID
            await payment.save(); // Save updated payment record
            console.log(`[SuccessfulPayment Stars] Remnawave user ${remnawaveUserId} created/linked for TG User ${user.telegramId}.`);
          } else {
            console.error(`[SuccessfulPayment Stars] Failed to create Remnawave user for TG ID ${user.telegramId}:`, remnaApiResponse.message, remnaApiResponse.errorData);
            // Notify admin or user about the issue, payment is processed but panel sync failed.
            await ctx.reply(ctx.i18n('purchaseErrorRemnawave', { message: remnaApiResponse.message || 'Panel sync failed after Stars payment.' }));
          }
        } catch (error) {
          console.error(`[SuccessfulPayment Stars] Exception during Remnawave user creation for ${user.telegramId}:`, error);
          await ctx.reply(ctx.i18n('purchaseErrorRemnawave', { message: error.message || 'Exception during panel sync after Stars payment.' }));
        }
      } else {
        // User already has a Remnawave ID, potentially update their subscription in Remnawave
        // This would require a different API endpoint (e.g., PATCH /api/users/{uuid} or similar)
        // For now, we log this. If subscription update is needed, this logic must be implemented.
        console.log(`[SuccessfulPayment Stars] User ${user.telegramId} already has Remnawave ID ${remnawaveUserId}. Subscription update logic might be needed.`);
        // Ensure payment record is linked if it wasn't
        if (!payment.remnawaveUserId) {
            payment.remnawaveUserId = remnawaveUserId;
            await payment.save();
        }
      }
    } else {
      console.error(`[SuccessfulPayment Stars] User not found in DB for payment ${internalPaymentId}. Cannot sync with Remnawave.`);
      // This case should be rare if user middleware works correctly.
    }

    const tariffName = payment.tariffId; // Or reconstruct from payment details if needed
    // Delete previous bot messages in this chat
    try {
      if (ctx.session.lastBotMessages) {
        for (const msgId of ctx.session.lastBotMessages) {
          await ctx.deleteMessage(msgId).catch(e => console.log('Failed to delete message:', e.message));
        }
      }
    } catch (e) {
      console.log('Error deleting previous messages:', e.message);
    }

    const successMessage = ctx.i18n ? ctx.i18n('paymentSuccessfulStars', {
      tariffName: tariffName,
      endDate: payment.endDate.toLocaleDateString(ctx.session?.language || 'ru-RU'),
      traffic: payment.trafficAllocatedGb,
      devices: userDataForRemnawave.hwidDeviceLimit || 1
    }) : `🎉 Оплата прошла успешно!\n\nТариф: ${tariffName}\nДействует до: <b>${payment.endDate.toLocaleDateString()}</b>\nТрафик: <b>${payment.trafficAllocatedGb} ГБ</b>\nУстройства: <b>${userDataForRemnawave.hwidDeviceLimit || 1}</b>`;
    
    // Send new message and store its ID
    const sentMsg = await ctx.reply(successMessage, { parse_mode: 'HTML' });
    if (!ctx.session.lastBotMessages) ctx.session.lastBotMessages = [];
    ctx.session.lastBotMessages = [sentMsg.message_id];

    // Leave the current scene, if any
    if (ctx.scene && ctx.scene.current) {
      console.log(`[SuccessfulPayment Stars] Leaving scene: ${ctx.scene.current.id}`);
      await ctx.scene.leave();
    }

    console.log(`Payment ${internalPaymentId} (TG Charge ID: ${telegramChargeId}) processed successfully.`);

  } catch (error) {
    console.error('Error processing SuccessfulPayment:', error);
    // Inform user about the issue
    await ctx.reply(ctx.i18n ? ctx.i18n('paymentErrorSuccessfulPaymentException') : 'Your payment was successful, but there was an error updating your subscription. Please contact support with charge ID: ' + telegramChargeId);
  }
});

// Обработка ошибок

// Обработка ошибок
bot.catch(async (err, ctx) => { // Made async
  console.error(`Unhandled error for ${ctx.updateType} from ${ctx.from?.id}:`, err);
  try {
    // Attempt to use i18n if available, otherwise fallback
    const message = ctx.i18n ? ctx.i18n('errorMessage') : "An unexpected error occurred. Please try again later.";
    await ctx.reply(message);
  } catch (e) {
    console.error('FATAL: Could not send error message to user.', e);
    // Fallback if ctx.reply itself fails or if ctx is too broken
    if (ctx.telegram && ctx.from?.id) {
        try {
            await ctx.telegram.sendMessage(ctx.from.id, "An critical error occurred. We are unable to process your request at this moment.");
        } catch (finalError) {
            console.error('FATAL: Failed to send final fallback error message.', finalError);
        }
    }
  }
});

module.exports = bot;