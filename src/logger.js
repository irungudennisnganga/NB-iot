import chalk from 'chalk';

export const log = (...args) => console.log(chalk.blue('[LOG]'), ...args);
export const warn = (...args) => console.warn(chalk.yellow('[WARN]'), ...args);
export const err = (...args) => console.error(chalk.red('[ERR]'), ...args);
