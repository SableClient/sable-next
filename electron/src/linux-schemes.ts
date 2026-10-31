import { app } from 'electron';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

function quote(argument: string): string {
  return `"${argument.replace(/["`$\\]/g, '\\$&')}"`;
}

async function attempt(command: string, args: string[]): Promise<string> {
  try {
    return (await run(command, args, { encoding: 'utf8' })).stdout.trim();
  } catch (error) {
    console.warn(`[sable deep links] ${command} failed`, (error as Error).message);
    return '';
  }
}

export function desktopExec(identifier: string): string {
  const exec = process.defaultApp
    ? ['env', `SABLE_IDENTIFIER=${identifier}`, process.execPath, resolve(app.getAppPath())]
    : [process.env.APPIMAGE ?? process.execPath];
  return exec.map(quote).join(' ');
}

export async function claimSchemes(
  applications: string,
  identifier: string,
  schemes: string[]
): Promise<void> {
  const mimeTypes = schemes.map((scheme) => `x-scheme-handler/${scheme}`);
  const entry = [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${app.getName()}`,
    `Exec=${desktopExec(identifier)} %u`,
    'Terminal=false',
    `MimeType=${mimeTypes.join(';')};`,
    'NoDisplay=true',
    '',
  ].join('\n');

  const name = `${identifier}-handler.desktop`;
  const path = join(applications, name);
  if ((await readFile(path, 'utf8').catch(() => '')) !== entry) {
    await mkdir(applications, { recursive: true });
    await writeFile(path, entry);
    await attempt('update-desktop-database', [applications]);
  }
  for (const mimeType of mimeTypes) {
    await attempt('xdg-mime', ['default', name, mimeType]);
  }
}
