
/**
 * ⚠️ ValidationPipe গ্লোবালি `whitelist + forbidNonWhitelisted` — তাই এখানে
 * নেই এমন কোনো ফিল্ড পাঠালে ৪০০ যাবে, চুপচাপ উপেক্ষা হবে না। query-র
 * ক্ষেত্রেও একই, অর্থাৎ `?foo=bar` লিখলেও ৪০০।
 */

/**
 * ⭐ টাকা **স্ট্রিং হিসেবে** নেওয়া হয়, সংখ্যা হিসেবে নয়।
 *
 * `13000.10` JSON থেকে number হয়ে এলে সেটা IEEE-754-এ 13000.099999999999
 * হয়ে বসে, তারপর Decimal(12,2)-এ round হয়ে ফিরে আসে — আর কেউ কোনোদিন
 * বুঝত না কেন এক পয়সা এদিক-ওদিক। স্ট্রিং সরাসরি Prisma-র Decimal-এ যায়,
 * মাঝপথে কোনো float নেই।
 */
export const TAKA = /^\d{1,10}(\.\d{1,2})?$/;
export const TAKA_MSG =
  'Salary must be given as a string in the form "13000" or "13000.50"';
export const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
