const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  userId: { // Telegram ID of the user
    type: Number,
    required: true,
    index: true,
  },
  remnawaveUserId: { // ID пользователя в системе Remnawave
    type: String, // Может быть UUID или другой строковый идентификатор
    index: true,
  },
  subscriptionId: { // ID подписки в системе Remnawave (если есть)
    type: String,
    index: true,
  },
  tariffId: { // ID тарифа (например, 'monthly', 'yearly' из конфига)
    type: String,
    required: true,
  },
  paymentSystem: { // 'telegram_stars', 'cryptobot', 'referral_bonus'
    type: String,
    required: true,
  },
  paymentId: { // ID платежа во внешней системе (если есть)
    type: String,
    index: true,
  },
  amount: { // Сумма платежа (может быть 0 для пробного или реферального)
    type: Number,
    required: true,
  },
  currency: { // Валюта платежа
    type: String,
    // required: true, // Может быть неактуально для Telegram Stars или бонусов
  },
  status: { // 'pending', 'completed', 'failed', 'refunded', 'active', 'expired'
    type: String,
    required: true,
    default: 'pending',
    index: true,
  },
  startDate: { // Дата начала действия подписки
    type: Date,
  },
  endDate: { // Дата окончания действия подписки
    type: Date,
    index: true,
  },
  trafficAllocatedGb: { // Выделенный трафик в ГБ
    type: Number,
  },
  referralDaysApplied: { // Количество реферальных дней, примененных к этой подписке
    type: Number,
    default: 0,
  },
  isTrial: {
    type: Boolean,
    default: false,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

paymentSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

// Helper to check if subscription is currently active
paymentSchema.methods.isActive = function() {
  return this.status === 'completed' || this.status === 'active' && this.endDate && this.endDate > new Date();
};

const Payment = mongoose.model('Payment', paymentSchema);

module.exports = Payment;