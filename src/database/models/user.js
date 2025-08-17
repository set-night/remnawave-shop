const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  telegramId: {
    type: Number,
    required: true,
    unique: true,
    index: true,
  },
  firstName: {
    type: String,
  },
  lastName: {
    type: String,
  },
  username: {
    type: String,
  },
  languageCode: {
    type: String,
    default: 'ru',
  },
  isBot: {
    type: Boolean,
    default: false,
  },
  referralCode: {
    type: String,
    unique: true,
    sparse: true, // Allows multiple nulls, but unique if not null
  },
  referredBy: { // Telegram ID of the user who referred this user
    type: Number,
    index: true,
    sparse: true,
  },
  referralEarnings: {
    type: Number,
    default: 0, // Сумма заработка с рефералов (только для внутреннего использования)
  },
    balance: {
      type: Number,
      default: 0, // Баланс пользователя в долларах
    },
    trialUsed: {
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

// Middleware to update `updatedAt` field before saving
userSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

const User = mongoose.model('User', userSchema);

module.exports = User;