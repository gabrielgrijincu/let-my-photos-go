#!/usr/bin/env node

process.title = ['lmpg', ...process.argv.slice(2)].join(' ');

import { Command } from 'commander';
import { configCommand } from './commands/config';
import { authCommand } from './commands/auth';
import { enumerateAlbumsCommand } from './commands/enumerate-albums';
import { enumerateCommand } from './commands/enumerate';
import { fleeCommand } from './commands/flee';
import { fleeAlbumsCommand } from './commands/flee-albums';
import { statusCommand } from './commands/status';
import { verifyCommand } from './commands/verify';
import { scrubCommand } from './commands/scrub';
import { setProfile } from './paths';

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
program.addCommand(fleeAlbumsCommand);
program.addCommand(statusCommand);
program.addCommand(verifyCommand);
program.addCommand(scrubCommand);

program.parse(process.argv);
