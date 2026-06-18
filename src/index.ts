#!/usr/bin/env node
import { Command } from 'commander';
import { configCommand } from './commands/config.js';
import { authCommand } from './commands/auth.js';
import { enumerateCommand } from './commands/enumerate.js';
import { fleeCommand } from './commands/flee.js';
import { statusCommand } from './commands/status.js';
import { verifyCommand } from './commands/verify.js';
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
program.addCommand(fleeCommand);
program.addCommand(statusCommand);
program.addCommand(verifyCommand);

program.parse(process.argv);
