#!/usr/bin/env node

process.title = ['lmpg', ...process.argv.slice(2)].join(' ');

import { Command } from 'commander';
import { configCommand } from './commands/config.js';
import { authCommand } from './commands/auth.js';
import { enumerateAlbumsCommand } from './commands/enumerate-albums.js';
import { enumerateCommand } from './commands/enumerate.js';
import { fleeCommand } from './commands/flee.js';
import { statusCommand } from './commands/status.js';
import { organizeCommand } from './commands/organize.js';
import { verifyCommand } from './commands/verify.js';
import { dedupAlbumsCommand } from './commands/dedup-albums.js';
import { resetAlbumsCommand } from './commands/reset-albums.js';
import { scrubCommand } from './commands/scrub.js';
import { setProfile } from './paths.js';

const program = new Command();

program
  .name('lmpg')
  .description('🕊️ Let My Photos Go — download your Google Photos with full EXIF/GPS metadata')
  .version('0.1.0', '-v, --version')
  .option('-p, --profile <name>', 'use a named profile (separate auth, db, and config)')
  .hook('preAction', () => {
    setProfile(program.opts().profile);
  });

program.addCommand(authCommand);
program.addCommand(configCommand);
program.addCommand(enumerateCommand);
program.addCommand(enumerateAlbumsCommand);
program.addCommand(fleeCommand);
program.addCommand(statusCommand);
program.addCommand(verifyCommand);
program.addCommand(organizeCommand);
program.addCommand(dedupAlbumsCommand);
program.addCommand(resetAlbumsCommand);
program.addCommand(scrubCommand);

program.parse(process.argv);
