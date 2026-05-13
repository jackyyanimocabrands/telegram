import { Command } from 'commander';
import { createRequire } from 'module';
import { AppBootstrap } from '../bootstrap/AppBootstrap.js';

const require = createRequire(import.meta.url);
const { version, name, description } = require('../../package.json') as {
  version: string;
  name: string;
  description: string;
};

const program = new Command();

program
  .name(name)
  .description(description)
  .version(version, '-v, --version', 'Output the current version');

program
  .command('start', { isDefault: true })
  .description('Start the Telegram connector service')
  .action(async () => {
    // Print banner in development only
    if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test') {
      try {
        const { default: figlet } = await import('figlet');
        const { default: chalk } = await import('chalk');
        const banner = figlet.textSync('HelloMinds', {
          font: 'Pagga',
          horizontalLayout: 'default',
          verticalLayout: 'default',
          width: 120,
          whitespaceBreak: true,
        });
        process.stdout.write(chalk.cyan(banner) + '\n');
        process.stdout.write(chalk.dim(`  v${version} — Telegram Connector\n\n`));
      } catch {
        // figlet/chalk not installed — silently skip banner
      }
    }

    const app = new AppBootstrap();
    await app.start();
  });

program.showHelpAfterError();
program.showSuggestionAfterError();

program.parse(process.argv);
