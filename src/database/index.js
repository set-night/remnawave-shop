const mongoose = require('mongoose');
const config = require('../config');

const connectDB = async () => {
  try {
    await mongoose.connect(config.mongoURI, {
      // useNewUrlParser: true, // no longer needed
      // useUnifiedTopology: true, // no longer needed
      // useCreateIndex: true, // no longer supported
      // useFindAndModify: false, // no longer supported
      user: config.mongoUser, // Add this if you have user/pass for MongoDB
      pass: config.mongoPassword, // Add this if you have user/pass for MongoDB
      authSource: 'admin' // Add this if your user is in the admin database
    });
    console.log('MongoDB Connected...');
  } catch (err) {
    console.error('MongoDB Connection Error:', err.message);
    // Exit process with failure
    process.exit(1);
  }
};

module.exports = connectDB;