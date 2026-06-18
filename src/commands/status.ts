import { Command } from 'commander';
import * as clack from '@clack/prompts';
import * as fs from 'fs';
import { getStats } from '../db.js';
import { getAuthPath } from '../paths.js';

export const statusCommand = new Command('status')
  .description('Show download progress')
  .action(() => {
    clack.intro('🕊️  Let My Photos Go — Status');

    const authExists = fs.existsSync(getAuthPath());
    if (!authExists) {
      clack.log.warn('No auth.json — not logged in. Run `lmpg auth` first.');
    } else {
      clack.log.success('auth.json present (logged in).');
    }

    let stats: ReturnType<typeof getStats>;
    try {
      stats = getStats();
    } catch {
      clack.log.info('No database found yet. Run `lmpg flee` to start downloading.');
      clack.outro('');
      return;
    }

    if (stats.total === 0) {
      clack.log.info('No photos tracked yet. Run `lmpg flee` to start downloading.');
      clack.outro('');
      return;
    }

    const pct = stats.total > 0 ? Math.round((stats.downloaded / stats.total) * 100) : 0;

    clack.log.info(`Total:      ${stats.total}`);
    clack.log.success(`Downloaded: ${stats.downloaded} (${pct}%)`);
    if (stats.pending > 0) clack.log.warn(`Pending:    ${stats.pending}`);
    if (stats.failed > 0) clack.log.error(`Failed:     ${stats.failed}`);

    clack.outro(
      stats.downloaded === stats.total
        ? 'All photos liberated! 🎉'
        : `Run \`lmpg flee --resume\` to continue downloading.`
    );
  });
