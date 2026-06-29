'use strict';

/** Minimal leveled logger (timestamped, single-line). */
function ts() {
  return new Date().toISOString();
}
function fmt(level, args) {
  return `${ts()} [${level}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
}

module.exports = {
  info: (...a) => console.log(fmt('info', a)),
  warn: (...a) => console.warn(fmt('warn', a)),
  error: (...a) => console.error(fmt('error', a)),
  debug: (...a) => {
    if (process.env.MAILER_DEBUG) console.log(fmt('debug', a));
  },
};
