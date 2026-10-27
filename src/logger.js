const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

export function createLogger(level = 'info') {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const stamp = () => new Date().toISOString().slice(11, 19);
  const emit = (name, stream, ...args) => {
    if (threshold >= LEVELS[name]) stream.write(`[${stamp()}] ${name.toUpperCase()} ${args.join(' ')}\n`);
  };
  return {
    error: (...a) => emit('error', process.stderr, ...a),
    warn: (...a) => emit('warn', process.stderr, ...a),
    info: (...a) => emit('info', process.stdout, ...a),
    debug: (...a) => emit('debug', process.stdout, ...a),
  };
}
