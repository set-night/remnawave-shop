const axios = require('axios');

const { Scenes, Markup } = require('telegraf');
const User = require('../database/models/user');
const Payment = require('../database/models/payment');
const config = require('../config');
const { createRemnawaveUser } = require('../api'); // API for Remnawave
const currencyService = require('../services/currency');
const mongoose = require('mongoose'); // Добавляем импорт mongoose

// --- Опции для конструктора тарифов ---
const DURATION_OPTIONS = [
  { id: '1', labelKey: 'duration1Month', coefficientKey: 'month1', actualMonths: 1 },
  { id: '3', labelKey: 'duration3Months', coefficientKey: 'month3', actualMonths: 3 },
  { id: '6', labelKey: 'duration6Months', coefficientKey: 'month6', actualMonths: 6 },
  { id: '12', labelKey: 'duration1Year', coefficientKey: 'month12', actualMonths: 12 },
];

const GB_OPTIONS = [
  { id: '50', labelKey: 'gb50', coefficientKey: 'gb50' },
  { id: '100', labelKey: 'gb100', coefficientKey: 'gb100' },
  { id: '250', labelKey: 'gb250', coefficientKey: 'gb250' },
  { id: '1000', labelKey: 'gb1000', coefficientKey: 'gb1000' }, // 1 TB
  { id: '5000', labelKey: 'gb5000', coefficientKey: 'gb5000' }, // 5 TB
];

const CONNECTIONS_OPTIONS = [
  { id: '5', labelKey: 'connections5', coefficientKey: 'connections5' },
  { id: '10', labelKey: 'connections10', coefficientKey: 'connections10' },
  
  { id: '25', labelKey: 'connections25', coefficientKey: 'connections25' },
  { id: '100', labelKey: 'connections100', coefficientKey: 'connections100' },
];

// --- Вспомогательные функции ---
function calculatePrice(selection, coefficients, ctx) {
  const selectedDurationOpt = DURATION_OPTIONS.find(opt => opt.id === selection.duration);
  const selectedGbOpt = GB_OPTIONS.find(opt => opt.id === selection.gb);
  const selectedConnectionsOpt = CONNECTIONS_OPTIONS.find(opt => opt.id === selection.connections);

  if (!selectedDurationOpt || !selectedGbOpt || !selectedConnectionsOpt) {
    console.error('Invalid selection for price calculation:', selection);
    return 0;
  }

  const durationCoeff = coefficients[selectedDurationOpt.coefficientKey];
  const gbBasePrice = coefficients[selectedGbOpt.coefficientKey];
  const connectionsCoeff = coefficients[selectedConnectionsOpt.coefficientKey];

  if (durationCoeff === undefined || gbBasePrice === undefined || connectionsCoeff === undefined) {
    console.error('Missing coefficient for price calculation. Selection:', selection, 'Coeffs:', coefficients);
    return 0;
  }
  // Цена = Коэфф_Длительности * Базовая_Цена_GB * Коэфф_Подключений
  const rawPrice = durationCoeff * gbBasePrice * connectionsCoeff;
  return Math.round(rawPrice * 100) / 100; // Округляем до 2 знаков после запятой
}

async function buildTariffConstructorKeyboard(ctx) { // Made async
  const { tariffConfig } = ctx.scene.state; // tariffConfig: { duration, gb, connections }

  const makeButtonRow = (options, selectedValue, type) => {
    return options.map(opt => {
      const label = ctx.i18n(opt.labelKey, { value: opt.id });
      return Markup.button.callback(
        `${selectedValue === opt.id ? '✅ ' : ''}${label}`,
        `CHOOSE_${type}_${opt.id}`
      );
    });
  };

  const keyboard = [
    makeButtonRow(DURATION_OPTIONS, tariffConfig.duration, 'DURATION'),
    makeButtonRow(GB_OPTIONS, tariffConfig.gb, 'GB'),
    makeButtonRow(CONNECTIONS_OPTIONS, tariffConfig.connections, 'CONNECTIONS'),
    [
      Markup.button.callback(ctx.i18n('backButton'), 'LEAVE_SCENE_BUY'),
      Markup.button.callback(ctx.i18n('confirmTariffButton'), 'CONFIRM_CUSTOM_TARIFF') // Changed text
    ]
  ];
  return Markup.inlineKeyboard(keyboard);
}

module.exports = (showMainMenu) => {
  const buyScene = new Scenes.BaseScene('buyScene');

// Вход в сцену: отображение конструктора
buyScene.enter(async (ctx) => {
  if (!ctx.scene.state.tariffConfig) {
    ctx.scene.state.tariffConfig = {
      duration: DURATION_OPTIONS[0].id,
      gb: GB_OPTIONS[0].id,
      connections: CONNECTIONS_OPTIONS[0].id,
    };
  }
  await sendOrEditTariffConstructor(ctx);
});

// Helper function to build and send/edit the tariff constructor message
async function sendOrEditTariffConstructor(ctx, edit = false) {
  const { tariffConfig } = ctx.scene.state;
  const { tariffCoefficients } = config;

  const selectedDurationOpt = DURATION_OPTIONS.find(opt => opt.id === tariffConfig.duration);
  const selectedGbOpt = GB_OPTIONS.find(opt => opt.id === tariffConfig.gb);
  const selectedConnectionsOpt = CONNECTIONS_OPTIONS.find(opt => opt.id === tariffConfig.connections);

  const currentPriceRUB = calculatePrice(tariffConfig, tariffCoefficients, ctx);
  let currentPriceUSD = null;
  const usdtToRubRate = await currencyService.getPairPrice('tether', 'rub');
  if (usdtToRubRate && usdtToRubRate > 0 && currentPriceRUB > 0) {
    currentPriceUSD = currentPriceRUB / usdtToRubRate;
  }

  let messageText = ctx.i18n('configureTariffPrompt') + '\n\n';
  messageText += `<b>${ctx.i18n('durationLabel')}</b> ${ctx.i18n(selectedDurationOpt.labelKey, { value: selectedDurationOpt.id })}\n`;
  messageText += `<b>${ctx.i18n('gbLabel')}</b> ${ctx.i18n(selectedGbOpt.labelKey, { value: selectedGbOpt.id })}\n`;
  messageText += `<b>${ctx.i18n('connectionsLabel')}</b> ${ctx.i18n(selectedConnectionsOpt.labelKey, { value: selectedConnectionsOpt.id })}\n\n`;
  
  const priceString = currentPriceUSD
    ? ctx.i18n('currentPriceLabelWithUSD', { price: currentPriceRUB.toFixed(2), priceUSD: currentPriceUSD.toFixed(2) })
    : ctx.i18n('currentPriceLabel', { price: currentPriceRUB.toFixed(2) });
  messageText += `<b>${ctx.i18n('priceSummaryLabel')}: ${priceString}</b>`;

  const keyboardMarkup = await buildTariffConstructorKeyboard(ctx);

  if (edit && ctx.callbackQuery && ctx.callbackQuery.message) {
    try {
      await ctx.editMessageText(messageText, { ...keyboardMarkup, parse_mode: 'HTML' });
    } catch (error) {
      if (error.description && error.description.includes('message is not modified')) {
        // console.log('Message not modified, skipping edit.');
      } else {
        console.error('Error editing message in tariff constructor:', error);
        await ctx.replyWithHTML(messageText, keyboardMarkup); // Fallback to sending new message
      }
    }
  } else {
    if (ctx.callbackQuery && ctx.callbackQuery.message) { // If called from an action, delete old message first
        try { await ctx.deleteMessage(); } catch(e) { /* ignore */ }
    }
    await ctx.replyWithHTML(messageText, keyboardMarkup);
  }
}

// Обработчики для кнопок конструктора
const createOptionHandler = (optionType, optionsArray) => {
  buyScene.action(new RegExp(`CHOOSE_${optionType}_(\\w+)`), async (ctx) => {
    await ctx.answerCbQuery();
    const selectedValue = ctx.match[1];
    const currentConfig = ctx.scene.state.tariffConfig;

    if (optionType === 'DURATION') currentConfig.duration = selectedValue;
    else if (optionType === 'GB') currentConfig.gb = selectedValue;
    else if (optionType === 'CONNECTIONS') currentConfig.connections = selectedValue;

    await sendOrEditTariffConstructor(ctx, true);
  });
};

createOptionHandler('DURATION', DURATION_OPTIONS);
createOptionHandler('GB', GB_OPTIONS);
createOptionHandler('CONNECTIONS', CONNECTIONS_OPTIONS);

// Обработчик для кнопок-заголовков (ничего не делают)
buyScene.action('noop', async (ctx) => await ctx.answerCbQuery()); // Kept for any existing noop buttons if necessary
// buyScene.action('noop_price', async (ctx) => await ctx.answerCbQuery(ctx.i18n('priceCalculatedInfo'))); // Price is now in text

// Подтверждение тарифа и переход к выбору способа оплаты
buyScene.action('CONFIRM_CUSTOM_TARIFF', async (ctx) => {
  await ctx.answerCbQuery();
  const { tariffConfig } = ctx.scene.state;
  const user = ctx.dbUser;

  const selectedDurationOpt = DURATION_OPTIONS.find(opt => opt.id === tariffConfig.duration);
  const selectedGbOpt = GB_OPTIONS.find(opt => opt.id === tariffConfig.gb);
  const selectedConnectionsOpt = CONNECTIONS_OPTIONS.find(opt => opt.id === tariffConfig.connections);

  if (!selectedDurationOpt || !selectedGbOpt || !selectedConnectionsOpt) {
    await ctx.reply(ctx.i18n('tariffConfigurationError'));
    return ctx.scene.reenter(); // Or leave
  }

  const finalPriceRUB = calculatePrice(tariffConfig, config.tariffCoefficients, ctx);
  const tariffName = ctx.i18n('customTariffName', {
    duration: ctx.i18n(selectedDurationOpt.labelKey, { value: selectedDurationOpt.id }),
    gb: ctx.i18n(selectedGbOpt.labelKey, { value: selectedGbOpt.id }),
    connections: ctx.i18n(selectedConnectionsOpt.labelKey, { value: selectedConnectionsOpt.id })
  });

  let finalPriceUSD = null;
  const usdtToRubRate = await currencyService.getPairPrice('tether', 'rub');
  if (usdtToRubRate && usdtToRubRate > 0) {
    finalPriceUSD = finalPriceRUB / usdtToRubRate;
  }

  // Store tariff details in scene state for payment processing
  ctx.scene.state.paymentDetails = {
    tariffConfig,
    finalPriceRUB,
    finalPriceUSD,
    tariffName,
    selectedDurationOpt,
    selectedGbOpt,
    selectedConnectionsOpt,
    remnawaveUserId: user.remnawaveUserId, // Store current, will be updated if null
  };

  const messageText = finalPriceUSD
    ? ctx.i18n('choosePaymentMethodPromptUSD', { tariffName, priceRUB: finalPriceRUB.toFixed(2), priceUSD: finalPriceUSD.toFixed(2) })
    : ctx.i18n('choosePaymentMethodPrompt', { tariffName, priceRUB: finalPriceRUB.toFixed(2) });

  const paymentKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback(ctx.i18n('payWithCryptoBot'), 'PAY_CRYPTOBOT')],
    [Markup.button.callback(ctx.i18n('payWithTelegramStars'), 'PAY_STARS')],
    [Markup.button.callback(ctx.i18n('backToTariffConstructor'), 'BACK_TO_CONSTRUCTOR')]
  ]);

  await ctx.editMessageText(messageText, paymentKeyboard);
});

// Возврат к конструктору тарифов из выбора способа оплаты
buyScene.action('BACK_TO_CONSTRUCTOR', async (ctx) => {
  await ctx.answerCbQuery();
  // Очищаем детали платежа, так как пользователь вернулся к конструктору
  delete ctx.scene.state.paymentDetails;
  // Просто вызываем enter, чтобы перестроить конструктор
  // Состояние tariffConfig сохранится, так что пользователь не потеряет выбор
  return buyScene.enter(ctx);
});


// TODO: Implement PAY_CRYPTOBOT action
buyScene.action('PAY_CRYPTOBOT', async (ctx) => {
  await ctx.answerCbQuery('Processing CryptoBot payment...');
  const { paymentDetails } = ctx.scene.state;
  if (!paymentDetails) {
    await ctx.reply(ctx.i18n('sessionExpiredOrError'));
    return ctx.scene.leave();
  }

  const {
    finalPriceRUB,
    tariffName,
    selectedDurationOpt,
    selectedGbOpt,
    tariffConfig,
  } = paymentDetails;
  const user = ctx.dbUser;

  // For CryptoBot, we need to decide which asset to request payment in.
  // The API supports: BTC, TON, ETH (Native), USDT (TRC20, BEP20), USDC (TRC20, BEP20), BUSD (BEP20).
  // Let's assume we want to receive payment in USDT (TRC20).
  // The price `finalPriceRUB` needs to be converted to USDT.
  const usdtPrice = await currencyService.convertUSDToCrypto(paymentDetails.finalPriceUSD, 'tether');

  if (!usdtPrice || usdtPrice <= 0) {
    await ctx.reply(ctx.i18n('paymentErrorPriceConversion'));
    return ctx.scene.reenter(); // or leave
  }

  const cryptoBotPayload = {
    asset: 'USDT', // Example: Pay in USDT
    amount: usdtPrice.toFixed(8), // CryptoBot requires string amount; use appropriate precision
    // description: tariffName, // Optional
    // paid_btn_name: 'CALLBACK', // Optional: for callback query on successful payment
    // paid_btn_url: `https://yourdomain.com/payment/cryptobot/success?orderId=${orderId}`, // Optional
    // allow_comments: false, // Optional
    // allow_anonymous: false, // Optional
    // expires_in: 3600 // Optional: invoice lifetime in seconds
  };

  try {
    // We need to make an API call to CryptoBot
    // POST https://pay.crypt.bot/api/createInvoice
    // Headers: Crypto-Pay-API-Token: YOUR_TOKEN
    const cryptobotApiUrl = 'https://pay.crypt.bot/api/createInvoice';
    const response = await axios.post(cryptobotApiUrl, cryptoBotPayload, {
      headers: { 'Crypto-Pay-API-Token': config.cryptobotToken }
    });

    if (response.data && response.data.ok && response.data.result) {
      const invoice = response.data.result;
      // Save pending payment to DB
      const tempPaymentId = `CB-${Date.now()}`; // Temporary ID until we get one from CryptoBot if applicable

      // The logic for creating/getting remnawaveUserId is now handled by the payment success webhook
      // or after successful payment confirmation, where the subscription is actually created in Remnawave.
      // For now, we prepare a local payment record.
      // The actual call to createRemnawaveSubscription will happen upon successful payment.
      
      const startDate = new Date();
      const endDate = new Date(startDate);
      endDate.setMonth(startDate.getMonth() + selectedDurationOpt.actualMonths);

      const newPayment = new Payment({
        userId: user.telegramId,
        remnawaveUserId: null, // Will be filled after successful Remnawave subscription creation
        tariffId: `custom_${tariffConfig.duration}m_${tariffConfig.gb}gb_${tariffConfig.connections}dev`,
        paymentSystem: 'cryptobot',
        paymentId: invoice.invoice_id, // CryptoBot's invoice ID
        amount: parseFloat(cryptoBotPayload.amount), // Amount in crypto (USDT)
        currency: cryptoBotPayload.asset, // USDT
        status: 'pending', // Payment is pending until webhook confirmation
        startDate: startDate, // Will be set upon completion
        endDate: endDate,     // Will be set upon completion
        trafficAllocatedGb: parseInt(selectedGbOpt.id),
        isTrial: false,
      });
      await newPayment.save();
      
      // Store our internal payment ID or CryptoBot invoice ID in scene state for webhook processing
      ctx.scene.state.pendingPaymentId = newPayment._id.toString(); // or invoice.invoice_id

      await ctx.editMessageText(
        ctx.i18n('cryptobotInvoiceCreated', { invoiceUrl: invoice.pay_url, tariffName: tariffName }),
        Markup.inlineKeyboard([
          [Markup.button.url(ctx.i18n('payButton'), invoice.pay_url)],
          [Markup.button.callback(ctx.i18n('checkPaymentButton'), `CHECK_CRYPTOBOT_PAYMENT_SCENE_${invoice.invoice_id}`)],
          [Markup.button.callback(ctx.i18n('backToPaymentMethods'), 'CONFIRM_CUSTOM_TARIFF')] // Go back to payment selection
        ])
      );
    } else {
      console.error("CryptoBot API error:", response.data);
      await ctx.reply(ctx.i18n('paymentErrorCryptoBot'));
    }
  } catch (error) {
    console.error("Error creating CryptoBot invoice:", error.response ? error.response.data : error.message);
    await ctx.reply(ctx.i18n('paymentErrorCryptoBot'));
  }
});


// TODO: Implement PAY_STARS action
buyScene.action('PAY_STARS', async (ctx) => {
  await ctx.answerCbQuery('Processing Telegram Stars payment...');
  const { paymentDetails } = ctx.scene.state;
  if (!paymentDetails) {
    await ctx.reply(ctx.i18n('sessionExpiredOrError'));
    return ctx.scene.leave();
  }
  const {
    finalPriceUSD,
    tariffName,
    selectedDurationOpt,
    selectedGbOpt,
    tariffConfig,
  } = paymentDetails;
  const user = ctx.dbUser;

  if (!config.telegramStarsToken) {
      await ctx.reply(ctx.i18n('telegramStarsNotConfiguredError'));
      return ctx.scene.reenter();
  }

  if (!finalPriceUSD || finalPriceUSD <= 0) {
    await ctx.reply(ctx.i18n('paymentErrorPriceConversion'));
    return ctx.scene.reenter();
  }

  // Convert USD to Stars: 1 Star = $0.013
  const priceInStars = Math.round(finalPriceUSD / currencyService.TELEGRAM_STAR_TO_USD_RATE);

  if (priceInStars < 1) { // Telegram Stars minimum is 1 star
      await ctx.reply(ctx.i18n('paymentErrorStarsMinAmount'));
      return ctx.scene.reenter();
  }

  // Create a unique payload for this payment attempt
  // This payload will be sent back in PreCheckoutQuery and SuccessfulPayment
  const internalPaymentId = new mongoose.Types.ObjectId().toString();
  ctx.scene.state.pendingStarsPaymentId = internalPaymentId; // Store for successful_payment handler

  // Pre-create a pending payment record in DB.
  // This helps associate the successful_payment update with the user and tariff.
  // Similar to CryptoBot, remnawaveUserId will be handled upon successful payment
  // when the subscription is created in Remnawave.

  const startDate = new Date();
  const endDate = new Date(startDate);
  endDate.setMonth(startDate.getMonth() + selectedDurationOpt.actualMonths);

  const preliminaryPayment = new Payment({
    _id: internalPaymentId, // Use our generated ID
    userId: user.telegramId,
    remnawaveUserId: null, // Will be filled after successful Remnawave subscription creation
    tariffId: `custom_${tariffConfig.duration}m_${tariffConfig.gb}gb_${tariffConfig.connections}dev`,
    paymentSystem: 'telegram_stars',
    // paymentId will be telegram_charge_id after successful payment
    amount: priceInStars, // Amount in Stars
    currency: 'XTR', // Telegram Stars currency code
    status: 'pending_stars_invoice',
    startDate: startDate,
    endDate: endDate,
    trafficAllocatedGb: parseInt(selectedGbOpt.id),
    isTrial: false,
  });
  await preliminaryPayment.save();


  const invoice = {
    title: ctx.i18n('paymentTitle', { tariffName }),
    description: ctx.i18n('paymentDescription', { tariffName }),
    payload: internalPaymentId, // Our internal unique ID for this payment attempt
    provider_token: config.telegramStarsToken,
    currency: 'XTR', // Telegram Stars currency
    prices: [{ label: ctx.i18n('priceLabelStars', { tariffName }), amount: priceInStars }],
    // photo_url: 'URL_TO_AN_IMAGE_FOR_THE_INVOICE', // Optional
    // photo_width: 512, // Optional
    // photo_height: 512, // Optional
    // need_name: false, // Optional
    // need_phone_number: false, // Optional
    // need_email: false, // Optional
    // need_shipping_address: false, // Optional
    // send_phone_number_to_provider: false, // Optional
    // send_email_to_provider: false, // Optional
    // is_flexible: false, // Optional, for shipping options
  };

  try {
    // await ctx.deleteMessage(); // Clean up previous message
    await ctx.replyWithInvoice(invoice);
  } catch (error) {
    console.error('Error sending Telegram Stars invoice:', error);
    await preliminaryPayment.deleteOne(); // Clean up pending payment if invoice failed
    await ctx.reply(ctx.i18n('paymentErrorStarsGeneral'));
    // Potentially go back to payment selection
    const keyboard = await buildTariffConstructorKeyboard(ctx);
    await ctx.reply(ctx.i18n('configureTariffPrompt'), keyboard);
  }
});


// Выход из сцены

// Обработчик для кнопки "Проверить платеж" в сцене
buyScene.action(/CHECK_CRYPTOBOT_PAYMENT_SCENE_(\S+)/, async (ctx) => {
  const invoiceId = ctx.match[1];
  await ctx.answerCbQuery(ctx.i18n('checkingCryptoBotPayments', { count: 1 }));

  const paymentRecord = await Payment.findOne({ paymentId: invoiceId, paymentSystem: 'cryptobot' });

  if (!paymentRecord) {
    await ctx.reply(ctx.i18n('paymentErrorSuccessfulPaymentNotFound', { telegramChargeId: invoiceId }));
    return;
  }

  if (paymentRecord.status === 'active' || paymentRecord.status === 'completed') {
    await ctx.reply(ctx.i18n('paymentAlreadyCompleted'));
    // Можно добавить логику для показа деталей подписки или выхода из сцены
    await ctx.scene.leave();
    await showMainMenu(ctx);
    return;
  }

  try {
    const response = await axios.get('https://pay.crypt.bot/api/getInvoices', {
      headers: { 'Crypto-Pay-API-Token': config.cryptobotToken },
      params: { invoice_ids: invoiceId }
    });

    if (response.data && response.data.ok && response.data.result && response.data.result.items && response.data.result.items.length > 0) {
      const invoiceDetails = response.data.result.items[0];
      const user = await User.findOne({ telegramId: paymentRecord.userId }); // Fetch user for language preference
      const lang = user?.languageCode || ctx.session?.language || 'ru';

      if (invoiceDetails.status === 'paid') {
        paymentRecord.status = 'active'; // Or 'completed'
        paymentRecord.updatedAt = new Date();
        
        // Ensure Remnawave user exists and subscription is created
        let remnawaveUserId = user.remnawaveUserId;
        if (!remnawaveUserId) {
            try {
                // Extract deviceLimit from tariffId like "custom_1m_50gb_5dev"
                const tariffParts = paymentRecord.tariffId.split('_');
                const deviceLimitPart = tariffParts.find(part => part.endsWith('dev'));
                const hwidDeviceLimit = deviceLimitPart ? parseInt(deviceLimitPart.replace('dev', ''), 10) : 1; // Default to 1

                const usernameForPanel = `user${user.telegramId}`; // Simple username generation

                const userDataForRemnawave = {
                  username: usernameForPanel,
                  telegramId: user.telegramId,
                  expireAt: paymentRecord.endDate.toISOString(),
                  trafficLimitGb: paymentRecord.trafficAllocatedGb,
                  hwidDeviceLimit: hwidDeviceLimit,
                  status: 'ACTIVE',
                  trafficLimitStrategy: 'NO_RESET', // Or derive from tariff if needed
                  activateAllInbounds: true,
                  description: `Payment ID: ${paymentRecord._id.toString()}; Tariff: ${paymentRecord.tariffId}`,
                };
                
                // Use the renamed function createRemnawaveUser
                const remnaApiResponse = await createRemnawaveUser(userDataForRemnawave);

                if (remnaApiResponse.success && remnaApiResponse.data && remnaApiResponse.data.uuid) {
                    remnawaveUserId = remnaApiResponse.data.uuid; // Store the panel's user UUID
                    user.remnawaveUserId = remnawaveUserId; // This is the UUID from the panel for the user
                    await user.save();
                    // paymentRecord.remnawaveUserId = remnawaveUserId; // This field in payment might not be needed if user model has it
                                                                    // Or if it is, it should store the panel's user UUID.
                                                                    // For consistency, let's assume we want to link the payment to the panel user UUID.
                    paymentRecord.remnawaveUserId = remnawaveUserId;

                } else {
                    console.error(`[CryptoBot Check] Failed to create Remnawave user for TG ID ${user.telegramId} after payment ${invoiceId}:`, remnaApiResponse.message, remnaApiResponse.errorData);
                    await ctx.reply(ctx.i18n('purchaseErrorRemnawave', { message: remnaApiResponse.message || 'Unknown API error during user creation.' }));
                }
            } catch (remnaError) { // Catch any other unexpected error during the process
                console.error(`[CryptoBot Check] Exception during Remnawave user creation for ${user.telegramId}, payment ${invoiceId}:`, remnaError);
                await ctx.reply(ctx.i18n('purchaseErrorRemnawave', { message: remnaError.message || 'Exception during user creation process.' }));
            }
        } else {
            // TODO: Update existing Remnawave subscription if necessary
            // This might involve a different API call to Remnawave
            console.log(`[CryptoBot Check] User ${user.telegramId} already has Remnawave ID ${remnawaveUserId}. Update logic might be needed.`);
        }
        await paymentRecord.save();

        const successMessage = ctx.i18n('paymentSuccessfulCryptoBot', {
          tariffName: paymentRecord.tariffId, // Consider using a more descriptive name
          endDate: paymentRecord.endDate ? paymentRecord.endDate.toLocaleDateString(lang === 'ru' ? 'ru-RU' : 'en-US') : 'N/A',
          traffic: paymentRecord.trafficAllocatedGb,
          amount: parseFloat(invoiceDetails.amount),
          asset: invoiceDetails.asset
        });
        await ctx.editMessageText(successMessage, Markup.inlineKeyboard([
            [Markup.button.callback(ctx.i18n('backToMainMenuButton'), 'LEAVE_SCENE_BUY_SUCCESS')]
        ]));
        // await ctx.scene.leave(); // Leave after success message and button
        // await showMainMenu(ctx);
      } else if (invoiceDetails.status === 'expired') {
        paymentRecord.status = 'expired';
        paymentRecord.updatedAt = new Date();
        await paymentRecord.save();
        await ctx.reply(ctx.i18n('paymentManuallyExpired', { invoiceId }));
        // Keep the buttons for payment or back
      } else { // Still pending or other status
        await ctx.reply(ctx.i18n('paymentStatusStillPending', { status: invoiceDetails.status, invoiceId: invoiceId }));
        // Keep the buttons for payment or back
      }
    } else {
      console.error(`[CryptoBot Check] Could not get details for invoice ${invoiceId} from CryptoBot or no items returned. Response:`, response.data);
      await ctx.reply(ctx.i18n('errorCheckingSpecificPayment', { invoiceId }));
    }
  } catch (error) {
    console.error(`[CryptoBot Check] Error checking invoice ${invoiceId}:`, error.response ? error.response.data : error.message);
    await ctx.reply(ctx.i18n('errorCheckingSpecificPayment', { invoiceId }));
  }
});

buyScene.action('LEAVE_SCENE_BUY_SUCCESS', async (ctx) => {
    await ctx.answerCbQuery();
    if (ctx.callbackQuery && ctx.callbackQuery.message) {
        try { await ctx.deleteMessage(); } catch (e) { /* ignore */ }
    }
    await ctx.scene.leave();
    await showMainMenu(ctx);
});

buyScene.action('LEAVE_SCENE_BUY', async (ctx) => {
  await ctx.answerCbQuery();
  // Удаляем сообщение с инлайн кнопками
  if (ctx.callbackQuery && ctx.callbackQuery.message) {
    try {
      await ctx.deleteMessage(ctx.callbackQuery.message.message_id);
    } catch (e) {
      console.warn("Could not delete previous message in buy scene:", e.message);
    }
  }
  await ctx.scene.leave();
  await showMainMenu(ctx); // Показываем главное меню
});


// Handle SuccessfulPayment inside scene
buyScene.on('successful_payment', async (ctx) => {
  const successfulPayment = ctx.message.successful_payment;
  console.log('[BuyScene] Received SuccessfulPayment:', successfulPayment);

  const internalPaymentId = successfulPayment.invoice_payload;
  const telegramChargeId = successfulPayment.telegram_payment_charge_id;

  if (!internalPaymentId) {
    console.error('[BuyScene] SuccessfulPayment missing invoice_payload.');
    return;
  }

  try {
    const payment = await Payment.findById(internalPaymentId);
    if (!payment) {
      console.error(`[BuyScene] Payment not found for SuccessfulPayment. Internal ID: ${internalPaymentId}`);
      await ctx.reply(ctx.i18n('paymentErrorSuccessfulPaymentNotFound'));
      return;
    }

    if (payment.status === 'active' || payment.status === 'completed') {
      console.warn(`[BuyScene] Payment ${internalPaymentId} already marked as ${payment.status}. Ignoring duplicate SuccessfulPayment.`);
      await ctx.reply(ctx.i18n('paymentAlreadyCompleted'));
      return;
    }
    
    if (payment.paymentSystem !== 'telegram_stars') {
      console.error(`[BuyScene] Payment ${internalPaymentId} is not a Telegram Stars payment. System: ${payment.paymentSystem}`);
      await ctx.reply(ctx.i18n('paymentErrorSystemMismatch'));
      return;
    }

    // Update payment record
    payment.status = 'active';
    payment.paymentId = telegramChargeId;
    payment.updatedAt = new Date();
    await payment.save();

    const user = await User.findOne({ telegramId: payment.userId });
    if (user) {
      let remnawaveUserId = user.remnawaveUserId;
      if (!remnawaveUserId) {
        try {
          const tariffParts = payment.tariffId.split('_');
          const deviceLimitPart = tariffParts.find(part => part.endsWith('dev'));
          const hwidDeviceLimit = deviceLimitPart ? parseInt(deviceLimitPart.replace('dev', ''), 10) : 1;

          const randomSuffix = Math.random().toString(36).substring(2, 8);
          const usernameForPanel = `user${user.telegramId}_${randomSuffix}`;

          const userDataForRemnawave = {
            username: usernameForPanel,
            telegramId: user.telegramId,
            expireAt: payment.endDate.toISOString(),
            trafficLimitGb: payment.trafficAllocatedGb,
            hwidDeviceLimit: hwidDeviceLimit,
            status: 'ACTIVE',
            trafficLimitStrategy: 'NO_RESET',
            activateAllInbounds: true,
            description: `Payment ID: ${payment._id.toString()}; Tariff: ${payment.tariffId}; Method: TelegramStars`,
          };

          const remnaApiResponse = await createRemnawaveUser(userDataForRemnawave);

          if (remnaApiResponse.success && remnaApiResponse.data && remnaApiResponse.data.uuid) {
            remnawaveUserId = remnaApiResponse.data.uuid;
            user.remnawaveUserId = remnawaveUserId;
            await user.save();
            payment.remnawaveUserId = remnawaveUserId;
            await payment.save();
            console.log(`[BuyScene] Remnawave user ${remnawaveUserId} created/linked for TG User ${user.telegramId}.`);
          } else {
            console.error(`[BuyScene] Failed to create Remnawave user for TG ID ${user.telegramId}:`, remnaApiResponse.message, remnaApiResponse.errorData);
            await ctx.reply(ctx.i18n('purchaseErrorRemnawave', { message: remnaApiResponse.message || 'Panel sync failed after Stars payment.' }));
          }
        } catch (error) {
          console.error(`[BuyScene] Exception during Remnawave user creation for ${user.telegramId}:`, error);
          await ctx.reply(ctx.i18n('purchaseErrorRemnawave', { message: error.message || 'Exception during panel sync after Stars payment.' }));
        }
      }
    }

    // Delete previous messages
    if (ctx.session.lastBotMessages) {
      for (const msgId of ctx.session.lastBotMessages) {
        await ctx.deleteMessage(msgId).catch(e => console.log('Failed to delete message:', e.message));
      }
    }

    const successMessage = ctx.i18n('paymentSuccessfulStars', {
      tariffName: payment.tariffId,
      endDate: payment.endDate.toLocaleDateString(ctx.session?.language || 'ru-RU'),
      traffic: payment.trafficAllocatedGb
    });
    
    const sentMsg = await ctx.reply(successMessage);
    ctx.session.lastBotMessages = [sentMsg.message_id];

    await ctx.scene.leave();
    await showMainMenu(ctx);

  } catch (error) {
    console.error('[BuyScene] Error processing SuccessfulPayment:', error);
    await ctx.reply(ctx.i18n('paymentErrorSuccessfulPaymentException'));
  }
});

// Обработка непредвиденных сообщений в сцене
buyScene.on('message', async (ctx) => {
  if (ctx.message.text === '/start') {
    await ctx.scene.leave();
    return showMainMenu(ctx);
  }
  
  try {
    if (ctx.session.lastBotMessages) {
      for (const msgId of ctx.session.lastBotMessages) {
        await ctx.deleteMessage(msgId).catch(e => {
          if (!e.description.includes('message to delete not found')) {
            console.error('Error deleting message:', e);
          }
        });
      }
    }
  } catch (e) {
    console.error('Error cleaning up messages:', e);
  }
  
  await ctx.reply(ctx.i18n('pleaseUseButtonsInConstructor'));
});


  return buyScene;
};

