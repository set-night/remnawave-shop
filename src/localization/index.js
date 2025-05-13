const ru = require('./ru.json');
const en = require('./en.json');

const languages = {
  ru,
  en,
};

// Fallback to Russian if a key is not found in the selected language
// or if the language itself is not found.
const getLocalizedString = (languageCode, key, params = {}) => {
  const langSource = languages[languageCode] || languages.ru;
  let str = langSource[key] || languages.ru[key] || key; // Fallback to key itself if not found anywhere

  for (const param in params) {
    str = str.replace(new RegExp(`{{${param}}}`, 'g'), params[param]);
  }
  return str;
};

const supportedLanguages = Object.keys(languages);

module.exports = { getLocalizedString, supportedLanguages };