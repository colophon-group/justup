'use strict';
// The integration demo is English-only. Posting-language choices are independent.
window.I18n = { locale: 'en', text: value => String(value), browserLanguage: () => (navigator.languages?.[0] || navigator.language || 'en').split('-')[0] };
