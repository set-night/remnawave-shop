
const { Scenes, Markup } = require('telegraf');
const User = require('../database/models/user');
const Payment = require('../database/models/payment');
const config = require('../config');
const { createRemnawaveUser } = require('../api'); // Renamed function
// const { getLocalizedString } = require('../localization'); // Больше не нужен, т.к. ctx.i18n используется

module.exports = (showMainMenu) => {
  const trialScene = new Scenes.BaseScene('trialScene');

trialScene.enter(async (ctx) => {
  const user = ctx.dbUser;

  if (!config.trialEnabled) {
    await ctx.reply(ctx.i18n('trialNotAvailable'), Markup.keyboard([
        [ctx.i18n('buyButton')],
        [ctx.i18n('mySubscriptionsButton')],
        [ctx.i18n('referralProgramButton')],
        [ctx.i18n('helpButton'), ctx.i18n('channelButton')],
      ]).resize());
    return ctx.scene.leave();
  }

  if (user.trialUsed) {
    await ctx.reply(ctx.i18n('trialAlreadyUsed'), {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback(ctx.i18n('buySubscriptionButton'), 'GO_TO_BUY_SCENE')],
      [Markup.button.callback(ctx.i18n('backButton'), 'LEAVE_SCENE_TRIAL')]
    ])});
    return; // Не выходим из сцены, даем кнопки
  }

  // Предлагаем активировать пробный период
  await ctx.reply(ctx.i18n('trialOfferMessage', {
    duration: config.trialDuration,
    traffic: config.trialTraffic,
  }), {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
    [Markup.button.callback(ctx.i18n('activateTrialButton'), 'ACTIVATE_TRIAL')],
    [Markup.button.callback(ctx.i18n('backButton'), 'LEAVE_SCENE_TRIAL')]
  ])});
});

trialScene.action('ACTIVATE_TRIAL', async (ctx) => {
  await ctx.answerCbQuery();
  const user = ctx.dbUser;

  if (!config.trialEnabled || user.trialUsed) {
    // Повторная проверка, на случай если состояние изменилось
    await ctx.editMessageText(ctx.i18n('trialNotAvailableOrUsed'));
    return ctx.scene.leave();
  }

  await ctx.editMessageText(ctx.i18n('activatingTrial'));

  const trialStartDate = new Date();
  const trialEndDate = new Date(trialStartDate);
  trialEndDate.setDate(trialEndDate.getDate() + config.trialDuration);

  // 1. Попытка создать пробную подписку в Remnawave
  // Это также создаст пользователя в Remnawave, если его нет.
  // Имя пользователя в Remnawave будет ID нашей временной подписки.
  const usernameForPanel = `trial_user${user.telegramId}`; // Unique username for trial

  const userDataForRemnawave = {
    username: usernameForPanel,
    telegramId: user.telegramId,
    expireAt: trialEndDate.toISOString(),
    trafficLimitGb: config.trialTraffic,
    hwidDeviceLimit: config.trialDeviceLimit || 1, // Use from config or default to 1
    status: 'ACTIVE',
    trafficLimitStrategy: 'NO_RESET', // Typically trials are no_reset
    activateAllInbounds: true,
    description: `Trial Period for user ${user.telegramId}`,
  };
  const remnawaveApiResponse = await createRemnawaveUser(userDataForRemnawave);

  if (!remnawaveApiResponse || !remnawaveApiResponse.success) {
    await ctx.reply(ctx.i18n('trialActivationErrorRemnawave', { message: remnawaveApiResponse.message || '' }));
    // Показываем сообщение об ошибке и кнопки для возврата или покупки
    await ctx.reply(ctx.i18n('trialActivationErrorRemnawave', { message: remnawaveApiResponse.message || '' }), {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
        [Markup.button.callback(ctx.i18n('buySubscriptionButton'), 'GO_TO_BUY_SCENE')],
        [Markup.button.callback(ctx.i18n('backButton'), 'LEAVE_SCENE_TRIAL_AFTER_ERROR')]
    ])});
    return; // Не выходим из сцены сразу, даем пользователю выбор
  }

  // 2. Создание записи о пробной подписке в нашей БД


  const trialPayment = new Payment({
    userId: user.telegramId,
    // remnawaveUserId будет ID пользователя из Remnawave, если API его возвращает явно,
    // или можно использовать telegramId, если Remnawave связывает по нему.
    // Если createRemnawaveSubscription возвращает ID созданной подписки в Remnawave, его можно сохранить.
    // Store the Remnawave User UUID if creation was successful
    remnawaveUserId: remnawaveApiResponse.success && remnawaveApiResponse.data && remnawaveApiResponse.data.uuid ? remnawaveApiResponse.data.uuid : null,
    tariffId: `trial_${config.trialDuration}d_${config.trialTraffic}gb`, // More descriptive trial tariff ID
    paymentSystem: 'trial_period',
    amount: 0,
    currency: 'N/A',
    status: 'active', // Сразу активен
    startDate: trialStartDate,
    endDate: trialEndDate,
    trafficAllocatedGb: config.trialTraffic,
    isTrial: true,
  });
  await trialPayment.save();

  // 3. Обновление пользователя в нашей БД
  user.trialUsed = true;
  if (remnawaveApiResponse.success && remnawaveApiResponse.data && remnawaveApiResponse.data.uuid) {
    user.remnawaveUserId = remnawaveApiResponse.data.uuid; // Store Remnawave User UUID
  }
  await user.save();

  await ctx.reply(ctx.i18n('trialActivatedSuccessfully', {
    endDate: trialEndDate.toLocaleDateString(ctx.session.language || 'ru-RU'),
    traffic: config.trialTraffic,
    remnawaveSubscriptionId: (remnawaveApiResponse.success && remnawaveApiResponse.data && remnawaveApiResponse.data.uuid) ? remnawaveApiResponse.data.uuid : usernameForPanel,
    remnawaveSubscriptionUrl: remnawaveApiResponse.data.subscriptionUrl
  }), {
    parse_mode: 'HTML'})
  
  return ctx.scene.leave();
});

trialScene.action('GO_TO_BUY_SCENE', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.scene.leave();
  return ctx.scene.enter('buyScene'); // Предполагается, что buyScene будет создана
});

trialScene.action('LEAVE_SCENE_TRIAL_AFTER_ERROR', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage().catch(e => console.warn("Could not delete message in trial scene after error:", e.message));
  await ctx.scene.leave();
  await showMainMenu(ctx);
});

trialScene.action('LEAVE_SCENE_TRIAL', async (ctx) => {
  await ctx.answerCbQuery();
  // Удаляем сообщение с инлайн кнопками
  if (ctx.callbackQuery && ctx.callbackQuery.message) {
    try {
      await ctx.deleteMessage(ctx.callbackQuery.message.message_id);
    } catch (e) {
      console.warn("Could not delete previous message in trial scene:", e.message);
    }
  }
  await ctx.scene.leave();
  await showMainMenu(ctx); // Показываем главное меню
});

// Fallback
trialScene.on('message', (ctx) => ctx.reply(ctx.i18n('unknownActionInScene')));

  return trialScene;
};